import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LeaseStore } from './lease-store.js'

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'broker-lease-')), 'leases.json')
}
// a controllable clock
function clock(start = 1_000_000) {
  const c = { t: start }
  return { now: () => c.t, advance: (ms: number) => (c.t += ms), set: (v: number) => (c.t = v) }
}

test('mint a chat-v1 lease: opaque sk-ant-oat01 token, correct claims', () => {
  const store = new LeaseStore({ path: freshPath(), ttlMs: 60_000 })
  store.load()
  const r = store.mint({ runId: 'run_1', profile: 'chat-v1' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.match(r.token, /^sk-ant-oat01-broker-/)
  assert.equal(r.claims.profile, 'chat-v1')
  assert.equal(r.claims.runId, 'run_1')
  assert.equal(r.claims.target, null)
  assert.equal(store.validate(r.token).ok, true)
})

test('mint rejects unknown, disabled, and target-mismatched profiles', () => {
  const store = new LeaseStore({ path: freshPath(), ttlMs: 60_000 })
  store.load()
  assert.equal((store.mint({ runId: 'r', profile: 'nope' }) as { error: string }).error, 'unknown_profile')
  // repo-dev-v1 exists but is not enabled: P6.5 opened READ only, write stays shut.
  assert.equal((store.mint({ runId: 'r', profile: 'repo-dev-v1' }) as { error: string }).error, 'profile_disabled')
  // chat-v1 takes no target
  assert.equal((store.mint({ runId: 'r', profile: 'chat-v1', target: 'github:x/y' }) as { error: string }).error, 'target_forbidden')
})

test('validate: bogus token -> lease_invalid; empty -> lease_invalid', () => {
  const store = new LeaseStore({ path: freshPath(), ttlMs: 60_000 })
  store.load()
  assert.deepEqual(store.validate('sk-ant-oat01-broker-nope'), { ok: false, error: 'lease_invalid' })
  assert.deepEqual(store.validate(''), { ok: false, error: 'lease_invalid' })
})

test('expiry: a lease past its TTL validates as lease_expired, and gc reaps it', () => {
  const clk = clock()
  const store = new LeaseStore({ path: freshPath(), ttlMs: 1000, now: clk.now })
  store.load()
  const r = store.mint({ runId: 'r', profile: 'chat-v1' })
  assert.ok(r.ok)
  if (!r.ok) return
  clk.advance(500)
  assert.equal(store.validate(r.token).ok, true)
  clk.advance(600) // now 1100 > 1000 ttl
  assert.deepEqual(store.validate(r.token), { ok: false, error: 'lease_expired' })
  assert.equal(store.gc(), 1)
  assert.equal(store.size(), 0)
})

test('revoke is idempotent and kills the lease', () => {
  const store = new LeaseStore({ path: freshPath(), ttlMs: 60_000 })
  store.load()
  const r = store.mint({ runId: 'r', profile: 'chat-v1' })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(store.revoke(r.leaseId), true)
  assert.deepEqual(store.validate(r.token), { ok: false, error: 'lease_invalid' })
  assert.equal(store.revoke(r.leaseId), false) // idempotent
})

test('persistence: leases survive a restart, and the file holds NO raw token', () => {
  const path = freshPath()
  const s1 = new LeaseStore({ path, ttlMs: 60_000 })
  s1.load()
  const r = s1.mint({ runId: 'r', profile: 'chat-v1' })
  assert.ok(r.ok)
  if (!r.ok) return
  // the on-disk file must never contain the raw token
  const raw = readFileSync(path, 'utf8')
  assert.equal(raw.includes(r.token), false, 'raw token must not be persisted')
  assert.match(raw, /tokenHash/)
  // a fresh store on the same path recovers the lease
  const s2 = new LeaseStore({ path, ttlMs: 60_000 })
  s2.load()
  assert.equal(s2.validate(r.token).ok, true)
})

test('refuses to run when the store dir is missing (no silent empty store)', () => {
  const store = new LeaseStore({ path: '/nonexistent-broker-dir-xyz/leases.json', ttlMs: 60_000 })
  assert.throws(() => store.load(), /PVC not mounted|missing/)
})

test('two mints yield distinct tokens and lease ids', () => {
  const store = new LeaseStore({ path: freshPath(), ttlMs: 60_000 })
  store.load()
  const a = store.mint({ runId: 'r', profile: 'chat-v1' })
  const b = store.mint({ runId: 'r', profile: 'chat-v1' })
  assert.ok(a.ok && b.ok)
  if (!a.ok || !b.ok) return
  assert.notEqual(a.token, b.token)
  assert.notEqual(a.leaseId, b.leaseId)
})
