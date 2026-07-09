/**
 * The inference-auth proxy (agent-runtime — loge token dispossession, 2026-07-09).
 *
 * A loge must NEVER hold the real Claude Max token: an untrusted workload with the token + egress can
 * exfiltrate it (CVE-2025-59536 — a poisoned repo file suffices; a stolen token stays valid
 * server-side for days). So the loge runs with a PLACEHOLDER `CLAUDE_CODE_OAUTH_TOKEN` and
 * `ANTHROPIC_BASE_URL` pointed at this proxy — a separate pod, the only holder of the real token,
 * which swaps the Bearer and forwards to Anthropic. The loge uses inference but never sees the token.
 *
 * Proven end-to-end 2026-07-09: a placeholder-login loge emits `anthropic-beta: …,oauth-2025-04-20,…`
 * (the subscription capability the upstream REQUIRES) and a body whose `metadata.user_id` carries an
 * EMPTY `account_uuid`. Two things make the upstream accept the swapped token — a naive header swap
 * fixes NEITHER:
 *   1. `Authorization: Bearer <real oat>` (and drop any client `x-api-key`);
 *   2. the empty `account_uuid` filled with the token's real account (else 401).
 * `anthropic-beta`/`anthropic-version` and the rest of the body are forwarded VERBATIM (the first
 * system block is an attribution the upstream strips positionally — reshaping the body breaks it).
 * SSE is streamed unbuffered.
 *
 * The Max token from `claude setup-token` is ~1-year and static (agent-runtime ADR 0007) → this proxy
 * holds it as-is: no refresh, no lifecycle.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
} from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface ProxyConfig {
  /** The REAL subscription token — the one thing the loge must not hold. */
  token: string
  /** Account UUID to fill into the body's empty slot; '' → resolved once at boot via the profile. */
  accountUuid: string
  /** Where the real Anthropic API lives (http:// for tests, https://api.anthropic.com in prod). */
  upstreamOrigin: string
  port: number
}

export function configFromEnv(env: NodeJS.ProcessEnv): ProxyConfig {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN
  if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required (the real token this proxy injects)')
  return {
    token,
    accountUuid: env.ANTHROPIC_ACCOUNT_UUID ?? '',
    upstreamOrigin: env.UPSTREAM_ORIGIN ?? 'https://api.anthropic.com',
    port: Number(env.PORT ?? 8788),
  }
}

/** The empty account_uuid slot claude emits under placeholder-login, as it appears in the raw JSON
 *  body: `metadata.user_id` is a *stringified* JSON, so its quotes arrive backslash-escaped. */
const EMPTY_ACCOUNT_UUID = '\\"account_uuid\\":\\"\\"'

/** Fill the empty account_uuid with the real one — a targeted splice on the raw body so nothing else
 *  is reshaped. Returns the body unchanged if the slot is absent (non-/v1/messages) or no uuid known. */
export function injectAccountUuid(body: string, accountUuid: string): string {
  if (!accountUuid || !body.includes(EMPTY_ACCOUNT_UUID)) return body
  return body.replace(EMPTY_ACCOUNT_UUID, `\\"account_uuid\\":\\"${accountUuid}\\"`)
}

function requesterFor(origin: string): typeof httpRequest {
  return origin.startsWith('https:') ? (httpsRequest as typeof httpRequest) : httpRequest
}

/** Resolve the token's account UUID once (a constant for the account). Best-effort: '' if the profile
 *  endpoint is unavailable for this token — the operator then pins it via ANTHROPIC_ACCOUNT_UUID. */
export function resolveAccountUuid(config: ProxyConfig): Promise<string> {
  if (config.accountUuid) return Promise.resolve(config.accountUuid)
  return new Promise((resolve) => {
    const url = new URL('/api/oauth/profile', config.upstreamOrigin)
    const req = requesterFor(config.upstreamOrigin)(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${config.token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
        },
      },
      (res) => {
        let b = ''
        res.on('data', (d) => (b += d))
        res.on('end', () => {
          try {
            resolve(((JSON.parse(b) as { account?: { uuid?: string } }).account?.uuid) ?? '')
          } catch {
            resolve('')
          }
        })
      },
    )
    req.on('error', () => resolve(''))
    req.end()
  })
}

/** The proxy: swap the Bearer to the real token, fill the empty account_uuid, forward to Anthropic,
 *  stream the (SSE) response back unbuffered. Stateless per request; the token/uuid are read-only, so
 *  N concurrent loges through one proxy never interfere. */
export function createInferenceProxyServer(config: ProxyConfig, accountUuid: string) {
  const upstream = new URL(config.upstreamOrigin)
  const requester = requesterFor(config.upstreamOrigin)
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const buf = Buffer.from(injectAccountUuid(Buffer.concat(chunks).toString('utf8'), accountUuid), 'utf8')
      const headers = { ...req.headers } as OutgoingHttpHeaders
      delete headers.host
      delete headers['content-length']
      delete headers['x-api-key']
      headers.authorization = `Bearer ${config.token}`
      if (hasBody) headers['content-length'] = String(buf.length)
      const up = requester(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          path: req.url,
          method: req.method,
          headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers as OutgoingHttpHeaders)
          upRes.pipe(res)
        },
      )
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream_unreachable', detail: (e as Error).message }))
      })
      if (hasBody) up.write(buf)
      up.end()
    })
  })
}

// Entry point (dist/inference-proxy.js) — guarded so importing for tests never binds a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv(process.env)
  const accountUuid = await resolveAccountUuid(config)
  if (!accountUuid) {
    console.error(
      '[inference-proxy] WARNING: no account_uuid (profile fetch failed, ANTHROPIC_ACCOUNT_UUID unset) — /v1/messages may 401',
    )
  }
  createInferenceProxyServer(config, accountUuid).listen(config.port, '0.0.0.0', () => {
    console.log(
      `[inference-proxy] listening on 0.0.0.0:${config.port} → ${config.upstreamOrigin} ` +
        `(account ${accountUuid ? accountUuid.slice(0, 8) + '…' : 'UNKNOWN'})`,
    )
  })
}
