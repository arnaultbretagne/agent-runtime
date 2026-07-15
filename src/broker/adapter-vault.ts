/**
 * Vault adapter (dist/broker/adapter-vault.js) — holds the Pocket-ID broker client secret ONLY.
 *
 * P5.3. The front has already validated the lease and its `vault:full` capability, stripped the
 * lease, and forwarded the claims as `x-broker-*`. This adapter mints (and caches) the broker's own
 * Pocket-ID machine bearer and injects it server-side. The loge never holds a vault credential: it
 * points Claude Code's MCP config at `${AGENT_BROKER_URL}/v1/vault/mcp` with its opaque lease, and
 * the bearer exists only in this process's memory.
 *
 * Why a gateway rather than a `headersHelper` in the loge: the helper would run INSIDE the loge, so
 * whatever it can fetch, a compromised loge can fetch too (vault-mcp-machine-token-findings.md §6).
 *
 * Deliberately tighter than the claude adapter: exactly one accepted path, an allow-list of headers
 * instead of everything the loge sent, and a bounded request body. The vault MCP is a read/write
 * surface over personal notes reached by an untrusted caller — the narrow shape is the point.
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ClientRequest, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { startAdapter, type AdapterHandler, type AdapterClaims } from './adapter-common.js'
import { getProfile } from './profiles.js'
import { PocketIdTokenProvider, readClientSecret, TokenError } from './pocket-id-token.js'

/** The one route this adapter serves (plan §P5.4). Anything else is not the MCP protocol. */
const VAULT_PATH = '/v1/vault/mcp'

/**
 * Headers forwarded upstream, by allow-list. Everything else the loge sent is dropped: the loge is
 * untrusted, so it must not be able to reach the vault MCP's non-MCP behaviour — or a future
 * middleware's — through a header nobody considered.
 *
 * `mcp-session-id` and `last-event-id` are what make Streamable HTTP work: the session handle and the
 * SSE resumption cursor. Dropping either would silently break the protocol, not secure it.
 */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']

/** Response headers passed back to the loge. `mcp-session-id` must survive or the client loses its
 *  session; the rest of the MCP contract rides in the body. */
const FORWARD_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control']

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export interface VaultForwarderOpts {
  tokens: PocketIdTokenProvider
  /** Full URL of the vault MCP endpoint, e.g. http://obsidian-mcp.obsidian.svc.cluster.local:4000/mcp */
  upstreamUrl: string
  maxRequestBytes?: number
  maxResponseBytes?: number
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function pick(headers: NodeJS.Dict<string | string[]>, allowed: readonly string[]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const name of allowed) {
    const v = headers[name]
    if (v !== undefined) out[name] = v as string | string[]
  }
  return out
}

/** Defence in depth: the front already gates `/v1/vault/*` on `vault:full`, but this process holds a
 *  credential to personal notes — it re-derives the capability from the profile itself rather than
 *  trusting that the route it was reached through is the one it thinks it was. */
function mayUseVault(claims: AdapterClaims): boolean {
  return getProfile(claims.profile)?.capabilities.includes('vault:full') ?? false
}

export function createVaultForwarder(opts: VaultForwarderOpts): AdapterHandler {
  const upstream = new URL(opts.upstreamUrl)
  const requester = upstream.protocol === 'https:' ? (httpsRequest as typeof httpRequest) : httpRequest
  const maxRequest = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  const maxResponse = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

  return (req, res, claims) => {
    if (!claims.leaseId) {
      // Only the front reaches this adapter (CNP); a request with no broker claim is not one it sent.
      return sendJson(res, 401, { error: 'no_broker_claim' })
    }
    if (!mayUseVault(claims)) return sendJson(res, 403, { error: 'capability_denied' })

    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== VAULT_PATH) return sendJson(res, 404, { error: 'not_found' })

    // Buffer the request: the body has to be replayable for the one 401 retry below, and the bound is
    // what stands between a compromised loge and this process's memory.
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxRequest) {
        aborted = true
        sendJson(res, 413, { error: 'request_too_large' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!aborted) void forward(Buffer.concat(chunks), false)
    })

    async function forward(body: Buffer, isRetry: boolean): Promise<void> {
      let token: string
      try {
        token = await opts.tokens.get()
      } catch (err) {
        // TokenError is shape-only by construction — the IdP's own payload never reaches a loge.
        console.error(`[broker-vault] token mint failed: ${(err as TokenError).message}`)
        return sendJson(res, 502, { error: 'credential_unavailable' })
      }

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const headers = pick(req.headers, FORWARD_REQUEST_HEADERS)
      headers.authorization = `Bearer ${token}`
      if (hasBody) headers['content-length'] = String(body.length)

      const up: ClientRequest = requester(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          path: upstream.pathname,
          method: req.method,
          headers,
        },
        (upRes: IncomingMessage) => {
          // The one retry (plan §P5.3): a 401 means the bearer died in a way its TTL could not
          // predict — revoked at the IdP, or the client secret rotated under us. Drop the cache and
          // re-mint ONCE; more would hammer the IdP on what is probably a misconfiguration.
          if (upRes.statusCode === 401 && !isRetry) {
            upRes.resume() // drain: we are discarding this response
            opts.tokens.invalidate()
            console.warn('[broker-vault] vault returned 401 — re-minting once')
            void forward(body, true)
            return
          }
          res.writeHead(upRes.statusCode ?? 502, pick(upRes.headers, FORWARD_RESPONSE_HEADERS))

          // Streaming is preserved: pipe, never buffer. The byte cap is a runaway guard on a
          // request/response exchange, so it deliberately does NOT apply to an SSE stream — MCP's
          // server->client stream is long-lived by design, and capping it would break the protocol
          // rather than secure it.
          const isStream = String(upRes.headers['content-type'] ?? '').includes('text/event-stream')
          if (isStream) {
            upRes.pipe(res)
            return
          }
          let sent = 0
          upRes.on('data', (c: Buffer) => {
            sent += c.length
            if (sent > maxResponse) {
              console.error('[broker-vault] response exceeded the cap — cutting it off')
              upRes.destroy()
              res.destroy()
              return
            }
            res.write(c)
          })
          upRes.on('end', () => res.end())
          upRes.on('error', () => res.destroy())
        },
      )
      up.on('error', (err) => {
        console.error(`[broker-vault] upstream error: ${err.name}`)
        if (!res.headersSent) sendJson(res, 502, { error: 'provider_unavailable' })
      })
      if (hasBody) up.write(body)
      up.end()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = readClientSecret()
  const clientId = process.env.POCKET_ID_CLIENT_ID
  const tokenEndpoint = process.env.POCKET_ID_TOKEN_ENDPOINT
  const resource = process.env.VAULT_RESOURCE
  const upstreamUrl = process.env.VAULT_MCP_URL

  if (!secret || !clientId || !tokenEndpoint || !resource || !upstreamUrl) {
    // Deployed dark, before the IAM checkpoint creates the machine client: serve an honest 503 rather
    // than crash-loop — exactly what the claude adapter did between P2 and P3. Names only; a missing-
    // config log must never hint at a value.
    const missing = [
      !clientId && 'POCKET_ID_CLIENT_ID',
      !secret && 'POCKET_ID_CLIENT_SECRET_FILE|POCKET_ID_CLIENT_SECRET',
      !tokenEndpoint && 'POCKET_ID_TOKEN_ENDPOINT',
      !resource && 'VAULT_RESOURCE',
      !upstreamUrl && 'VAULT_MCP_URL',
    ].filter(Boolean)
    console.warn(`[broker-vault] unconfigured (503) — missing: ${missing.join(', ')}`)
    startAdapter('vault', (_req, res) => sendJson(res, 503, { error: 'adapter_unconfigured' }))
  } else {
    const tokens = new PocketIdTokenProvider({ tokenEndpoint, clientId, clientSecret: secret, resource })
    console.log(`[broker-vault] configured: resource=${resource} upstream=${upstreamUrl}`)
    startAdapter('vault', createVaultForwarder({ tokens, upstreamUrl }))
  }
}
