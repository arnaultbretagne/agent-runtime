import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { injectAccountUuid, createInferenceProxyServer, type ProxyConfig } from './inference-proxy.js'

test('injectAccountUuid: fills the empty slot, leaves a filled/absent one (or no uuid) alone', () => {
  const empty = '{"metadata":{"user_id":"{\\"device_id\\":\\"d\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"s\\"}"}}'
  const filled = injectAccountUuid(empty, 'ACC-123')
  assert.ok(filled.includes('\\"account_uuid\\":\\"ACC-123\\"'), 'the real uuid is spliced into the escaped slot')
  assert.ok(!filled.includes('\\"account_uuid\\":\\"\\"'), 'no empty slot remains')
  assert.equal(injectAccountUuid(empty, ''), empty, 'no uuid known → body untouched')
  assert.equal(injectAccountUuid('{"no":"slot"}', 'ACC-123'), '{"no":"slot"}', 'absent slot → body untouched')
})

test('proxy: swaps the Bearer to the real token, drops x-api-key, fills account_uuid, streams the reply back', async () => {
  let seenAuth: string | undefined
  let seenApiKey: string | string[] | undefined
  let seenBody = ''
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenAuth = req.headers['authorization']
    seenApiKey = req.headers['x-api-key']
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"ok":true}\n\n')
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const upPort = (upstream.address() as { port: number }).port

  const config: ProxyConfig = {
    token: 'sk-ant-oat01-REAL',
    accountUuid: 'ACC-REAL',
    upstreamOrigin: `http://127.0.0.1:${upPort}`,
    port: 0,
  }
  const proxy = createInferenceProxyServer(config, config.accountUuid)
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  const proxyPort = (proxy.address() as { port: number }).port

  try {
    const body = '{"model":"claude-sonnet-5","metadata":{"user_id":"{\\"account_uuid\\":\\"\\"}"},"stream":true}'
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-ant-oat01-PLACEHOLDER',
        'x-api-key': 'should-be-dropped',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body,
    })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.equal(seenAuth, 'Bearer sk-ant-oat01-REAL', 'the placeholder Bearer is swapped for the real token')
    assert.equal(seenApiKey, undefined, 'x-api-key is dropped (never reaches the upstream)')
    assert.ok(seenBody.includes('\\"account_uuid\\":\\"ACC-REAL\\"'), 'the empty account_uuid is filled with the real one')
    assert.ok(text.includes('data:'), 'the SSE reply is streamed back to the caller')
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()))
    await new Promise<void>((r) => upstream.close(() => r()))
  }
})

test('proxy: /healthz is answered locally, never forwarded upstream', async () => {
  const config: ProxyConfig = { token: 't', accountUuid: '', upstreamOrigin: 'http://127.0.0.1:1', port: 0 }
  const proxy = createInferenceProxyServer(config, '')
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
  const port = (proxy.address() as { port: number }).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()))
  }
})
