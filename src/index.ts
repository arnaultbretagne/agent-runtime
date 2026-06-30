import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Supervisor, BadRequest } from './supervisor.js'

/**
 * Supervisor control API (ADR 0001/0002). The ONLY inbound surface, reachable
 * in-cluster from the website only (ADR 0003 ingress). It is NOT an exec channel:
 * it accepts a closed `kind` + a forwarded argv list (no shell), never a raw command.
 *
 *   POST   /sessions   { kind, id?, args? }  → spawn, returns the session
 *   GET    /sessions                          → list
 *   GET    /sessions/:id                      → status
 *   DELETE /sessions/:id                      → kill / reap
 *   GET    /healthz
 */
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const RUNTIME_CWD = process.env.RUNTIME_CWD ?? process.cwd()

const sup = new Supervisor({ cwd: RUNTIME_CWD })

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (path === '/healthz') return send(res, 200, { ok: true })

    if (path === '/sessions') {
      if (method === 'GET') return send(res, 200, { sessions: sup.list() })
      if (method === 'POST') {
        const body = await readJson(req)
        if (typeof body.kind !== 'string') throw new BadRequest('`kind` (string) is required')
        const id = typeof body.id === 'string' && body.id ? body.id : randomUUID()
        const args = Array.isArray(body.args) ? body.args.map(String) : []
        return send(res, 201, sup.spawn(body.kind, id, args))
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    const match = path.match(/^\/sessions\/([^/]+)$/)
    if (match) {
      const id = decodeURIComponent(match[1])
      if (method === 'GET') {
        const info = sup.get(id)
        return info ? send(res, 200, info) : send(res, 404, { error: 'not found' })
      }
      if (method === 'DELETE') {
        return send(res, sup.kill(id) ? 200 : 404, { id, killed: true })
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    return send(res, 404, { error: 'not found' })
  } catch (err) {
    if (err instanceof BadRequest) return send(res, 400, { error: err.message })
    if (err instanceof SyntaxError) return send(res, 400, { error: 'invalid JSON body' })
    return send(res, 500, { error: (err as Error).message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[supervisor] listening on ${HOST}:${PORT} — runtime cwd: ${RUNTIME_CWD}`)
})

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}
