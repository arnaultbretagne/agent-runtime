import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getProfile, CATALOGUE, normalizeTarget, checkProfileTarget, publicProjection } from './profiles.js'

test('catalogue: chat-v1 is the enabled default; higher profiles are gated off', () => {
  assert.equal(CATALOGUE['chat-v1'].enabled, true)
  assert.equal(CATALOGUE['chat-v1'].visible, true)
  for (const n of ['vault-v1', 'repo-read-v1', 'repo-dev-v1', 'repo-dev-vault-v1']) {
    assert.equal(CATALOGUE[n].enabled, false, `${n} must stay disabled until its palier`)
  }
  assert.deepEqual([...CATALOGUE['chat-v1'].capabilities], ['claude:invoke'])
})

test('getProfile: known vs unknown, no prototype pollution', () => {
  assert.equal(getProfile('chat-v1')?.name, 'chat-v1')
  assert.equal(getProfile('nope'), undefined)
  assert.equal(getProfile('constructor'), undefined)
  assert.equal(getProfile('__proto__'), undefined)
})

test('normalizeTarget: lowercases, allow-lists, hard-denies infra-k8s', () => {
  assert.deepEqual(normalizeTarget('github:ArnaultBretagne/Agora'), { ok: true, target: 'github:arnaultbretagne/agora' })
  assert.equal((normalizeTarget('not-a-target') as { error: string }).error, 'target_malformed')
  assert.equal((normalizeTarget('github:arnaultbretagne/infra-k8s') as { error: string }).error, 'target_denied')
  assert.equal((normalizeTarget('github:someone/random') as { error: string }).error, 'target_denied')
})

test('checkProfileTarget: reachable P2 paths', () => {
  assert.equal((checkProfileTarget('nope', null) as { error: string }).error, 'unknown_profile')
  // repo-read-v1 is disabled in P2, so it is rejected before the target is even considered
  assert.equal((checkProfileTarget('repo-read-v1', 'github:arnaultbretagne/agora') as { error: string }).error, 'profile_disabled')
  assert.equal(checkProfileTarget('chat-v1', null).ok, true)
  assert.equal((checkProfileTarget('chat-v1', 'github:x/y') as { error: string }).error, 'target_forbidden')
})

test('publicProjection carries shape, never capabilities', () => {
  const chat = publicProjection().find((p) => p.name === 'chat-v1')
  assert.deepEqual(chat, { name: 'chat-v1', needsTarget: false, visible: true })
  assert.equal('capabilities' in (chat as object), false)
})
