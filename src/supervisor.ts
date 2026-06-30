import * as pty from 'node-pty'
import { RUNTIMES, KNOWN_KINDS, isKnownKind } from './runtimes.js'

/** Thrown for caller errors → mapped to HTTP 400. */
export class BadRequest extends Error {}

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
}

export interface SpawnDefaults {
  /** PTY working directory (where the project `.mcp.json` / channel lives). */
  cwd: string
  cols?: number
  rows?: number
}

/**
 * The thin supervisor (ADR 0001): a process manager, nothing more. It spawns a
 * runtime of a closed `kind` under a PTY (ADR 0004 — runtimes are TUIs), forwards
 * the caller's argv unchanged, and tracks lifecycle. It carries NO product logic:
 * no conversation, no routing, no history — those live in the product (agora).
 */
export class Supervisor {
  private readonly sessions = new Map<string, LiveSession>()

  constructor(private readonly defaults: SpawnDefaults) {}

  /** Spawn a runtime of `kind` under a PTY, forwarding `args` as argv. */
  spawn(kind: string, id: string, args: string[]): SessionInfo {
    if (!isKnownKind(kind)) {
      throw new BadRequest(`unknown kind: ${kind} (known: ${KNOWN_KINDS.join(', ')})`)
    }
    if (this.sessions.has(id)) {
      throw new BadRequest(`session already exists: ${id}`)
    }
    const spec = RUNTIMES[kind]
    const proc = pty.spawn(spec.command, [...spec.baseArgs, ...args], {
      name: 'xterm-256color',
      cols: this.defaults.cols ?? 200,
      rows: this.defaults.rows ?? 50,
      cwd: this.defaults.cwd,
      env: process.env as Record<string, string>,
    })

    const session: LiveSession = {
      id,
      kind,
      pid: proc.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      proc,
    }

    // The conversation flows through the channel, NOT the PTY (ADR 0004). We drain
    // the PTY so its buffer never backs up, but we do not interpret the output.
    proc.onData(() => {})
    proc.onExit(({ exitCode }) => {
      session.status = 'exited'
      session.exitCode = exitCode
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
}

function strip(s: LiveSession): SessionInfo {
  const { proc: _proc, ...info } = s
  return info
}
