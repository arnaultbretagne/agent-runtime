import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createVaultForwarder } from './adapter-vault.js'
import { createAdapterServer } from './adapter-common.js'
import { PocketIdTokenProvider } from './pocket-id-token.js'

const portOf = (s: Server): number => (s.address() as AddressInfo).port

// ── a fake vault MCP ────────────────────────────────────────────────────
interface Seen {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}
let seen: Seen[] = []
/** What the fake vault does with the Nth request it sees. */
let vaultReply: (n: number, req: Seen) => { status: number; headers?: Record<string, string>; body: string } = () => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-42' },
  body: '{"jsonrpc":"2.0","result":{"tools":[]}}',
})

const vault = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
    seen.push(entry)
    const r = vaultReply(seen.length, entry)
    res.writeHead(r.status, r.headers ?? { 'content-type': 'application/json' })
    res.end(r.body)
  })
})
vault.listen(0, '127.0.0.1')
await once(vault, 'listening')
const VAULT_URL = `http://127.0.0.1:${portOf(vault)}/mcp`

// ── a fake Pocket-ID ────────────────────────────────────────────────────
let mints = 0
const idpFetch = (async () => {
  mints++
  return new Response(JSON.stringify({ access_token: `machine-bearer-${mints}`, expires_in: 3600 }), { status: 200 })
}) as unknown as typeof fetch

const tokens = new PocketIdTokenProvider({
  tokenEndpoint: 'https://id.example.dev/api/oidc/token',
  clientId: 'broker',
  clientSecret: 'sekret',
  resource: 'https://vault.example.dev',
  fetchImpl: idpFetch,
})

const server = createAdapterServer(createVaultForwarder({ tokens, upstreamUrl: VAULT_URL, maxRequestBytes: 1024 }))
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const PORT = portOf(server)

after(() => {
  vault.close()
  server.close()
})

beforeEach(() => {
  seen = []
})

const VAULT_CLAIMS = { 'x-broker-lease-id': 'lease_1', 'x-broker-run-id': 'c-1', 'x-broker-profile': 'vault-v1' }

const call = async (headers: Record<string, string>, body = '{"jsonrpc":"2.0","method":"tools/list"}', path = '/v1/vault/mcp') => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers, body })
  return { status: r.status, text: await r.text(), headers: r.headers }
}

// ── the credential boundary ─────────────────────────────────────────────

test('injects the machine bearer server-side and forwards the MCP call — the loge never sends one', async () => {
  const r = await call({ ...VAULT_CLAIMS, 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
  assert.equal(r.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.authorization, 'Bearer machine-bearer-1', 'the vault sees the broker bearer')
  assert.equal(seen[0].url, '/mcp', 'the broker route is mapped to the vault MCP endpoint')
  assert.equal(seen[0].headers['mcp-session-id'], 'sess-1', 'the MCP session handle survives, or the protocol breaks')
  assert.equal(r.headers.get('mcp-session-id'), 'sess-42', 'and comes back to the client')
})

test('a request with no broker claim is refused (401) and never reaches the vault', async () => {
  const r = await call({ 'content-type': 'application/json' })
  assert.equal(r.status, 401)
  assert.match(r.text, /no_broker_claim/)
  assert.equal(seen.length, 0)
})

test('a profile without vault:full is refused (403) even reaching this adapter directly', async () => {
  // Defence in depth: the front already gates the route, but this process holds the vault credential.
  const r = await call({ ...VAULT_CLAIMS, 'x-broker-profile': 'chat-v1' })
  assert.equal(r.status, 403)
  assert.match(r.text, /capability_denied/)
  assert.equal(seen.length, 0, 'a chat lease must not reach the vault at all')
})

test('an unknown profile is refused (403) — fail closed, never "unknown so allow"', async () => {
  const r = await call({ ...VAULT_CLAIMS, 'x-broker-profile': 'root-v1' })
  assert.equal(r.status, 403)
  assert.equal(seen.length, 0)
})

test('only /v1/vault/mcp is served: no other path reaches the vault', async () => {
  for (const path of ['/v1/vault/notes', '/v1/vault/mcp/../admin', '/mcp', '/']) {
    const r = await call({ ...VAULT_CLAIMS }, '{}', path)
    assert.equal(r.status, 404, `${path} must not be served`)
  }
  assert.equal(seen.length, 0)
})

// ── what the loge may and may not send ──────────────────────────────────

test('headers are allow-listed: a loge cannot smuggle its own authorization or arbitrary headers upstream', async () => {
  await call({
    ...VAULT_CLAIMS,
    'content-type': 'application/json',
    authorization: 'Bearer sk-LOGE-CHOSEN-TOKEN',
    'x-forwarded-for': '10.0.0.1',
    cookie: 'session=steal-me',
    'x-custom-probe': 'hello',
  })
  assert.equal(seen.length, 1)
  const h = seen[0].headers
  assert.equal(h.authorization, 'Bearer machine-bearer-1', "the loge's own authorization is replaced, never merged")
  assert.equal(h.cookie, undefined)
  assert.equal(h['x-forwarded-for'], undefined)
  assert.equal(h['x-custom-probe'], undefined)
  // The internal claim headers must not leak to the vault either — they are broker-internal.
  assert.equal(h['x-broker-lease-id'], undefined)
  assert.equal(h['x-broker-profile'], undefined)
})

test('an oversized request is cut at 413 and never reaches the vault', async () => {
  const r = await call({ ...VAULT_CLAIMS, 'content-type': 'application/json' }, 'x'.repeat(4096))
  assert.equal(r.status, 413)
  assert.equal(seen.length, 0)
})

// ── the 401 retry ───────────────────────────────────────────────────────

test('a 401 from the vault re-mints ONCE and replays the call; a second 401 is returned, not looped', async () => {
  const before = mints
  // First call 401s (the bearer was revoked at the IdP, or the secret rotated); the replay succeeds.
  vaultReply = (n) =>
    n === 1
      ? { status: 401, body: '{"error":"Invalid or expired token"}' }
      : { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }

  const r = await call({ ...VAULT_CLAIMS, 'content-type': 'application/json' })
  assert.equal(r.status, 200, 'the retry is transparent to the loge')
  assert.equal(seen.length, 2, 'the call is replayed exactly once')
  assert.equal(mints, before + 1, 'the cache was invalidated and a fresh bearer minted')
  assert.equal(seen[0].headers.authorization !== seen[1].headers.authorization, true, 'the replay uses the NEW bearer')
  assert.equal(seen[1].body, seen[0].body, 'the body is replayed intact')

  // A vault that keeps 401ing must surface, not spin: one retry, then the honest answer.
  seen = []
  vaultReply = () => ({ status: 401, body: '{"error":"Invalid or expired token"}' })
  const r2 = await call({ ...VAULT_CLAIMS, 'content-type': 'application/json' })
  assert.equal(r2.status, 401)
  assert.equal(seen.length, 2, 'exactly one retry — never a loop against the IdP')

  vaultReply = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
})

// ── streaming ───────────────────────────────────────────────────────────

test('an SSE response streams through untouched — the byte cap must not break MCP streaming', async () => {
  vaultReply = () => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: 'event: message\ndata: {"jsonrpc":"2.0","result":"streamed"}\n\n',
  })
  const r = await call({ ...VAULT_CLAIMS, accept: 'text/event-stream' })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/event-stream')
  assert.match(r.text, /streamed/)
  vaultReply = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
})

test('a vault error is passed through as-is — the adapter adds no credential detail to it', async () => {
  vaultReply = () => ({ status: 403, body: '{"error":"client_id not allowed"}' })
  const r = await call({ ...VAULT_CLAIMS, 'content-type': 'application/json' })
  assert.equal(r.status, 403)
  assert.match(r.text, /client_id not allowed/)
  assert.equal(r.text.includes('machine-bearer'), false, 'no bearer may appear in an error surfaced to the loge')
  vaultReply = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
})

test('an unreachable Pocket-ID is an honest 502, and the vault is never called without a bearer', async () => {
  const deadTokens = new PocketIdTokenProvider({
    tokenEndpoint: 'https://id.example.dev/api/oidc/token',
    clientId: 'broker',
    clientSecret: 'sekret',
    resource: 'https://vault.example.dev',
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch,
  })
  const s = createAdapterServer(createVaultForwarder({ tokens: deadTokens, upstreamUrl: VAULT_URL }))
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  try {
    const r = await fetch(`http://127.0.0.1:${portOf(s)}/v1/vault/mcp`, { method: 'POST', headers: VAULT_CLAIMS, body: '{}' })
    assert.equal(r.status, 502)
    assert.match(await r.text(), /credential_unavailable/)
    assert.equal(seen.length, 0, 'no bearer, no call — never an unauthenticated request to the vault')
  } finally {
    s.close()
  }
})
