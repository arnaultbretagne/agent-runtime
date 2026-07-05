import { BadRequest } from './supervisor.js'

/**
 * Pure request-body validators for the control API (ADR 0001/0002). Split out of index.ts so
 * they're importable in tests without pulling in index.ts's module-load side effects (it starts
 * the HTTP server and runs bootSweepStrays() on import).
 */

export function envParam(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('`env` must be an object')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) env[k] = String(v)
  return env
}

const TRANSCRIPT_UUID_RE = /^[0-9a-f-]{36}$/
const TRANSCRIPT_MAX_BYTES = 20 * 1024 * 1024

export function transcriptParam(raw: unknown): { sessionUuid: string; content: string } | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest('`transcript` must be an object')
  }
  const { sessionUuid, content } = raw as Record<string, unknown>
  if (typeof sessionUuid !== 'string' || !TRANSCRIPT_UUID_RE.test(sessionUuid)) {
    throw new BadRequest('`transcript.sessionUuid` must be a 36-character uuid')
  }
  if (typeof content !== 'string') throw new BadRequest('`transcript.content` must be a string')
  if (Buffer.byteLength(content, 'utf8') > TRANSCRIPT_MAX_BYTES) {
    throw new BadRequest('`transcript.content` exceeds 20MB')
  }
  return { sessionUuid, content }
}
