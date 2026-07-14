import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LeaseStore, type LeaseClaims } from './lease-store.js'
import { bearerOf, authenticate, hasCapability, authorize, checkTarget } from './auth.js'

const freshStore = () => {
  const s = new LeaseStore({ path: join(mkdtempSync(join(tmpdir(), 'broker-auth-')), 'l.json'), ttlMs: 60_000 })
  s.load()
  return s
}

test('bearerOf', () => {
  assert.equal(bearerOf('Bearer abc'), 'abc')
  assert.equal(bearerOf('bearer abc'), null) // case-sensitive scheme
  assert.equal(bearerOf(undefined), null)
  assert.equal(bearerOf('Bearer    '), null)
})

test('authenticate: valid lease ok; missing 401; bad 401', () => {
  const s = freshStore()
  const r = s.mint({ runId: 'r', profile: 'chat-v1' })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(authenticate(s, `Bearer ${r.token}`).ok, true)
  assert.deepEqual(authenticate(s, undefined), { ok: false, status: 401, error: 'lease_missing' })
  assert.deepEqual(authenticate(s, 'Bearer nope'), { ok: false, status: 401, error: 'lease_invalid' })
})

test('capability gate: chat-v1 may invoke claude, not vault', () => {
  const s = freshStore()
  const r = s.mint({ runId: 'r', profile: 'chat-v1' })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(hasCapability(r.claims, 'claude:invoke'), true)
  assert.equal(hasCapability(r.claims, 'vault:full'), false)
  assert.equal(authorize(s, `Bearer ${r.token}`, 'claude:invoke').ok, true)
  assert.deepEqual(authorize(s, `Bearer ${r.token}`, 'vault:full'), { ok: false, status: 403, error: 'capability_denied' })
})

test('checkTarget: no target -> 403; match -> ok; mismatch -> 409', () => {
  const base: LeaseClaims = { leaseId: 'l', runId: 'r', profile: 'chat-v1', target: null, issuedAt: 0, expiresAt: 1 }
  const withTarget: LeaseClaims = { ...base, target: 'github:arnaultbretagne/agora' }
  assert.deepEqual(checkTarget(base, undefined), { ok: false, status: 403, error: 'target_denied' })
  assert.deepEqual(checkTarget(withTarget, undefined), { ok: true })
  assert.deepEqual(checkTarget(withTarget, 'github:arnaultbretagne/agora'), { ok: true })
  assert.deepEqual(checkTarget(withTarget, 'github:arnaultbretagne/obsidian-stack'), { ok: false, status: 409, error: 'target_mismatch' })
})
