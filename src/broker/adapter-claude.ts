/**
 * Claude adapter (dist/broker/adapter-claude.js) — holds the real Claude token ONLY.
 *
 * P3: migrates the inference-proxy's proven logic here. The front has already validated the lease
 * (claude:invoke) and STRIPPED it, forwarding the request with `x-broker-*` claim headers and no
 * Bearer. This adapter sets `Authorization: Bearer <real token>`, fills the empty account_uuid, and
 * streams the (SSE) response back — identical to the inference-proxy, plus: it requires a broker
 * claim header (defence in depth — only the front reaches it), drops the `x-broker-*` headers so
 * they never leak to Anthropic, and drops any client `x-api-key`.
 *
 * The real token is a ~1-year static setup-token (ADR 0007) → no refresh, no lifecycle (custody now
 * in this trusted-namespace adapter instead of the agent-runs inference-proxy). Dedup with the
 * inference-proxy happens when it is retired (P7).
 */
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { startAdapter, type AdapterHandler } from './adapter-common.js'
import { configFromEnv, resolveAccountUuid, injectAccountUuid } from '../inference-proxy.js'

export interface ClaudeForwarderOpts {
  token: string
  accountUuid: string
  upstreamOrigin: string
}

/** The forwarder (exported for tests). Swap in the real token, fill account_uuid, strip internal
 *  headers, forward to Anthropic, stream unbuffered. Stateless per request; token/uuid are read-only. */
export function createClaudeForwarder(opts: ClaudeForwarderOpts): AdapterHandler {
  const upstream = new URL(opts.upstreamOrigin)
  const requester = opts.upstreamOrigin.startsWith('https:') ? (httpsRequest as typeof httpRequest) : httpRequest
  return (req, res, claims) => {
    if (!claims.leaseId) {
      // Only the front reaches this adapter (CNP); a request with no broker claim is not one it sent.
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"error":"no_broker_claim"}')
    }
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const buf = Buffer.from(injectAccountUuid(Buffer.concat(chunks).toString('utf8'), opts.accountUuid), 'utf8')
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const headers = { ...req.headers } as OutgoingHttpHeaders
      delete headers.host
      delete headers['content-length']
      delete headers['x-api-key']
      for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith('x-broker-')) delete headers[k]
      headers.authorization = `Bearer ${opts.token}`
      if (hasBody) headers['content-length'] = String(buf.length)
      const up = requester(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, path: req.url, method: req.method, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers as OutgoingHttpHeaders)
          upRes.pipe(res)
        },
      )
      up.on('error', () => {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end('{"error":"provider_unavailable"}')
      })
      if (hasBody) up.write(buf)
      up.end()
    })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Deployed dark (before the secret is wired) — serve 503 rather than crash-loop, so no consumer
    // is affected and the front's forward gets an honest error.
    console.warn('[broker-claude] no CLAUDE_CODE_OAUTH_TOKEN — unconfigured (503)')
    startAdapter('claude', (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":"adapter_unconfigured"}')
    })
  } else {
    const config = configFromEnv(process.env)
    const accountUuid = await resolveAccountUuid(config)
    if (!accountUuid) console.error('[broker-claude] WARNING: no account_uuid — /v1/messages may 401')
    startAdapter('claude', createClaudeForwarder({ token: config.token, accountUuid, upstreamOrigin: config.upstreamOrigin }))
  }
}
