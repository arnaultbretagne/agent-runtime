import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createClaudeForwarder } from './adapter-claude.js'
import { createAdapterServer } from './adapter-common.js'

const portOf = (s: Server): number => (s.address() as AddressInfo).port

// fake Anthropic upstream: records the request, replies SSE.
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = []
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('event: message\ndata: {"ok":true}\n\n')
  })
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')

const REAL_TOKEN = 'sk-ant-oat01-REAL-secret-do-not-leak'
const ACCOUNT = 'f9255ae9-488d-40f8-bca8-0ca636702652'
const server = createAdapterServer(
  createClaudeForwarder({ token: REAL_TOKEN, accountUuid: ACCOUNT, upstreamOrigin: `http://127.0.0.1:${portOf(upstream)}` }),
)
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const PORT = portOf(server)

after(() => {
  upstream.close()
  server.close()
})

const post = async (headers: Record<string, string>, body: string) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, { method: 'POST', headers, body })
  return { status: r.status, text: await r.text() }
}

test('claude adapter: swaps in the real token, fills account_uuid, strips x-broker-* + x-api-key, keeps beta', async () => {
  const body = JSON.stringify({ model: 'claude', metadata: { user_id: JSON.stringify({ account_uuid: '' }) } })
  const r = await post(
    {
      'x-broker-lease-id': 'lease_abc',
      'x-broker-run-id': 'run_1',
      'x-broker-profile': 'chat-v1',
      'x-api-key': 'should-be-dropped',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
    body,
  )
  assert.equal(r.status, 200)
  const up = received[received.length - 1]
  assert.equal(up.headers.authorization, `Bearer ${REAL_TOKEN}`) // real token swapped in
  assert.equal(up.headers['x-api-key'], undefined) // client api-key dropped
  assert.equal(up.headers['x-broker-lease-id'], undefined) // internal claim not leaked upstream
  assert.equal(up.headers['x-broker-profile'], undefined)
  assert.equal(up.headers['anthropic-beta'], 'oauth-2025-04-20') // subscription capability preserved
  assert.match(up.body, /f9255ae9-488d-40f8-bca8-0ca636702652/) // empty account_uuid filled
})

test('claude adapter: a request with no broker claim is refused (401), never forwarded', async () => {
  const before = received.length
  const r = await post({ 'content-type': 'application/json' }, '{}')
  assert.equal(r.status, 401)
  assert.equal(received.length, before)
})
