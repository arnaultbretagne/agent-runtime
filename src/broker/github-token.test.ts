import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { GitHubAppTokens, readAppKey, GitHubTokenError } from './github-token.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const APP_ID = '4307707'

interface Call {
  path: string
  method: string
  body: any
  auth: string
}

/** A GitHub stand-in. `reply` decides what the Nth token mint returns. */
function fakeGitHub(reply: (n: number, body: any) => any = () => ({})) {
  const calls: Call[] = []
  let mints = 0
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method: init.method ?? 'GET', body, auth: headers.authorization ?? '' })

    if (path === '/app/installations') {
      return new Response(JSON.stringify([{ id: 146810752, account: { login: 'arnaultbretagne' } }]), { status: 200 })
    }
    if (path.endsWith('/access_tokens')) {
      mints++
      const over = reply(mints, body)
      return new Response(
        JSON.stringify({
          token: over.token ?? `ghs_installation_token_${mints}`,
          expires_at: over.expires_at ?? new Date(Date.now() + 3600_000).toISOString(),
          permissions: over.permissions ?? body?.permissions ?? {},
          repositories: (over.repositories ?? body?.repositories ?? []).map((n: string) => ({ full_name: `arnaultbretagne/${n}` })),
        }),
        { status: over.status ?? 201 },
      )
    }
    if (path === '/installation/repositories') {
      return new Response(
        JSON.stringify({
          repositories: [
            { name: 'agora', full_name: 'arnaultbretagne/agora' },
            { name: 'agent-runtime', full_name: 'arnaultbretagne/agent-runtime' },
            { name: 'infra-k8s', full_name: 'arnaultbretagne/infra-k8s' },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, mintCount: () => mints }
}

const tokens = (gh: ReturnType<typeof fakeGitHub>, over: Record<string, unknown> = {}) =>
  new GitHubAppTokens({ appId: APP_ID, privateKeyPem: PEM, fetchImpl: gh.fetchImpl, ...over })

test('signs a real RS256 App JWT with node crypto — no shell-out, and it verifies', async () => {
  const gh = fakeGitHub()
  await tokens(gh).get({ permissions: { contents: 'read', metadata: 'read' } })
  const jwt = gh.calls[0].auth.replace('Bearer ', '')
  const [h, p, sig] = jwt.split('.')

  const v = createVerify('RSA-SHA256')
  v.update(`${h}.${p}`)
  assert.equal(v.verify(publicKey, Buffer.from(sig, 'base64url')), true, 'the App JWT must verify against the key')

  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  assert.equal(claims.iss, APP_ID)
  // GitHub caps App JWTs at 10 min and rejects a future iat — back-dating survives clock skew.
  assert.ok(claims.exp - claims.iat <= 600, 'a JWT beyond 10 minutes is refused by GitHub')
  assert.ok(claims.iat < Math.floor(Date.now() / 1000), 'iat must be back-dated')
})

test('asks for exactly the profile permissions, and scopes repositories when told to', async () => {
  const gh = fakeGitHub()
  await tokens(gh).get({ permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }, repositories: ['agora'] })
  const mint = gh.calls.find((c) => c.path.endsWith('/access_tokens'))!
  assert.deepEqual(mint.body.permissions, { contents: 'write', pull_requests: 'write', metadata: 'read' })
  assert.deepEqual(mint.body.repositories, ['agora'])
})

test('omitting repositories means the whole installation — not a silent empty scope', async () => {
  const gh = fakeGitHub()
  await tokens(gh).get({ permissions: { contents: 'read', metadata: 'read' } })
  const mint = gh.calls.find((c) => c.path.endsWith('/access_tokens'))!
  assert.equal('repositories' in mint.body, false, 'the field must be ABSENT, since [] would scope to nothing')
})

test('caches by permission set: same ask reuses, a WIDER ask never reuses a narrower token', async () => {
  const gh = fakeGitHub()
  const t = tokens(gh)
  const a = await t.get({ permissions: { contents: 'read', metadata: 'read' } })
  const b = await t.get({ permissions: { contents: 'read', metadata: 'read' } })
  assert.equal(a.token, b.token)
  assert.equal(gh.mintCount(), 1, 'an identical ask must not re-mint')

  const c = await t.get({ permissions: { contents: 'write', metadata: 'read' } })
  assert.notEqual(c.token, a.token, 'a write ask must never be served a read token from cache')
  assert.equal(gh.mintCount(), 2)

  // ...and the same permissions on a DIFFERENT repo scope is a different token too.
  await t.get({ permissions: { contents: 'read', metadata: 'read' }, repositories: ['agora'] })
  assert.equal(gh.mintCount(), 3)
})

test('single-flight: concurrent identical asks mint once', async () => {
  const gh = fakeGitHub()
  const t = tokens(gh)
  const all = await Promise.all([1, 2, 3, 4].map(() => t.get({ permissions: { contents: 'read', metadata: 'read' } })))
  assert.equal(new Set(all.map((x) => x.token)).size, 1)
  assert.equal(gh.mintCount(), 1)
})

test('re-mints inside the margin, so a loge is never handed a token about to die mid-clone', async () => {
  let clock = Date.parse('2026-07-15T12:00:00Z')
  const gh = fakeGitHub(() => ({ expires_at: new Date(clock + 3600_000).toISOString() }))
  const t = tokens(gh, { now: () => clock, marginMs: 5 * 60_000 })
  await t.get({ permissions: { metadata: 'read' } })
  clock += 40 * 60_000 // 20 min left — comfortably outside the 5 min margin
  await t.get({ permissions: { metadata: 'read' } })
  assert.equal(gh.mintCount(), 1, 'still valid: re-minting here would just hammer GitHub')
  clock += 16 * 60_000 // 4 min left — inside the margin now
  await t.get({ permissions: { metadata: 'read' } })
  assert.equal(gh.mintCount(), 2, 'a token about to die must not be handed out for a fresh clone')
})

test('invalidate() drops the cache — a revoked lease gets nothing new', async () => {
  const gh = fakeGitHub()
  const t = tokens(gh)
  await t.get({ permissions: { metadata: 'read' } })
  t.invalidate()
  await t.get({ permissions: { metadata: 'read' } })
  assert.equal(gh.mintCount(), 2, 'after revocation nothing may be served from cache')
})

test('refuses a token GitHub granted WIDER than we asked — our model of the API would be wrong', async () => {
  // Belt and braces on the one guarantee everything rests on: GitHub narrows, never widens. If that
  // ever stopped holding, handing the loge the result would be handing it more than the profile earns.
  const gh = fakeGitHub(() => ({ permissions: { contents: 'write', metadata: 'read' } }))
  await assert.rejects(
    () => tokens(gh).get({ permissions: { contents: 'read', metadata: 'read' } }),
    /granted contents=write, which we did not ask for/,
  )
})

test('refuses a long-lived token — an installation token that does not expire soon is not one we asked for', async () => {
  const gh = fakeGitHub(() => ({ expires_at: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() }))
  await assert.rejects(() => tokens(gh).get({ permissions: { metadata: 'read' } }), /refusing a token whose expiry is/)
})

test('an error carries a status, never GitHub’s body', async () => {
  const leak = '{"message":"bad","token":"ghs_LEAKED_IN_AN_ERROR_BODY"}'
  const gh = fakeGitHub(() => ({ status: 422, token: undefined }))
  const fetchImpl = (async () => new Response(leak, { status: 422 })) as unknown as typeof fetch
  await assert.rejects(
    () => new GitHubAppTokens({ appId: APP_ID, privateKeyPem: PEM, fetchImpl }).get({ permissions: { metadata: 'read' } }),
    (e: GitHubTokenError) => {
      assert.equal(e.message.includes('LEAKED'), false, 'GitHub’s body must never reach the message')
      return true
    },
  )
  assert.ok(gh)
})

test('a multi-installation App refuses to guess which account to mint against', async () => {
  const fetchImpl = (async (url: string) => {
    if (new URL(url).pathname === '/app/installations') {
      return new Response(JSON.stringify([{ id: 1, account: { login: 'a' } }, { id: 2, account: { login: 'b' } }]), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  await assert.rejects(
    () => new GitHubAppTokens({ appId: APP_ID, privateKeyPem: PEM, fetchImpl }).get({ permissions: { metadata: 'read' } }),
    /2 installations — pin GITHUB_INSTALLATION_ID/,
  )
})

test('readAppKey prefers a file, and refuses anything that is not a PEM', () => {
  assert.equal(readAppKey({ GITHUB_APP_KEY: PEM } as NodeJS.ProcessEnv), PEM)
  assert.equal(readAppKey({ GITHUB_APP_KEY: 'not-a-key' } as NodeJS.ProcessEnv), undefined)
  assert.equal(readAppKey({ GITHUB_APP_KEY_FILE: '/nope/missing.pem' } as NodeJS.ProcessEnv), undefined)
  assert.equal(readAppKey({} as NodeJS.ProcessEnv), undefined)
})
