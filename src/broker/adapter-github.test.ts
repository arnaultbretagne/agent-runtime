import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGitHubForwarder, permissionsFor } from './adapter-github.js'
import { createAdapterServer } from './adapter-common.js'
import { GitHubAppTokens } from './github-token.js'

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

let lastMint: any
const fetchImpl = (async (url: string, init: RequestInit = {}) => {
  const path = new URL(url).pathname
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  if (path === '/app/installations') return new Response(JSON.stringify([{ id: 1, account: { login: 'arnaultbretagne' } }]), { status: 200 })
  if (path.endsWith('/access_tokens')) {
    if (body?.permissions && Object.keys(body.permissions).length > 1) lastMint = body
    return new Response(JSON.stringify({
      token: 'ghs_a_real_installation_token',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      permissions: body?.permissions ?? {},
      repositories: (body?.repositories ?? []).map((n: string) => ({ full_name: `arnaultbretagne/${n}` })),
    }), { status: 201 })
  }
  if (path === '/installation/repositories') {
    return new Response(JSON.stringify({ repositories: [
      { name: 'agora', full_name: 'arnaultbretagne/agora' },
      { name: 'agent-runtime', full_name: 'arnaultbretagne/agent-runtime' },
      { name: 'portfolio', full_name: 'arnaultbretagne/portfolio' },
      { name: 'infra-k8s', full_name: 'arnaultbretagne/infra-k8s' },
    ] }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

const server = createAdapterServer(createGitHubForwarder({ tokens: new GitHubAppTokens({ appId: '1', privateKeyPem: PEM, fetchImpl }) }))
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const PORT = (server.address() as AddressInfo).port
after(() => server.close())

const ask = async (profile: string, path = '/v1/github/token') => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'x-broker-lease-id': 'lease_1', 'x-broker-run-id': 'c-1', 'x-broker-profile': profile },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as any }
}

test('capability -> permissions: read earns read, write earns write+PR, chat earns nothing', () => {
  const of = (profile: string) => permissionsFor({ leaseId: 'l', runId: 'r', profile, target: null })
  assert.equal(of('chat-v1'), undefined, 'a chat lease must not reach GitHub at all')
  assert.equal(of('vault-v1'), undefined, 'vault does not imply repos')
  assert.equal(of('root-v1'), undefined, 'an unknown profile unlocks nothing')
  assert.deepEqual(of('repo-read-v1')!.permissions, { contents: 'read', metadata: 'read' })
  assert.deepEqual(of('repo-dev-v1')!.permissions, { contents: 'write', pull_requests: 'write', metadata: 'read' })
  // Never the permissions that would let an agent edit what confines it, or run code in CI.
  for (const p of ['repo-read-v1', 'repo-dev-v1', 'repo-dev-vault-v1']) {
    const perms = Object.keys(of(p)!.permissions)
    for (const forbidden of ['administration', 'workflows', 'secrets', 'actions', 'environments']) {
      assert.equal(perms.includes(forbidden), false, `${p} must never ask for ${forbidden}`)
    }
  }
})

test('a chat lease gets 403 and no token is minted', async () => {
  const r = await ask('chat-v1')
  assert.equal(r.status, 403)
  assert.equal(r.body.error, 'capability_denied')
  assert.equal(r.body.token, undefined)
})

test('no broker claim -> 401; wrong path -> 404', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/github/token`, { method: 'POST' })
  assert.equal(r.status, 401)
  assert.equal((await ask('repo-read-v1', '/v1/github/anything-else')).status, 404)
})

test('read profile: a token on ALL repos, read-only, with an expiry — and no target anywhere', async () => {
  const r = await ask('repo-read-v1')
  assert.equal(r.status, 200)
  assert.equal(r.body.token, 'ghs_a_real_installation_token')
  assert.deepEqual(r.body.permissions, { contents: 'read', metadata: 'read' })
  assert.equal(r.body.repositories, 'all', 'read is unscoped: the repos are public and the loge has no other door')
  assert.ok(Date.parse(r.body.expiresAt) > Date.now())
})

test('write profile: infra-k8s is excluded from the token BY CONSTRUCTION, not by a downstream check', async () => {
  lastMint = undefined
  const r = await ask('repo-dev-v1')
  assert.equal(r.status, 200)
  // The repo list sent to GitHub is what enforces it: the agent never holds a credential that can
  // reach infra-k8s, so there is no check left to bypass.
  assert.deepEqual(lastMint.repositories.sort(), ['agent-runtime', 'agora', 'portfolio'])
  assert.equal(lastMint.repositories.includes('infra-k8s'), false, 'the one repo whose write undoes every other control')
  assert.deepEqual(lastMint.permissions, { contents: 'write', pull_requests: 'write', metadata: 'read' })
  assert.equal((r.body.repositories as string[]).some((x) => x.endsWith('/infra-k8s')), false)
})

test('the response carries the token and its bounds — never the App id, installation id or JWT', async () => {
  const r = await ask('repo-read-v1')
  assert.deepEqual(Object.keys(r.body).sort(), ['expiresAt', 'permissions', 'repositories', 'token'])
})
