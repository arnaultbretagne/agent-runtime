/**
 * Data plane (:8788) — loge-facing. The loge points ANTHROPIC_BASE_URL here (Claude) and reaches
 * `/v1/vault/*` and `/v1/github/*` here too, always with `Authorization: Bearer <lease>`. Every
 * request revalidates the lease + the route's capability (+ target for repo routes), then forwards
 * to the isolated adapter that holds the real secret. The lease is STRIPPED before forwarding; only
 * the validated claims travel on, as internal `x-broker-*` headers (plan §2.5, ADR 0011 §1/§3).
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import type { LeaseStore, LeaseClaims } from './lease-store.js'
import type { Auditor } from './audit.js'
import type { FrontConfig } from './config.js'
import { authorize } from './auth.js'

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

interface Route {
  adapter: 'claude' | 'vault' | 'github'
  url: string
  capability: string
}

function routeFor(path: string, cfg: FrontConfig): Route {
  if (path.startsWith('/v1/vault/')) return { adapter: 'vault', url: cfg.adapters.vault, capability: 'vault:full' }
  // This route carried `needsTarget: true` until 2026-07-15 and silently 403'd EVERY GitHub token
  // request from the moment P6 dropped `target` from the profiles: no lease can carry a target any
  // more, and the check refused a lease without one. It shipped because nothing tested this route —
  // servers.test.ts configured a github adapter and never called it. The per-run target mechanism is
  // gone from the authorization path with it; `claims.target` survives only as a run FACT.
  if (path.startsWith('/v1/github/')) return { adapter: 'github', url: cfg.adapters.github, capability: 'github:metadata:read' }
  // default: the Anthropic-compatible surface Claude Code uses (/v1/messages, …).
  return { adapter: 'claude', url: cfg.adapters.claude, capability: 'claude:invoke' }
}

/** Forward the request to the adapter: strip the lease, attach the claims as internal headers,
 *  stream the response back unbuffered. The adapter is only reachable from the front (CNP). */
function forward(route: Route, claims: LeaseClaims, req: IncomingMessage, res: ServerResponse, audit: Auditor): void {
  const target = new URL(route.url)
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    const buf = Buffer.concat(chunks)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const headers = { ...req.headers } as OutgoingHttpHeaders
    delete headers.host
    delete headers['content-length']
    delete headers.authorization // the lease never reaches a provider
    headers['x-broker-lease-id'] = claims.leaseId
    headers['x-broker-run-id'] = claims.runId
    headers['x-broker-profile'] = claims.profile
    if (claims.target) headers['x-broker-target'] = claims.target
    if (hasBody) headers['content-length'] = String(buf.length)
    const up = httpRequest(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: req.url, method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers as OutgoingHttpHeaders)
        upRes.pipe(res)
      },
    )
    up.on('error', () => {
      audit('provider.error', { adapter: route.adapter, leaseId: claims.leaseId, errorClass: 'adapter_unreachable' })
      sendJson(res, 502, { error: 'provider_unavailable' })
    })
    if (hasBody) up.write(buf)
    up.end()
  })
}

export function createDataServer(store: LeaseStore, cfg: FrontConfig, audit: Auditor) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/healthz') return sendJson(res, 200, { ok: true })

    const route = routeFor(path, cfg)
    const auth = authorize(store, req.headers.authorization, route.capability)
    if (!auth.ok) {
      audit('lease.denied', { adapter: route.adapter, result: auth.error })
      return sendJson(res, auth.status, { error: auth.error })
    }
    audit('lease.used', { leaseId: auth.claims.leaseId, runId: auth.claims.runId, profile: auth.claims.profile, target: auth.claims.target, adapter: route.adapter })
    forward(route, auth.claims, req, res, audit)
  })
}
