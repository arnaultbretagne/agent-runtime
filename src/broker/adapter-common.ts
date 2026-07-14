/**
 * Shared adapter skeleton. Each provider adapter is its own Deployment (its own Secret, its own
 * CNP egress) but shares this: read the validated claims the front passes as internal `x-broker-*`
 * headers, serve /healthz, and hand the request to the provider-specific handler. Adapters are only
 * reachable from the front (plan §2.3/§2.5); they trust the `x-broker-*` headers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface AdapterClaims {
  leaseId: string
  runId: string
  profile: string
  target: string | null
}

export function claimsFromHeaders(req: IncomingMessage): AdapterClaims {
  const h = (k: string): string => {
    const v = req.headers[k]
    return typeof v === 'string' ? v : ''
  }
  return {
    leaseId: h('x-broker-lease-id'),
    runId: h('x-broker-run-id'),
    profile: h('x-broker-profile'),
    target: h('x-broker-target') || null,
  }
}

export type AdapterHandler = (req: IncomingMessage, res: ServerResponse, claims: AdapterClaims) => void

export function createAdapterServer(handle: AdapterHandler) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    handle(req, res, claimsFromHeaders(req))
  })
}

export function startAdapter(name: 'claude' | 'vault' | 'github', handle: AdapterHandler) {
  const port = Number(process.env.ADAPTER_PORT ?? 8790)
  createAdapterServer(handle).listen(port, '0.0.0.0', () => console.log(`[broker-${name}] adapter on :${port}`))
}

/** P2 stub: the chain (loge -> front -> adapter) is wired, but the provider call is not built yet.
 *  Returns 501 with a stable shape; the real logic lands in the adapter's palier. */
export function notImplemented(name: 'claude' | 'vault' | 'github', palier: string): AdapterHandler {
  return (_req, res, claims) => {
    res.writeHead(501, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_implemented', adapter: name, palier, leaseId: claims.leaseId }))
  }
}
