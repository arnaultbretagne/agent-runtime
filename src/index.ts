import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { Supervisor, BadRequest } from './supervisor.js'
import { KNOWN_KINDS, RUNTIMES, isKnownKind } from './runtimes.js'
import { getCapabilities } from './capabilities.js'

/**
 * Supervisor control API (ADR 0001/0002). The ONLY inbound surface, reachable
 * in-cluster from the website only (ADR 0003 ingress). It is NOT an exec channel:
 * it accepts a closed `kind` + a forwarded argv list (no shell), never a raw command.
 *
 *   POST   /sessions   { kind, id?, args?, env?, idleTtlMs? }  → spawn, returns the session
 *                        (env: CHANNEL_*-prefixed pipe config only; idleTtlMs: opaque reap window)
 *   GET    /sessions                                → list
 *   GET    /sessions/:id                            → status
 *   POST   /sessions/:id/touch                      → heartbeat (reset the idle clock)
 *   DELETE /sessions/:id                            → kill / reap
 *   GET    /kinds                                   → the baked runtime registry
 *   GET    /kinds/:kind/capabilities                → discovered models / efforts / agents
 *   GET    /healthz
 */
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const RUNTIME_CWD = process.env.RUNTIME_CWD ?? process.cwd()
const PTY_LOG_DIR = process.env.PTY_LOG_DIR || undefined

const sup = new Supervisor({ cwd: RUNTIME_CWD, ptyLogDir: PTY_LOG_DIR })

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (path === '/healthz') return send(res, 200, { ok: true })
    if (path === '/kinds' && method === 'GET') return send(res, 200, { kinds: KNOWN_KINDS })

    const capsMatch = path.match(/^\/kinds\/([^/]+)\/capabilities$/)
    if (capsMatch && method === 'GET') {
      const kind = decodeURIComponent(capsMatch[1])
      if (!isKnownKind(kind)) return send(res, 404, { error: `unknown kind: ${kind}` })
      return send(res, 200, await getCapabilities(kind))
    }

    if (path === '/sessions') {
      if (method === 'GET') return send(res, 200, { sessions: sup.list() })
      if (method === 'POST') {
        const body = await readJson(req)
        if (typeof body.kind !== 'string') throw new BadRequest('`kind` (string) is required')
        const id = typeof body.id === 'string' && body.id ? body.id : randomUUID()
        const args = Array.isArray(body.args) ? body.args.map(String) : []
        const env = envParam(body.env)
        // Opaque idle window (ADR 0008): reap the session after this much inactivity. The
        // supervisor does not interpret it (the hub knows it is the harness cache TTL).
        const idleTtlMs =
          typeof body.idleTtlMs === 'number' && body.idleTtlMs > 0 ? body.idleTtlMs : undefined
        return send(res, 201, sup.spawn(body.kind, id, args, env, idleTtlMs))
      }
      return send(res, 405, { error: 'method not allowed' })
    }

    const touchMatch = path.match(/^\/sessions\/([^/]+)\/touch$/)
    if (touchMatch) {
      if (method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const id = decodeURIComponent(touchMatch[1])
      const ok = sup.touch(id)
      return send(res, ok ? 200 : 404, { id, touched: ok })
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

/**
 * Clean-slate invariant (ADR 0009): a freshly started supervisor owns NOTHING it did
 * not spawn. Any runtime-shaped process alive in our PID namespace is an orphan from a
 * previous incarnation (e.g. a crash that skipped kill-on-shutdown) → SIGKILL it. Runs
 * BEFORE listen(), so no legitimate session can exist yet. Matches by the runtimes'
 * OWN commands (baked registry) — never by `--channels` or any product marker (ADR 0002).
 */
function bootSweepStrays(): void {
  const commands = new Set(KNOWN_KINDS.map((k) => RUNTIMES[k].command))
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p))
  } catch {
    return // not Linux / no /proc — nothing to sweep
  }
  let killed = 0
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    let argv0: string
    try {
      argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]
    } catch {
      continue // process vanished or unreadable
    }
    if (!argv0) continue
    const base = argv0.split('/').pop() ?? argv0
    if (!commands.has(base)) continue
    try {
      process.kill(Number(pid), 'SIGKILL')
      killed++
    } catch {
      /* already gone */
    }
  }
  if (killed) console.log(`[supervisor] boot-sweep: killed ${killed} orphan runtime process(es)`)
}

// Kill-on-shutdown (ADR 0009): SIGTERM every child, give a short grace, SIGKILL the
// stragglers, then exit — so `run.sh stop` / pod termination leaves no orphans.
let shuttingDown = false
function shutdown(sig: string): void {
  if (shuttingDown) return
  shuttingDown = true
  const pids = sup.killAll()
  console.log(`[supervisor] ${sig} → terminated ${pids.length} session(s), exiting`)
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already dead */
      }
    }
    process.exit(0)
  }, 2000).unref?.()
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig))

bootSweepStrays()

server.listen(PORT, HOST, () => {
  console.log(`[supervisor] listening on ${HOST}:${PORT} — runtime cwd: ${RUNTIME_CWD}`)
  // warm the capability cache so the first UI request is fast (best-effort)
  for (const k of KNOWN_KINDS) {
    getCapabilities(k)
      .then((c) => console.log(`[caps] ${k}: ${c.models.length} models, ${c.agents.length} agents`))
      .catch((e) => console.log(`[caps] warm ${k} failed: ${e.message}`))
  }
})

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function envParam(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('`env` must be an object')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) env[k] = String(v)
  return env
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}
