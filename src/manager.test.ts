import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Manager, CreateGate, buildLogePodSpec, buildProxyPodSpec, type ManagerConfig } from './manager.js'
import type { K8sPods, HttpError } from './k8s.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function baseConfig(overrides: Partial<ManagerConfig> = {}): ManagerConfig {
  return {
    port: 0,
    substrate: 'isolated',
    sharedSupervisorUrl: 'http://127.0.0.1:1', // unused unless a test overrides it
    agentRunsNs: 'agent-runs',
    logeImage: 'ghcr.io/example/agent-runtime@sha256:deadbeef',
    logeLingerMs: 120_000,
    maxConcurrentLogeCreates: 2,
    logeReadyTimeoutMs: 2000,
    anchorDir: mkdtempSync(join(tmpdir(), 'agent-runtime-anchors-')),
    anchorTtlDays: 30,
    sweepIntervalMs: 30_000,
    claudeOauthSecret: 'claude-oauth-token',
    proxyPort: 8788,
    accountUuid: 'acc-uuid-test',
    ...overrides,
  }
}

/** Every 127.0.0.0/8 address is loopback on Linux — each test that needs a fake "loge" gets its
 *  own address (port stays 8080, matching reality) so undici's keep-alive pool never confuses one
 *  test's server with another's after a close()+listen() on the same port:host pair. */
let nextLoopback = 2
function allocLoopback(): string {
  return `127.0.0.${nextLoopback++}`
}

const LOGE_PORT = 8080

type RouteFn = (method: string, path: string, body: string) => { status: number; contentType?: string; body: string }

function startFakeServer(
  onRequest: RouteFn,
  port: number,
  host: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const result = onRequest(req.method ?? 'GET', url.pathname, bodyText)
      res.writeHead(result.status, { 'content-type': result.contentType ?? 'application/json' })
      res.end(result.body)
    })
    server.on('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://${host}:${actualPort}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

function json(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) }
}

class MockK8s implements K8sPods {
  createCalls = 0
  readonly pods = new Map<string, any>()
  failCreateWith?: HttpError

  constructor(private readonly makePod: (name: string) => any) {}

  async createPod(spec: any): Promise<any> {
    this.createCalls++
    const name = spec.metadata.name as string
    if (this.failCreateWith) throw this.failCreateWith
    if (this.pods.has(name)) {
      const err = new Error('AlreadyExists') as HttpError
      err.status = 409
      throw err
    }
    const pod = this.makePod(name)
    this.pods.set(name, pod)
    return pod
  }

  async getPod(name: string): Promise<any | undefined> {
    return this.pods.get(name)
  }

  async listPods(_labelSelector: string): Promise<any[]> {
    return [...this.pods.values()]
  }

  async deletePod(name: string): Promise<void> {
    this.pods.delete(name)
  }
}

function readyLoge(name: string, group: string, podIP: string) {
  return {
    metadata: { name, labels: { app: 'loge', 'agora.bretagne.dev/group': group }, creationTimestamp: new Date().toISOString() },
    status: { phase: 'Running', podIP, conditions: [{ type: 'Ready', status: 'True' }] },
  }
}

test('spawn: shared config proxies verbatim to the shared supervisor (no body substrate)', async () => {
  let received: any
  const shared = await startFakeServer((method, path, body) => {
    if (method === 'POST' && path === '/sessions') {
      received = JSON.parse(body)
      return json(201, { id: 'r1', kind: 'claude', status: 'running' })
    }
    return json(404, { error: 'not found' })
  }, 0, '127.0.0.1')
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'unused', '127.0.0.1'))
    const manager = new Manager({ k8s, config: baseConfig({ sharedSupervisorUrl: shared.url, substrate: 'shared' }) })
    const result = await manager.spawn({ kind: 'claude', args: ['--session-id', 'u1'] })
    assert.equal(result.status, 201)
    assert.deepEqual(result.body, { id: 'r1', kind: 'claude', status: 'running' })
    assert.deepEqual(received, { kind: 'claude', args: ['--session-id', 'u1'] })
    assert.equal(k8s.createCalls, 0)
  } finally {
    await shared.close()
  }
})

test('spawn: shared proxy unreachable -> honest 502, never a fabricated quota_exceeded', async () => {
  // Incident 2026-07-05: a CNP gap made this fetch throw, and the old code mapped ANY forwardSpawn
  // exception to quota_exceeded — indistinguishable from a real loge-creation quota problem.
  const k8s = new MockK8s((name) => readyLoge(name, 'unused', '127.0.0.1'))
  const manager = new Manager({ k8s, config: baseConfig({ sharedSupervisorUrl: 'http://127.0.0.1:1', substrate: 'shared' }) })
  const result = await manager.spawn({ kind: 'claude', args: [] })
  assert.equal(result.status, 502)
  assert.equal((result.body as { error: string }).error, 'spawn_forward_failed')
})

test('spawn: creates a loge from baked config, with no substrate in the body (the hub sends none)', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'POST' && path === '/sessions') return json(201, { id: 'r-iso', kind: 'claude', status: 'running' })
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-x', ip))
    const manager = new Manager({ k8s, config: baseConfig(), readyPollMs: 5 })
    // no `substrate` field at all — the hub stopped sending it (it owns no placement policy)
    const result = await manager.spawn({ kind: 'claude', args: [], id: 'r-iso', group: 'conv-x' })
    assert.equal(result.status, 202)
    assert.deepEqual(result.body, { id: 'r-iso', status: 'creating' }, 'read-driven: accepted + booting, a fact — not a blocked call')
    await manager.awaitSettled()
    assert.equal(k8s.createCalls, 2, 'the inference-proxy singleton + the loge (absent substrate must create a loge, never proxy to the dead shared pod)')
  } finally {
    await loge.close()
  }
})

test('spawn: isolated substrate creates a loge once, reuses it for the same group', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'POST' && path === '/sessions') return json(201, { id: `r-${Math.random()}`, kind: 'claude', status: 'running' })
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-1', ip))
    const manager = new Manager({ k8s, config: baseConfig(), readyPollMs: 5 })
    const r1 = await manager.spawn({ kind: 'claude', args: [], id: 'r1a', group: 'conv-1' })
    await manager.awaitSettled() // first loge fully up before the second spawn → reuse, not a create race
    const r2 = await manager.spawn({ kind: 'claude', args: [], id: 'r1b', group: 'conv-1' })
    await manager.awaitSettled()
    assert.equal(r1.status, 202)
    assert.equal(r2.status, 202)
    assert.equal(k8s.createCalls, 2, 'inference-proxy + loge created once; the second spawn reuses the loge (no new create)')
  } finally {
    await loge.close()
  }
})

test('read-driven liveness: `creating` right after spawn, `running` once the loge is up (GET /sessions/:id)', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'POST' && path === '/sessions') return json(201, { id: 'r-live', kind: 'claude', status: 'running' })
    if (method === 'GET' && path === '/sessions/r-live') return json(200, { id: 'r-live', kind: 'claude', status: 'running' })
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-live', ip))
    const manager = new Manager({ k8s, config: baseConfig(), readyPollMs: 5 })
    const r = await manager.spawn({ kind: 'claude', args: [], id: 'r-live', group: 'conv-live' })
    assert.equal(r.status, 202)
    // boot is a readable FACT (a local status), never an absence the hub must guess
    assert.equal(((await manager.getSession('r-live')).body as any).status, 'creating')
    await manager.awaitSettled()
    const got = await manager.getSession('r-live')
    assert.equal(got.status, 200)
    assert.equal((got.body as any).status, 'running', 'creating → running once the loge reports it')
  } finally {
    await loge.close()
  }
})

test('resume resolution: loge already has the transcript -> forwarded untouched, no injection', async () => {
  const ip = allocLoopback()
  let received: any
  const loge = await startFakeServer((method, path, body) => {
    if (method === 'GET' && path === '/transcripts/u1') return { status: 200, contentType: 'application/x-ndjson', body: '{"line":1}\n' }
    if (method === 'POST' && path === '/sessions') {
      received = JSON.parse(body)
      return json(201, { id: 'r2', kind: 'claude', status: 'running' })
    }
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-2', ip))
    const manager = new Manager({ k8s, config: baseConfig(), readyPollMs: 5 })
    const result = await manager.spawn({ kind: 'claude', args: ['--resume', 'u1'], id: 'r2', group: 'conv-2' })
    assert.equal(result.status, 202)
    await manager.awaitSettled()
    assert.equal(received.transcript, undefined, 'loge-local transcript needs no injection')
  } finally {
    await loge.close()
  }
})

test('resume resolution: missing from the loge, found in the anchor store -> injected', async () => {
  const ip = allocLoopback()
  let received: any
  const loge = await startFakeServer((method, path, body) => {
    if (method === 'GET' && path === '/transcripts/u2') return json(404, { error: 'not found' })
    if (method === 'POST' && path === '/sessions') {
      received = JSON.parse(body)
      return json(201, { id: 'r3', kind: 'claude', status: 'running' })
    }
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  const anchorDir = mkdtempSync(join(tmpdir(), 'agent-runtime-anchors-'))
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(anchorDir, 'u2.jsonl'), '{"line":1}\n{"line":2}\n')
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-3', ip))
    const manager = new Manager({ k8s, config: baseConfig({ anchorDir }), readyPollMs: 5 })
    const result = await manager.spawn({ kind: 'claude', args: ['--resume', 'u2'], id: 'r3', group: 'conv-3' })
    assert.equal(result.status, 202)
    await manager.awaitSettled()
    assert.deepEqual(received.transcript, { sessionUuid: 'u2', content: '{"line":1}\n{"line":2}\n' })
  } finally {
    await loge.close()
    rmSync(anchorDir, { recursive: true, force: true })
  }
})

test('resume resolution: missing everywhere -> exited{anchor_transcript_missing}, loge kept', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'GET' && path === '/transcripts/u3') return json(404, { error: 'not found' })
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  const anchorDir = mkdtempSync(join(tmpdir(), 'agent-runtime-anchors-'))
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-4', ip))
    const manager = new Manager({ k8s, config: baseConfig({ anchorDir }), readyPollMs: 5 })
    const result = await manager.spawn({ kind: 'claude', args: ['--resume', 'u3'], id: 'r-u3', group: 'conv-4' })
    assert.equal(result.status, 202) // accepted; the failure surfaces as a READ status, not a sync 409
    await manager.awaitSettled()
    const got = await manager.getSession('r-u3')
    assert.equal(got.status, 200)
    assert.equal((got.body as any).status, 'exited')
    assert.equal((got.body as any).reason, 'anchor_transcript_missing', 'the hub maps this to its one-shot forceFresh')
    assert.equal(k8s.pods.has('loge-conv-4'), true, 'the loge itself is not torn down — the retry (forceFresh) reuses it')
  } finally {
    await loge.close()
    rmSync(anchorDir, { recursive: true, force: true })
  }
})

test('sweepOnce: a Failed loge is tombstoned (exited + exitCode) then deleted', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'POST' && path === '/sessions') return json(201, { id: 'r4', kind: 'claude', status: 'running' })
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-5', ip))
    const manager = new Manager({ k8s, config: baseConfig(), readyPollMs: 5 })
    const spawned = await manager.spawn({ kind: 'claude', args: [], id: 'r4', group: 'conv-5' })
    assert.equal(spawned.status, 202)
    await manager.awaitSettled() // loge up + run registered running before we fail its pod
    const runId = 'r4'

    const pod = k8s.pods.get('loge-conv-5')
    pod.status.phase = 'Failed'
    pod.status.containerStatuses = [{ name: 'supervisor', state: { terminated: { exitCode: 137 } } }]

    await manager.sweepOnce()

    assert.equal(k8s.pods.has('loge-conv-5'), false, 'the pod is deleted after tombstoning')
    const got = await manager.getSession(runId)
    assert.equal(got.status, 200)
    assert.equal((got.body as any).status, 'exited')
    assert.equal((got.body as any).exitCode, 137)
  } finally {
    await loge.close()
  }
})

test('sweepOnce: drains a lingered-out empty loge (transcripts land in ANCHOR_DIR)', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'POST' && path === '/sessions') return json(201, { id: 'r5', kind: 'claude', status: 'running' })
    if (method === 'GET' && path === '/sessions') return json(200, { sessions: [] }) // sweep sees it empty right away
    if (method === 'GET' && path === '/transcripts') return json(200, { uuids: ['u10', 'u11'] })
    if (method === 'GET' && path === '/transcripts/u10') return { status: 200, contentType: 'application/x-ndjson', body: 'content-10' }
    if (method === 'GET' && path === '/transcripts/u11') return { status: 200, contentType: 'application/x-ndjson', body: 'content-11' }
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  const anchorDir = mkdtempSync(join(tmpdir(), 'agent-runtime-anchors-'))
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-6', ip))
    const manager = new Manager({ k8s, config: baseConfig({ anchorDir, logeLingerMs: 10 }), readyPollMs: 5 })
    const r = await manager.spawn({ kind: 'claude', args: [], id: 'r5', group: 'conv-6' })
    assert.equal(r.status, 202)
    await manager.awaitSettled()

    await manager.sweepOnce() // sees 0 sessions -> sets lastEmptyAt
    assert.equal(k8s.pods.has('loge-conv-6'), true, 'still lingering, not drained yet')
    await sleep(20) // outlive the 10ms linger window
    await manager.sweepOnce() // now past the linger -> drain + delete

    assert.equal(k8s.pods.has('loge-conv-6'), false)
    assert.equal(readFileSync(join(anchorDir, 'u10.jsonl'), 'utf8'), 'content-10')
    assert.equal(readFileSync(join(anchorDir, 'u11.jsonl'), 'utf8'), 'content-11')
  } finally {
    await loge.close()
    rmSync(anchorDir, { recursive: true, force: true })
  }
})

test('bootReconcile: adopts Ready loge pods from a mocked pod list and their live sessions', async () => {
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path) => {
    if (method === 'GET' && path === '/sessions') return json(200, { sessions: [{ id: 'r6', kind: 'claude', status: 'running' }] })
    if (method === 'GET' && path === '/sessions/r6') return json(200, { id: 'r6', kind: 'claude', status: 'running' })
    return json(404, { error: 'not found' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'conv-7', ip))
    k8s.pods.set('loge-conv-7', readyLoge('loge-conv-7', 'conv-7', ip)) // pre-existing, as if from a previous manager incarnation
    const manager = new Manager({ k8s, config: baseConfig() })

    await manager.bootReconcile()

    const got = await manager.getSession('r6')
    assert.equal(got.status, 200)
    assert.deepEqual(got.body, { id: 'r6', kind: 'claude', status: 'running' })
  } finally {
    await loge.close()
  }
})

test('CreateGate: caps concurrent acquisitions, grants queued waiters FIFO on release', async () => {
  const gate = new CreateGate(2)
  const order: number[] = []
  let acquired = 0
  const p1 = gate.acquire().then(() => { acquired++; order.push(1) })
  const p2 = gate.acquire().then(() => { acquired++; order.push(2) })
  const p3 = gate.acquire().then(() => { acquired++; order.push(3) }) // 3rd requested, only 2 slots -> queues
  await sleep(20)
  assert.equal(acquired, 2, 'only maxConcurrentLogeCreates acquisitions run at once')

  gate.release()
  await p3
  assert.equal(acquired, 3)
  assert.deepEqual(order, [1, 2, 3])

  await p1
  await p2
})

test('deleteAnchor: removes the file; absent file is still a no-op success', async () => {
  const anchorDir = mkdtempSync(join(tmpdir(), 'agent-runtime-anchors-'))
  try {
    const { writeFileSync, existsSync } = await import('node:fs')
    writeFileSync(join(anchorDir, 'u9.jsonl'), '{}')
    const manager = new Manager({ k8s: new MockK8s((n) => readyLoge(n, 'g', '127.0.0.1')), config: baseConfig({ anchorDir }) })

    manager.deleteAnchor('u9')
    assert.equal(existsSync(join(anchorDir, 'u9.jsonl')), false)

    assert.doesNotThrow(() => manager.deleteAnchor('does-not-exist'))
  } finally {
    rmSync(anchorDir, { recursive: true, force: true })
  }
})

test('token dispossession: the loge holds a placeholder + proxy base-URL (never the secret); the proxy holds the real secret', () => {
  const config = baseConfig()
  const logeSpec = buildLogePodSpec('conv-z', config, 'http://10.0.0.9:8788') as any
  const logeEnv = logeSpec.spec.containers[0].env as Array<{ name: string; value?: string; valueFrom?: unknown }>
  const logeOauth = logeEnv.find((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN')!
  assert.equal(logeOauth.valueFrom, undefined, 'the loge must NOT mount the real token secret')
  assert.match(logeOauth.value ?? '', /^sk-ant-oat01-DISPOSSESSED/, 'the loge gets a worthless placeholder')
  assert.equal(
    logeEnv.find((e) => e.name === 'ANTHROPIC_BASE_URL')?.value,
    'http://10.0.0.9:8788',
    'the loge is pointed at the inference-proxy',
  )

  const proxySpec = buildProxyPodSpec(config) as any
  const proxyEnv = proxySpec.spec.containers[0].env as Array<{ name: string; value?: string; valueFrom?: any }>
  const proxyOauth = proxyEnv.find((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN')!
  assert.equal(proxyOauth.valueFrom?.secretKeyRef?.name, config.claudeOauthSecret, 'the REAL token lives ONLY in the proxy pod')
  assert.equal(proxyOauth.value, undefined)
  assert.equal(proxySpec.spec.runtimeClassName, 'sandboxed', 'agent-runs mandates gVisor for ALL pods (ADR 0027) — the proxy is sandboxed too')
  assert.equal(proxySpec.spec.containers[0].args?.join(' '), 'node dist/inference-proxy.js')
})
