import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProfile,
  CATALOGUE,
  normalizeTarget,
  checkProfileTarget,
  publicProjection,
  projectedTargets,
} from './profiles.js'

test('catalogue: chat + vault are open (P5); every repo profile is still gated off', () => {
  // This test IS the gate's tripwire: opening a profile has to be a deliberate edit here, never a
  // side effect of some other change. Each name below is a real capability over Arnault's data.
  for (const n of ['chat-v1', 'vault-v1']) {
    assert.equal(CATALOGUE[n].enabled, true, `${n} is open as of P5`)
    assert.equal(CATALOGUE[n].visible, true)
  }
  for (const n of ['repo-read-v1', 'repo-dev-v1', 'repo-dev-vault-v1']) {
    assert.equal(CATALOGUE[n].enabled, false, `${n} must stay disabled until its palier`)
    assert.equal(CATALOGUE[n].visible, false, `${n} must not even be offered in the UI`)
  }
  assert.deepEqual([...CATALOGUE['chat-v1'].capabilities], ['claude:invoke'], 'chat must never gain a capability by accident')
  assert.deepEqual([...CATALOGUE['vault-v1'].capabilities], ['claude:invoke', 'vault:full'])
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

test('publicProjection carries label + shape, never capabilities or the enabled gate', () => {
  const chat = publicProjection().find((p) => p.name === 'chat-v1')
  assert.deepEqual(chat, {
    name: 'chat-v1',
    label: 'Chat',
    description: 'Conversation seule. Aucun accès au vault ni à un dépôt.',
    needsTarget: false,
    visible: true,
  })
  // The two facts agora must never learn from the projection: what a profile can DO, and whether the
  // gate is open (agora renders `visible`; the manager alone acts on `enabled`).
  for (const p of publicProjection()) {
    assert.equal('capabilities' in (p as object), false)
    assert.equal('enabled' in (p as object), false)
  }
})

test('projectedTargets offers the allow-list, canonically, and never a denied repo', () => {
  const targets = projectedTargets()
  assert.ok(targets.includes('github:arnaultbretagne/agora'))
  // Canonical end to end: what the UI offers is exactly what normalizeTarget returns, so the picked
  // value travels unmodified and no layer has to rebuild the `github:` scheme (and get it wrong).
  for (const t of targets) {
    const n = normalizeTarget(t)
    assert.equal(n.ok, true, `${t} must be a valid target`)
    assert.equal((n as { target: string }).target, t, `${t} must already be canonical`)
  }
  assert.equal(targets.some((t) => t.includes('infra-k8s')), false, 'the deny-list must never be offered in the UI')
})
