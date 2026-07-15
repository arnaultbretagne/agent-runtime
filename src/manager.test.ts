import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Manager,
  CreateGate,
  buildLogePodSpec,
  buildProxyPodSpec,
  equipmentFromPod,
  sameEquipment,
  stripMintedEnv,
  mcpServersFor,
  withMcpServers,
  type ManagerConfig,
} from './manager.js'
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
    useBroker: false,
    brokerAdminUrl: 'http://127.0.0.1:1',
    brokerDataUrl: 'http://127.0.0.1:1',
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
    // A real API server echoes back the metadata it was sent. Keep the SPEC's labels/annotations so a
    // test reads what the manager actually asked for, not what the fixture invented.
    pod.metadata = {
      ...pod.metadata,
      ...spec.metadata,
      labels: { ...pod.metadata?.labels, ...spec.metadata?.labels },
      annotations: { ...pod.metadata?.annotations, ...spec.metadata?.annotations },
    }
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
  const logeSpec = buildLogePodSpec('conv-z', config, {
    oauthToken: 'sk-ant-oat01-DISPOSSESSED-test',
    baseUrl: 'http://10.0.0.9:8788',
    equipment: { profile: 'chat-v1', target: null },
  }) as any
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

test('broker mode (P3): the loge holds an opaque LEASE + the broker data plane, still never the real secret', () => {
  const config = baseConfig({ useBroker: true, brokerDataUrl: 'http://agent-broker.agent.svc:8788' })
  const spec = buildLogePodSpec('conv-b', config, {
    oauthToken: 'sk-ant-oat01-broker-LEASE123',
    baseUrl: 'http://agent-broker.agent.svc:8788',
    equipment: { profile: 'chat-v1', target: null },
    leaseId: 'lease_abc123',
  }) as any
  const env = spec.spec.containers[0].env as Array<{ name: string; value?: string; valueFrom?: unknown }>
  const oauth = env.find((e) => e.name === 'CLAUDE_CODE_OAUTH_TOKEN')!
  assert.equal(oauth.valueFrom, undefined, 'still no real-secret mount in the loge')
  assert.equal(oauth.value, 'sk-ant-oat01-broker-LEASE123', 'the loge holds the opaque lease, not the real token')
  assert.equal(env.find((e) => e.name === 'ANTHROPIC_BASE_URL')?.value, 'http://agent-broker.agent.svc:8788', 'pointed at the broker data plane')
})

/* ---------------------------------------------------------------- *
 *  P4 — equipment (agora ADR 0012)                                  *
 * ---------------------------------------------------------------- */

test('equipment rides on the loge pod: profile as a label, target/leaseId as annotations, never the token', () => {
  const spec = buildLogePodSpec('conv-e', baseConfig({ useBroker: true }), {
    oauthToken: 'sk-ant-oat01-broker-SECRETLEASE',
    baseUrl: 'http://broker:8788',
    equipment: { profile: 'repo-read-v1', target: 'github:arnaultbretagne/agora' },
    leaseId: 'lease_xyz',
  }) as any
  assert.equal(spec.metadata.labels['agora.bretagne.dev/profile'], 'repo-read-v1')
  assert.equal(spec.metadata.annotations['agora.bretagne.dev/target'], 'github:arnaultbretagne/agora')
  assert.equal(spec.metadata.annotations['agora.bretagne.dev/lease-id'], 'lease_xyz')
  // The pod's metadata is world-readable to anyone with pod-read in agent-runs. Only the leaseId may
  // appear there (plan §2.6) — never the bearer itself.
  assert.equal(JSON.stringify(spec.metadata).includes('SECRETLEASE'), false)
})

test('equipmentFromPod: a pre-P4 loge (no label) reads back as chat-v1 — the upgrade adopts it, never churns it', () => {
  assert.deepEqual(equipmentFromPod(readyLoge('loge-old', 'g-old', '127.0.0.1')), { profile: 'chat-v1', target: null })
  const equipped = {
    metadata: {
      labels: { 'agora.bretagne.dev/profile': 'repo-read-v1' },
      annotations: { 'agora.bretagne.dev/target': 'github:arnaultbretagne/agora' },
    },
  }
  assert.deepEqual(equipmentFromPod(equipped), { profile: 'repo-read-v1', target: 'github:arnaultbretagne/agora' })
})

test('sameEquipment: profile AND target both matter; absent and null target are the same thing', () => {
  const t = 'github:arnaultbretagne/agora'
  assert.equal(sameEquipment({ profile: 'chat-v1', target: null }, { profile: 'chat-v1', target: null }), true)
  assert.equal(sameEquipment({ profile: 'chat-v1', target: null }, { profile: 'vault-v1', target: null }), false)
  assert.equal(sameEquipment({ profile: 'repo-read-v1', target: t }, { profile: 'repo-read-v1', target: `${t}-x` }), false)
})

test('stripMintedEnv: a spawn body may not name its own credential or upstream (plan §2.6)', () => {
  const { env, dropped } = stripMintedEnv({
    CHANNEL_TOKEN: 'legit',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ATTACKER',
    anthropic_base_url: 'http://evil.example',
    AGENT_BROKER_TOKEN: 'stolen',
  })
  assert.deepEqual(env, { CHANNEL_TOKEN: 'legit' })
  assert.deepEqual(dropped.sort(), ['AGENT_BROKER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'anthropic_base_url'])
})

test('spawn: the manager is the final authority — an unknown or still-gated profile is refused (400)', async () => {
  const k8s = new MockK8s((name) => readyLoge(name, 'g', '127.0.0.1'))
  const manager = new Manager({ k8s, config: baseConfig() })

  const unknown = await manager.spawn({ kind: 'claude', id: 'r1', group: 'g', equipmentProfile: 'root-v1' })
  assert.equal(unknown.status, 400)
  assert.equal((unknown.body as any).error, 'unknown_profile')

  // The exact case a stale agora projection would produce: offered in the UI, refused here.
  // Fail-closed. repo-dev-vault-v1 is the only still-gated profile after P6.
  const gated = await manager.spawn({ kind: 'claude', id: 'r2', group: 'g', equipmentProfile: 'repo-dev-vault-v1' })
  assert.equal(gated.status, 400)
  assert.equal((gated.body as any).error, 'profile_disabled')

  const targeted = await manager.spawn({ kind: 'claude', id: 'r3', group: 'g', target: 'github:arnaultbretagne/agora' })
  assert.equal(targeted.status, 400)
  assert.equal((targeted.body as any).error, 'target_forbidden', 'chat-v1 takes no target')

  assert.equal(k8s.createCalls, 0, 'a refused profile must never provision anything')
})

test('spawn: credentialLease and minted env are refused, never forwarded to the loge (plan §2.6)', async () => {
  let received: any
  const ip = allocLoopback()
  const loge = await startFakeServer((method, path, body) => {
    if (method === 'POST' && path === '/sessions') {
      received = JSON.parse(body)
      return json(201, { id: 'r1', status: 'running' })
    }
    return json(404, { error: 'nf' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'g-inject', ip))
    const manager = new Manager({ k8s, config: baseConfig(), readyPollMs: 5 })
    await manager.spawn({
      kind: 'claude',
      id: 'r1',
      group: 'g-inject',
      args: [],
      env: { CHANNEL_TOKEN: 'legit', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ATTACKER-CHOSEN' },
      credentialLease: { id: 'lease_forged', token: 'sk-ant-oat01-broker-forged', brokerUrl: 'http://evil' },
    })
    await manager.awaitSettled()
    assert.deepEqual(received.env, { CHANNEL_TOKEN: 'legit' }, 'the minted env is stripped before forwarding')
    assert.equal(received.credentialLease, undefined, 'a forged lease never reaches the supervisor')
  } finally {
    await loge.close()
  }
})

test('equipment is part of a loge identity: re-equipping REPLACES the pod, drains it first, and revokes the old lease', async () => {
  const minted: any[] = []
  const revoked: string[] = []
  const broker = await startFakeServer((method, path, body) => {
    if (method === 'POST' && path === '/v1/leases') {
      minted.push(JSON.parse(body))
      return json(201, { leaseId: `lease_${minted.length}`, token: `sk-ant-oat01-broker-t${minted.length}` })
    }
    if (method === 'DELETE' && path.startsWith('/v1/leases/')) {
      revoked.push(path.slice('/v1/leases/'.length))
      return json(200, { revoked: true })
    }
    return json(404, { error: 'nf' })
  }, 0, '127.0.0.1')
  const ip = allocLoopback()
  let drains = 0
  const loge = await startFakeServer((method, path) => {
    if (method === 'GET' && path === '/transcripts') {
      drains++
      return json(200, { uuids: [] })
    }
    if (method === 'POST' && path === '/sessions') return json(201, { id: 'r1', status: 'running' })
    if (method === 'GET' && path === '/sessions') return json(200, { sessions: [] })
    return json(404, { error: 'nf' })
  }, LOGE_PORT, ip)
  try {
    const k8s = new MockK8s((name) => readyLoge(name, 'g-swap', ip))
    const manager = new Manager({
      k8s,
      config: baseConfig({ useBroker: true, brokerAdminUrl: broker.url, brokerDataUrl: 'http://broker:8788' }),
      readyPollMs: 5,
    })
    await manager.spawn({ kind: 'claude', id: 'r1', group: 'g-swap', args: [] })
    await manager.awaitSettled()
    assert.equal(k8s.createCalls, 1)
    assert.deepEqual(minted[0], { runId: 'g-swap', profile: 'chat-v1' }, 'no profile named -> the chat floor')

    // vault-v1 is deliberately still gated OFF, so spawn() would (correctly) 400 long before this
    // path. Drive the loge layer directly: the swap mechanism has to be PROVEN right BEFORE P5 opens
    // that gate — a loge silently keeping `vault:full` under a run journaled `chat-v1` is exactly the
    // failure this palier exists to prevent.
    const next = await (manager as any).getOrCreateLoge('g-swap', { profile: 'vault-v1', target: null })
    assert.ok(!('error' in next), 'the re-equipped loge must come up')
    assert.equal(k8s.createCalls, 2, 'the pod is REPLACED — a lease is frozen at mint, a pod env at creation')
    assert.deepEqual(minted[1], { runId: 'g-swap', profile: 'vault-v1' })
    assert.deepEqual(revoked, ['lease_1'], "the old equipment's lease dies with its loge")
    assert.equal(drains, 1, 'drained BEFORE the swap: changing equipment must not silently reset the history')
    assert.equal(k8s.pods.get('loge-g-swap').metadata.labels['agora.bretagne.dev/profile'], 'vault-v1')

    // ...and the same equipment reuses, so an ordinary next turn stays warm.
    const again = await (manager as any).getOrCreateLoge('g-swap', { profile: 'vault-v1', target: null })
    assert.ok(!('error' in again))
    assert.equal(k8s.createCalls, 2, 'same equipment -> plain reuse, no churn')
    assert.equal(minted.length, 2)
  } finally {
    await loge.close()
    await broker.close()
  }
})

test('broker mode: the loge gets the SAME opaque lease under the broker names, and still no real secret', () => {
  const config = baseConfig({ useBroker: true, brokerDataUrl: 'http://agent-broker.agent.svc:8788' })
  const spec = buildLogePodSpec('conv-v', config, {
    oauthToken: 'sk-ant-oat01-broker-LEASE456',
    baseUrl: 'http://agent-broker.agent.svc:8788',
    equipment: { profile: 'vault-v1', target: null },
    leaseId: 'lease_v',
    brokerUrl: 'http://agent-broker.agent.svc:8788',
  }) as any
  const env = spec.spec.containers[0].env as Array<{ name: string; value?: string }>
  const get = (n: string) => env.find((e) => e.name === n)?.value
  // One bearer, three names: Claude Code reads CLAUDE_CODE_OAUTH_TOKEN, the MCP config reads
  // AGENT_BROKER_TOKEN. Same worthless lease — the broker decides what it means, not its name.
  assert.equal(get('AGENT_BROKER_TOKEN'), 'sk-ant-oat01-broker-LEASE456')
  assert.equal(get('CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-broker-LEASE456')
  assert.equal(get('AGENT_BROKER_URL'), 'http://agent-broker.agent.svc:8788')
  // Nothing in the loge is a real credential.
  assert.equal(env.some((e) => (e.value ?? '').includes('sk-ant-oat01-broker-') === false && /sk-ant-oat01-[A-Za-z0-9]{20}/.test(e.value ?? '')), false)
})

test('inference-proxy mode: no AGENT_BROKER_* at all — there is no broker on that path', () => {
  const spec = buildLogePodSpec('conv-p', baseConfig(), {
    oauthToken: 'sk-ant-oat01-DISPOSSESSED-x',
    baseUrl: 'http://10.0.0.9:8788',
    equipment: { profile: 'chat-v1', target: null },
  }) as any
  const env = spec.spec.containers[0].env as Array<{ name: string }>
  assert.equal(env.some((e) => e.name.startsWith('AGENT_BROKER_')), false)
})

test('the vault MCP server is attached ONLY to a profile that carries vault:full', () => {
  assert.equal(mcpServersFor({ profile: 'chat-v1', target: null }), undefined, 'chat gets no vault server at all')
  assert.equal(mcpServersFor({ profile: 'root-v1', target: null }), undefined, 'an unknown profile unlocks nothing')
  const vault = mcpServersFor({ profile: 'vault-v1', target: null })
  assert.ok(vault)
  const cfg = JSON.parse(vault.config)
  assert.equal(cfg.mcpServers.vault.type, 'http')
  // The loge is pointed at the BROKER, never at the vault itself (plan §P5.4).
  assert.equal(cfg.mcpServers.vault.url, '${AGENT_BROKER_URL}/v1/vault/mcp')
  assert.equal(cfg.mcpServers.vault.url.includes('vault.bretagne.dev'), false)
  // The bearer is NAMED, not embedded: Claude Code expands it, so it never hits argv where a `ps`
  // inside the loge would read it off its own supervisor's command line.
  assert.equal(cfg.mcpServers.vault.headers.Authorization, 'Bearer ${AGENT_BROKER_TOKEN}')
  assert.equal(/sk-ant/.test(vault.config), false)
})

test('withMcpServers EXTENDS --allowedTools; it never adds a second one that could drop the channel', () => {
  const base = ['--session-id', 'u1', '--channels', 'plugin:agora@agora', '--allowedTools', 'mcp__plugin_agora_agora__reply', '--dangerously-skip-permissions']
  const out = withMcpServers(base, { profile: 'vault-v1', target: null }) as string[]

  assert.equal(out.filter((a) => a === '--allowedTools').length, 1, 'exactly one --allowedTools, or last-wins eats the channel')
  const tools = out[out.indexOf('--allowedTools') + 1]
  assert.equal(tools, 'mcp__plugin_agora_agora__reply,mcp__vault__*')
  assert.ok(tools.includes('mcp__plugin_agora_agora__reply'), 'a loge that cannot reply is a run that hangs')
  assert.ok(out.includes('--mcp-config'))
  // Not strict: whether it also kills the plugin-provided channel server is undocumented, and the
  // channel is what makes a run work at all.
  assert.equal(out.includes('--strict-mcp-config'), false)
  assert.equal(base.includes('--mcp-config'), false, "the caller's array is not mutated")
})

test('withMcpServers leaves a chat spawn byte-for-byte untouched', () => {
  const base = ['--session-id', 'u1', '--allowedTools', 'mcp__plugin_agora_agora__reply']
  assert.deepEqual(withMcpServers(base, { profile: 'chat-v1', target: null }), base)
})
