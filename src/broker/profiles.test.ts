import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProfile,
  CATALOGUE,
  normalizeTarget,
  checkProfileTarget,
  publicProjection,
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

test('normalizeTarget: lowercases and validates syntax; GitHub does the bounding', () => {
  assert.deepEqual(normalizeTarget('github:ArnaultBretagne/Agora'), { ok: true, target: 'github:arnaultbretagne/agora' })
  assert.equal((normalizeTarget('not-a-target') as { error: string }).error, 'target_malformed')
  // Nothing is refused by name any more: the App is installed on one account, so a token for a repo
  // that is not Arnault's cannot exist. Duplicating that as a code list only re-created friction.
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

test('no repo is barred at the token layer — including infra-k8s', () => {
  // Plan invariant #10 (a hard infra-k8s deny-list) is deliberately dropped. With the repository
  // ruleset active, excluding it only stopped an agent OPENING a PR — noise, not compromise — while
  // barring agents from the infra work that is most of the real job. What actually stops an agent
  // rewriting its own confinement: it cannot merge (a review it cannot give itself), and it cannot
  // disable the ruleset (the App has no `Administration` permission).
  assert.equal(normalizeTarget('github:arnaultbretagne/infra-k8s').ok, true)
  assert.equal(normalizeTarget('github:someone/random').ok, true)
  assert.equal((normalizeTarget('not-a-target') as { error: string }).error, 'target_malformed')
})
