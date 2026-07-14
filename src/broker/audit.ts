/**
 * Structured audit for the broker — one JSON line per event, NEVER a credential
 * (plan §0.2 invariant #8, §2.2). The field allow-list is explicit so a token, an
 * `Authorization` header or a provider secret cannot be logged even by accident:
 * anything not in `ALLOWED` is dropped before the line is written.
 */

export type AuditEvent =
  | 'lease.minted'
  | 'lease.used'
  | 'lease.denied'
  | 'lease.expired'
  | 'lease.revoked'
  | 'provider.token.minted'
  | 'provider.error'

export interface AuditFields {
  runId?: string
  leaseId?: string
  profile?: string
  target?: string | null
  adapter?: 'claude' | 'vault' | 'github'
  result?: string // 'ok' | a stable error code
  latencyMs?: number
  errorClass?: string // a class/code, never a message that could carry a token
}

const ALLOWED: readonly (keyof AuditFields)[] = [
  'runId',
  'leaseId',
  'profile',
  'target',
  'adapter',
  'result',
  'latencyMs',
  'errorClass',
]

export type Auditor = (event: AuditEvent, fields?: AuditFields) => void

/** Build an auditor. `sink`/`now` are injectable for tests. Only allow-listed fields survive. */
export function makeAuditor(
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
  now: () => number = Date.now,
): Auditor {
  return (event, fields = {}) => {
    const rec: Record<string, unknown> = { ts: new Date(now()).toISOString(), event }
    for (const k of ALLOWED) {
      const v = (fields as Record<string, unknown>)[k]
      if (v !== undefined) rec[k] = v
    }
    sink(JSON.stringify(rec))
  }
}
