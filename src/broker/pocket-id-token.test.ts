import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PocketIdTokenProvider, readClientSecret, TokenError } from './pocket-id-token.js'

const ENDPOINT = 'https://id.example.dev/api/oidc/token'
const RESOURCE = 'https://vault.example.dev'

interface FakeIdp {
  fetchImpl: typeof fetch
  calls: Array<{ body: string; authorization: string }>
  reply: (n: number) => { status: number; json?: unknown; text?: string }
}

/** A Pocket-ID stand-in. `reply` decides what the Nth mint returns, so a test can make the token
 *  change, expire, or fail without any timing games. */
function fakeIdp(reply: FakeIdp['reply']): FakeIdp {
  const calls: FakeIdp['calls'] = []
  const fetchImpl = (async (_url: unknown, init: RequestInit | undefined) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ body: String(init?.body ?? ''), authorization: headers.authorization ?? '' })
    const r = reply(calls.length)
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, reply }
}

const ok = (token: string, expiresIn = 3600) => ({ status: 200, json: { access_token: token, expires_in: expiresIn, token_type: 'Bearer' } })

function provider(idp: FakeIdp, now: () => number, marginMs?: number): PocketIdTokenProvider {
  return new PocketIdTokenProvider({
    tokenEndpoint: ENDPOINT,
    clientId: 'broker-client',
    clientSecret: 's3cret',
    resource: RESOURCE,
    marginMs,
    now,
    fetchImpl: idp.fetchImpl,
  })
}

test('mints with client_credentials + the resource that becomes `aud`, authenticating via client_secret_basic', async () => {
  const idp = fakeIdp(() => ok('tok-1'))
  const token = await provider(idp, () => 0).get()
  assert.equal(token, 'tok-1')
  assert.equal(idp.calls.length, 1)

  const body = new URLSearchParams(idp.calls[0].body)
  assert.equal(body.get('grant_type'), 'client_credentials')
  // The resource is what Pocket-ID echoes into `aud`, and `aud` is what the vault MCP gates on —
  // omitting it would mint a token the vault refuses.
  assert.equal(body.get('resource'), RESOURCE)
  // The secret rides in the Authorization header, not the form body, so it stays out of anything
  // that logs request bodies on the way.
  assert.equal(body.get('client_secret'), null)
  assert.equal(idp.calls[0].authorization, `Basic ${Buffer.from('broker-client:s3cret').toString('base64')}`)
})

test('caches until expiry minus the margin, then re-mints', async () => {
  let clock = 0
  const idp = fakeIdp((n) => ok(`tok-${n}`, 3600))
  const p = provider(idp, () => clock, 60_000)

  assert.equal(await p.get(), 'tok-1')
  clock = 3_000_000 // well inside the hour
  assert.equal(await p.get(), 'tok-1', 'a valid token must not be re-minted')
  assert.equal(idp.calls.length, 1)

  // Into the margin: still technically valid, but too close to expiry to hand to a request that
  // might be in flight when it dies.
  clock = 3600_000 - 30_000
  assert.equal(await p.get(), 'tok-2')
  assert.equal(idp.calls.length, 2)
})

test('single-flight: a burst on an expired token mints ONCE, not once per caller', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    await gate // hold every caller inside the same mint
    return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
  }) as unknown as typeof fetch

  const p = new PocketIdTokenProvider({ tokenEndpoint: ENDPOINT, clientId: 'c', clientSecret: 's', resource: RESOURCE, now: () => 0, fetchImpl })
  const all = Promise.all([p.get(), p.get(), p.get(), p.get(), p.get()])
  release()
  const tokens = await all

  assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1', 'tok-1', 'tok-1'])
  assert.equal(calls, 1, 'five concurrent callers must not fire five client_credentials requests')
})

test('a failed mint does not wedge the provider: the next call retries', async () => {
  let clock = 0
  const idp = fakeIdp((n) => (n === 1 ? { status: 503, text: '{"error":"unavailable"}' } : ok('tok-2')))
  const p = provider(idp, () => clock)
  await assert.rejects(() => p.get(), TokenError)
  // The in-flight promise must have been cleared, or every later caller would await a dead mint.
  assert.equal(await p.get(), 'tok-2')
})

test('invalidate() forces a re-mint even though the cached token has not expired', async () => {
  const idp = fakeIdp((n) => ok(`tok-${n}`))
  const p = provider(idp, () => 0)
  assert.equal(await p.get(), 'tok-1')
  p.invalidate() // what the vault's 401 triggers: revoked at the IdP, or the secret rotated
  assert.equal(await p.get(), 'tok-2')
  assert.equal(idp.calls.length, 2)
})

test('a refresh_token in the response is ignored — client_credentials renews by re-minting only', async () => {
  let clock = 0
  const idp = fakeIdp((n) => ({ status: 200, json: { access_token: `tok-${n}`, expires_in: 3600, refresh_token: 'rt-should-be-ignored' } }))
  const p = provider(idp, () => clock, 60_000)
  assert.equal(await p.get(), 'tok-1')
  clock = 3600_000
  assert.equal(await p.get(), 'tok-2', 'expiry re-mints; it never tries a refresh grant')
  assert.equal(idp.calls.every((c) => !c.body.includes('refresh_token')), true)
})

test('an error never carries the provider payload — only a status', async () => {
  // An OAuth error body is attacker-influenced and this message goes to logs; a token-bearing
  // response echoed into a log aggregator is exactly the leak this adapter exists to prevent.
  const leak = '{"error":"invalid_client","access_token":"sk-LEAKED-IN-AN-ERROR-BODY"}'
  const idp = fakeIdp(() => ({ status: 401, text: leak }))
  const p = provider(idp, () => 0)
  await assert.rejects(
    () => p.get(),
    (err: TokenError) => {
      assert.equal(err.status, 401)
      assert.match(err.message, /returned 401/)
      assert.equal(err.message.includes('LEAKED'), false, 'the provider body must never reach the message')
      return true
    },
  )
})

test('a 200 with no access_token is an error, not an empty bearer', async () => {
  const idp = fakeIdp(() => ({ status: 200, json: { expires_in: 3600 } }))
  await assert.rejects(() => provider(idp, () => 0).get(), /no access_token/)
})

test('readClientSecret prefers a mounted file over the env var', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-secret-'))
  try {
    const file = join(dir, 'client-secret')
    writeFileSync(file, 'from-file\n') // trailing newline: how a k8s Secret file usually looks
    assert.equal(readClientSecret({ POCKET_ID_CLIENT_SECRET_FILE: file, POCKET_ID_CLIENT_SECRET: 'from-env' } as NodeJS.ProcessEnv), 'from-file')
    assert.equal(readClientSecret({ POCKET_ID_CLIENT_SECRET: 'from-env' } as NodeJS.ProcessEnv), 'from-env')
    // A named-but-unreadable/empty file is a misconfiguration: report nothing rather than silently
    // falling back to an env var the operator thought they had replaced.
    writeFileSync(file, '   ')
    assert.equal(readClientSecret({ POCKET_ID_CLIENT_SECRET_FILE: file, POCKET_ID_CLIENT_SECRET: 'from-env' } as NodeJS.ProcessEnv), undefined)
    assert.equal(readClientSecret({ POCKET_ID_CLIENT_SECRET_FILE: join(dir, 'nope'), POCKET_ID_CLIENT_SECRET: 'from-env' } as NodeJS.ProcessEnv), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
