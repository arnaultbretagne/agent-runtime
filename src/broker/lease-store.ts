/**
 * The lease engine (plan §2.2, §2.7).
 *
 * A lease is an opaque, per-run bearer the manager mints and the loge carries in
 * place of any real credential. The store holds only `hash(token)` + claims —
 * never the raw token — persisted atomically to a PVC file so leases survive a
 * broker restart. Tokens are CSPRNG (256 bits) and wear the `sk-ant-oat01-…`
 * shape Claude Code accepts locally (worthless to Anthropic; the claude-adapter
 * swaps it). Lookup is by SHA-256 of the presented token, so the raw token is
 * never byte-compared — the hash is the timing protection.
 */
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { checkProfileTarget } from './profiles.js'

export interface LeaseClaims {
  leaseId: string
  runId: string
  profile: string
  target: string | null
  issuedAt: number
  expiresAt: number
}

interface StoredLease {
  tokenHash: string
  claims: LeaseClaims
}

export interface MintRequest {
  runId: string
  profile: string
  target?: string | null
}

export type MintResult =
  | { ok: true; leaseId: string; token: string; expiresAt: number; claims: LeaseClaims }
  | { ok: false; error: string; detail?: string }

export type ValidateResult =
  | { ok: true; claims: LeaseClaims }
  // A revoked lease is deleted, so by token alone it is indistinguishable from one that never
  // existed — both surface as `lease_invalid` (identical security outcome; revocation is audited
  // at the admin plane where the leaseId is known).
  | { ok: false; error: 'lease_invalid' | 'lease_expired' }

const TOKEN_PREFIX = 'sk-ant-oat01-broker-'
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const randomId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('base64url')}`

export interface LeaseStoreOpts {
  /** PVC-backed file. Required — the store refuses to run without a usable path (no silent
   *  empty store on a missing PVC). */
  path: string
  ttlMs: number
  now?: () => number
}

export class LeaseStore {
  private byId = new Map<string, StoredLease>()
  private byHash = new Map<string, string>() // tokenHash -> leaseId
  private readonly now: () => number

  constructor(private readonly opts: LeaseStoreOpts) {
    this.now = opts.now ?? Date.now
  }

  /** Load persisted leases and prove the store is writable (fail fast). An absent file is a
   *  normal first boot; a missing parent dir (PVC not mounted) or a corrupt file throws — we
   *  refuse to run rather than start with a silently-empty or partial store. */
  load(): void {
    const dir = dirname(this.opts.path)
    if (!existsSync(dir)) throw new Error(`lease store dir missing: ${dir} (PVC not mounted?)`)
    if (existsSync(this.opts.path)) {
      const arr = JSON.parse(readFileSync(this.opts.path, 'utf8')) as StoredLease[]
      for (const l of arr) {
        this.byId.set(l.claims.leaseId, l)
        this.byHash.set(l.tokenHash, l.claims.leaseId)
      }
    }
    this.persist() // proves the dir is writable now, not at first mint
  }

  mint(req: MintRequest): MintResult {
    const check = checkProfileTarget(req.profile, req.target)
    if (!check.ok) return { ok: false, error: check.error, detail: check.detail }
    if (!req.runId || typeof req.runId !== 'string') return { ok: false, error: 'run_id_required' }

    const leaseId = randomId('lease')
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const expiresAt = issuedAt + this.opts.ttlMs
    const claims: LeaseClaims = {
      leaseId,
      runId: req.runId,
      profile: check.profile.name,
      target: check.target,
      issuedAt,
      expiresAt,
    }
    const stored: StoredLease = { tokenHash: sha256(token), claims }
    this.byId.set(leaseId, stored)
    this.byHash.set(stored.tokenHash, leaseId)
    this.persist()
    return { ok: true, leaseId, token, expiresAt, claims }
  }

  validate(token: string): ValidateResult {
    if (typeof token !== 'string' || token === '') return { ok: false, error: 'lease_invalid' }
    const leaseId = this.byHash.get(sha256(token))
    const stored = leaseId ? this.byId.get(leaseId) : undefined
    if (!stored) return { ok: false, error: 'lease_invalid' }
    if (stored.claims.expiresAt <= this.now()) return { ok: false, error: 'lease_expired' }
    return { ok: true, claims: stored.claims }
  }

  /** Idempotent: revoking an unknown/already-gone lease is a no-op returning false. */
  revoke(leaseId: string): boolean {
    const stored = this.byId.get(leaseId)
    if (!stored) return false
    this.byId.delete(leaseId)
    this.byHash.delete(stored.tokenHash)
    this.persist()
    return true
  }

  /** Sweep expired leases. Returns how many were removed. */
  gc(): number {
    const now = this.now()
    let removed = 0
    for (const [id, s] of this.byId) {
      if (s.claims.expiresAt <= now) {
        this.byId.delete(id)
        this.byHash.delete(s.tokenHash)
        removed++
      }
    }
    if (removed) this.persist()
    return removed
  }

  size(): number {
    return this.byId.size
  }

  /** Atomic durable write: temp file -> fsync -> rename. The file holds hashes + claims, never a
   *  raw token. */
  private persist(): void {
    const arr = [...this.byId.values()]
    const tmp = `${this.opts.path}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, JSON.stringify(arr))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.opts.path)
  }
}
