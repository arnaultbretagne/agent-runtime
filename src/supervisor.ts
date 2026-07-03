import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { RUNTIMES, KNOWN_KINDS, isKnownKind } from './runtimes.js'

/** Thrown for caller errors → mapped to HTTP 400. */
export class BadRequest extends Error {}

/**
 * How long a *crashed* session lingers in the registry as `exited` before it is
 * GC'd (ADR 0009). It must comfortably exceed the hub's reconcile interval (~2–5 s)
 * so the hub reads the `exitCode` (→ `error`) before the record vanishes. Voluntary
 * kills do not use this — `kill()` forgets them immediately (→ 404 → `dormant`).
 */
const EXITED_TTL_MS = 60_000

/** How often the supervisor scans for idle sessions to reap (ADR 0008). */
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000)

export interface SessionInfo {
  id: string
  kind: string
  pid: number
  status: 'running' | 'exited'
  startedAt: string
  exitCode?: number
}

interface LiveSession extends SessionInfo {
  proc: pty.IPty
  /** Last activity heartbeat (ms). Initialised at spawn; bumped by touch() (ADR 0008). */
  lastTouch: number
  /** Idle window (ms) past which this session is reaped; undefined = never idle-reaped. */
  idleTtlMs?: number
}

export interface SpawnDefaults {
  /** PTY working directory (where the project `.mcp.json` / channel lives). */
  cwd: string
  cols?: number
  rows?: number
  /** If set, each session's PTY output is appended to `<dir>/<id>.pty.log` (debug aid). */
  ptyLogDir?: string
}

/**
 * The thin supervisor (ADR 0001): a process manager, nothing more. It spawns a
 * runtime of a closed `kind` under a PTY (ADR 0004 — runtimes are TUIs), forwards
 * the caller's argv unchanged, and tracks lifecycle. It carries NO product logic:
 * no conversation, no routing, no history — those live in the product (agora).
 */
export class Supervisor {
  private readonly sessions = new Map<string, LiveSession>()

  constructor(private readonly defaults: SpawnDefaults) {
    // The supervisor owns idle-reaping (ADR 0008): a single sweep over all sessions.
    setInterval(() => this.reapIdle(), SWEEP_INTERVAL_MS).unref()
  }

  /**
   * Spawn a runtime of `kind` under a PTY, forwarding `args` as argv and `env`
   * as extra environment. Env keys are restricted to the `CHANNEL_` prefix —
   * that is the structured "pipe config" params of ADR 0002 (hub URL,
   * conversation id, token), and the prefix closes the env-injection vector
   * (PATH, LD_*, NODE_OPTIONS…) the same way `kind` closes arbitrary exec.
   */
  spawn(
    kind: string,
    id: string,
    args: string[],
    env: Record<string, string> = {},
    idleTtlMs?: number,
  ): SessionInfo {
    if (!isKnownKind(kind)) {
      throw new BadRequest(`unknown kind: ${kind} (known: ${KNOWN_KINDS.join(', ')})`)
    }
    if (this.sessions.has(id)) {
      throw new BadRequest(`session already exists: ${id}`)
    }
    for (const key of Object.keys(env)) {
      if (!/^CHANNEL_[A-Z0-9_]+$/.test(key)) {
        throw new BadRequest(`env key not allowed: ${key} (only CHANNEL_* is forwarded)`)
      }
    }
    const spec = RUNTIMES[kind]
    const proc = pty.spawn(spec.command, [...spec.baseArgs, ...args], {
      name: 'xterm-256color',
      cols: this.defaults.cols ?? 200,
      rows: this.defaults.rows ?? 50,
      cwd: this.defaults.cwd,
      env: { ...(process.env as Record<string, string>), ...env },
    })

    const session: LiveSession = {
      id,
      kind,
      pid: proc.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      proc,
      lastTouch: Date.now(), // spawn = t0; a runtime is only ever spawned to process a pending message
      idleTtlMs,
    }

    // The conversation flows through the channel, NOT the PTY (ADR 0004). We drain
    // the PTY so its buffer never backs up, but we do not interpret the output.
    // With ptyLogDir set, the drain also tees to a per-session file (debug aid).
    if (this.defaults.ptyLogDir) {
      const logPath = join(this.defaults.ptyLogDir, `${id}.pty.log`)
      proc.onData((data) => {
        try {
          appendFileSync(logPath, data)
        } catch {
          /* logging must never break the session */
        }
      })
    } else {
      proc.onData(() => {})
    }
    proc.onExit(({ exitCode }) => {
      // An exit we did NOT ask for = a crash. Keep the record (with its exitCode) so the
      // hub's reconcile reads it as `error`, then GC it (ADR 0009). A *voluntary* kill has
      // already removed the session in kill(), so this only ever fires for a real crash.
      session.status = 'exited'
      session.exitCode = exitCode
      setTimeout(() => {
        if (this.sessions.get(id) === session) this.sessions.delete(id)
      }, EXITED_TTL_MS).unref?.()
    })

    this.sessions.set(id, session)
    return strip(session)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(strip)
  }

  get(id: string): SessionInfo | undefined {
    const s = this.sessions.get(id)
    return s ? strip(s) : undefined
  }

  /** Kill and forget a session. Returns false if the id is unknown. */
  kill(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    try {
      s.proc.kill()
    } catch {
      /* already dead */
    }
    this.sessions.delete(id)
    return true
  }

  /**
   * Heartbeat: mark a session active *now* (ADR 0008). The caller (hub) touches on each
   * completed turn; the supervisor attaches no meaning to it beyond "still active".
   * Returns false if the id is unknown.
   */
  touch(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.lastTouch = Date.now()
    return true
  }

  /**
   * Reap sessions idle past their `idleTtlMs` (ADR 0008): once the harness cache lapses,
   * keeping the runtime alive is wasteful (its next turn is a cold reprocess either way).
   * A reap goes through kill() → the entry is forgotten → the hub reads 404 → `dormant`.
   * Sessions without an `idleTtlMs` are never idle-reaped.
   */
  reapIdle(): void {
    const now = Date.now()
    for (const [id, s] of [...this.sessions]) {
      if (s.status !== 'running' || s.idleTtlMs === undefined) continue
      const idle = now - s.lastTouch
      if (idle < s.idleTtlMs) continue
      console.log(`[supervisor] reaping idle session ${id}: ${Math.round(idle / 1000)}s ≥ ${Math.round(s.idleTtlMs / 1000)}s TTL`)
      this.kill(id)
    }
  }

  /**
   * SIGTERM every tracked session and forget them — used by the shutdown handler
   * (ADR 0009: a stopping supervisor must not leak its children as orphans). Returns
   * the signalled pids so the caller can SIGKILL any straggler after a grace period.
   */
  killAll(): number[] {
    const pids: number[] = []
    for (const id of [...this.sessions.keys()]) {
      const s = this.sessions.get(id)
      if (s) pids.push(s.pid)
      this.kill(id)
    }
    return pids
  }
}

function strip(s: LiveSession): SessionInfo {
  const { proc: _proc, lastTouch: _lastTouch, idleTtlMs: _idleTtlMs, ...info } = s
  return info
}
