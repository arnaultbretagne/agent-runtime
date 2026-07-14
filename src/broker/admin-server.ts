/**
 * Admin plane (:8789) — mint/revoke/health. No application auth here on purpose: the plane is
 * reachable ONLY from the runtime-manager's ServiceAccount via CiliumNetworkPolicy (plan §2.4).
 * The browser can never reach it; a loge can never reach it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { LeaseStore } from './lease-store.js'
import type { Auditor } from './audit.js'

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  const parsed = raw ? (JSON.parse(raw) as unknown) : {}
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function createAdminServer(store: LeaseStore, audit: Auditor) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'
    try {
      if (path === '/healthz') return sendJson(res, 200, { ok: true })
      // readyz proves the store is open + loaded; it must NOT call providers or expose secret state.
      if (path === '/readyz') return sendJson(res, 200, { ok: true, leases: store.size() })

      if (path === '/v1/leases' && method === 'POST') {
        const body = await readJson(req)
        const runId = str(body.runId)
        const profile = str(body.profile)
        const target = str(body.target) ?? null
        const r = store.mint({ runId: runId ?? '', profile: profile ?? '', target })
        if (!r.ok) {
          audit('lease.denied', { runId, profile, target, result: r.error })
          return sendJson(res, 400, { error: r.error, detail: r.detail })
        }
        audit('lease.minted', {
          runId: r.claims.runId,
          leaseId: r.leaseId,
          profile: r.claims.profile,
          target: r.claims.target,
        })
        return sendJson(res, 201, {
          leaseId: r.leaseId,
          token: r.token,
          expiresAt: new Date(r.expiresAt).toISOString(),
        })
      }

      const m = /^\/v1\/leases\/([^/]+)$/.exec(path)
      if (m && method === 'DELETE') {
        const leaseId = decodeURIComponent(m[1])
        const revoked = store.revoke(leaseId)
        audit('lease.revoked', { leaseId, result: revoked ? 'ok' : 'absent' })
        return sendJson(res, 200, { revoked, leaseId })
      }

      return sendJson(res, 404, { error: 'not_found' })
    } catch (e) {
      if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid_json' })
      return sendJson(res, 500, { error: 'internal' })
    }
  })
}
