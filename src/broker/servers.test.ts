import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LeaseStore } from './lease-store.js'
import { makeAuditor } from './audit.js'
import { createAdminServer } from './admin-server.js'
import { createDataServer } from './data-server.js'
import type { FrontConfig } from './config.js'

const portOf = (s: Server): number => (s.address() as AddressInfo).port

// A fake adapter: records what the front forwarded, echoes a marker.
const forwarded: Array<{ path: string; headers: Record<string, string | string[] | undefined> }> = []
const fakeAdapter = createServer((req, res) => {
  forwarded.push({ path: req.url ?? '', headers: req.headers })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ adapter: 'fake', ok: true }))
})

const auditLines: string[] = []
const audit = makeAuditor((l) => auditLines.push(l))
const store = new LeaseStore({ path: join(mkdtempSync(join(tmpdir(), 'broker-srv-')), 'l.json'), ttlMs: 60_000 })
store.load()

fakeAdapter.listen(0, '127.0.0.1')
await once(fakeAdapter, 'listening')
const adapterUrl = `http://127.0.0.1:${portOf(fakeAdapter)}`
const cfg: FrontConfig = {
  adminPort: 0,
  dataPort: 0,
  leaseStorePath: '',
  leaseTtlMs: 60_000,
  gcIntervalMs: 60_000,
  adapters: { claude: adapterUrl, vault: adapterUrl, github: adapterUrl },
}
const admin = createAdminServer(store, audit)
const data = createDataServer(store, cfg, audit)
admin.listen(0, '127.0.0.1')
data.listen(0, '127.0.0.1')
await Promise.all([once(admin, 'listening'), once(data, 'listening')])
const ADMIN = portOf(admin)
const DATA = portOf(data)

after(() => {
  fakeAdapter.close()
  admin.close()
  data.close()
})

interface Resp {
  status: number
  body: Record<string, unknown>
}
const call = async (port: number, path: string, opts: RequestInit = {}): Promise<Resp> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts)
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
}

// mint a chat-v1 lease via the admin API (exercises that path)
const minted = await call(ADMIN, '/v1/leases', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: 'run_A', profile: 'chat-v1' }),
})
const LEASE = minted.body.token as string
const LEASE_ID = minted.body.leaseId as string

test('admin mints a chat-v1 lease (201, sk-ant-oat01 token, iso expiry)', () => {
  assert.equal(minted.status, 201)
  assert.match(LEASE, /^sk-ant-oat01-broker-/)
  assert.match(minted.body.expiresAt as string, /^\d{4}-\d\d-\d\dT/)
})

test('admin rejects an unknown profile (400)', async () => {
  const r = await call(ADMIN, '/v1/leases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'r', profile: 'nope' }),
  })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'unknown_profile')
})

test('data: a valid lease forwards to the adapter with the lease STRIPPED and claims attached', async () => {
  const r = await call(DATA, '/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${LEASE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hi: true }),
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.adapter, 'fake')
  const fwd = forwarded[forwarded.length - 1]
  assert.equal(fwd.headers.authorization, undefined, 'the lease must never reach the adapter')
  assert.equal(fwd.headers['x-broker-lease-id'], LEASE_ID)
  assert.equal(fwd.headers['x-broker-profile'], 'chat-v1')
})

test('data: no lease -> 401 lease_missing', async () => {
  const r = await call(DATA, '/v1/messages', { method: 'POST', body: '{}' })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'lease_missing')
})

test('data: a bogus lease -> 401 lease_invalid', async () => {
  const r = await call(DATA, '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer sk-ant-oat01-broker-nope' }, body: '{}' })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'lease_invalid')
})

test('data: chat-v1 lease on the vault route -> 403 capability_denied (no forward)', async () => {
  const before = forwarded.length
  const r = await call(DATA, '/v1/vault/mcp', { method: 'POST', headers: { authorization: `Bearer ${LEASE}` }, body: '{}' })
  assert.equal(r.status, 403)
  assert.equal(r.body.error, 'capability_denied')
  assert.equal(forwarded.length, before, 'a denied request must not reach the adapter')
})

test('audit hygiene: no audit line ever contains the lease token', () => {
  assert.ok(auditLines.length > 0)
  for (const line of auditLines) assert.equal(line.includes(LEASE), false, `token leaked into audit: ${line}`)
  assert.ok(auditLines.some((l) => l.includes('"event":"lease.minted"')))
  assert.ok(auditLines.some((l) => l.includes('"event":"lease.used"')))
})

test('admin revoke -> the lease is dead on the data plane (401)', async () => {
  const rev = await call(ADMIN, `/v1/leases/${LEASE_ID}`, { method: 'DELETE' })
  assert.equal(rev.status, 200)
  assert.equal(rev.body.revoked, true)
  const r = await call(DATA, '/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${LEASE}` }, body: '{}' })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'lease_invalid')
})

// ---------------------------------------------------------------------------------------------
// The GitHub route. Added 2026-07-15 after this route shipped BROKEN: it carried `needsTarget:
// true`, so from the moment P6 dropped `target` from the profiles it 403'd every token request —
// and nothing here noticed, because the suite configured a github adapter and never called it.
//
// The lease below is minted through the REAL admin API against the REAL catalogue. That is the
// whole point: the old auth.test.ts checked this rule against a hand-built claims object carrying
// a target, i.e. a lease shape the system can no longer produce. It passed while production was
// dead. A test may not invent a state its own system cannot reach.
// ---------------------------------------------------------------------------------------------

const readMint = await call(ADMIN, '/v1/leases', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: 'run_R', profile: 'repo-read-v1' }),
})
const READ_LEASE = readMint.body.token as string

test('a repo-read-v1 lease REACHES the github adapter — the route the loge’s credential helper uses', async () => {
  assert.equal(readMint.status, 201, `the catalogue must actually mint this profile: ${JSON.stringify(readMint.body)}`)
  const before = forwarded.length
  const r = await call(DATA, '/v1/github/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${READ_LEASE}` },
  })
  assert.equal(r.status, 200, 'a valid repo lease must not be refused by the front')
  assert.equal(forwarded.length, before + 1, 'the request must actually be FORWARDED, not answered by the front')
  assert.equal(forwarded[forwarded.length - 1].path, '/v1/github/token')
  assert.match(auditLines.join('\n'), /"event":"lease.used".*"adapter":"github"/, 'a used lease must be audited as used')
})

test('a chat-v1 lease is refused the github route (403) and never reaches the adapter', async () => {
  // A FRESH chat lease: the one minted at the top of this file is deliberately revoked by an
  // earlier test, and reusing it here would assert 401 (dead lease) while claiming to prove 403
  // (live lease, wrong profile) — a different guarantee entirely.
  const chat = await call(ADMIN, '/v1/leases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'run_C2', profile: 'chat-v1' }),
  })
  const before = forwarded.length
  const r = await call(DATA, '/v1/github/token', { method: 'POST', headers: { authorization: `Bearer ${chat.body.token as string}` } })
  assert.equal(r.status, 403, 'a LIVE chat lease must be refused for lacking the capability, not for being dead')
  assert.equal(r.body.error, 'capability_denied')
  assert.equal(forwarded.length, before, 'a denied lease must not reach the adapter at all')
})

test('no lease at all is refused the github route (401)', async () => {
  const r = await call(DATA, '/v1/github/token', { method: 'POST' })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'lease_missing')
})
