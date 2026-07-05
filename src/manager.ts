import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { K8sClient, type K8sPods, type HttpError } from './k8s.js'
import { KNOWN_KINDS, isKnownKind } from './runtimes.js'
import { getCapabilities } from './capabilities.js'

/**
 * The manager (agent-runtime ADR 0010 §1.1/§1.3): a superset of the supervisor's own control API.
 * `shared` spawns proxy verbatim to the shared supervisor; `isolated` spawns get-or-create a
 * sandboxed per-group pod (a "loge") in AGENT_RUNS_NS via the Kubernetes API and forward there.
 * The manager holds the only ServiceAccount in `agent` (pod CRUD in agent-runs, nothing else).
 */

export interface ManagerConfig {
  port: number
  sharedSupervisorUrl: string
  agentRunsNs: string
  logeImage: string
  channelImage: string
  logeLingerMs: number
  maxConcurrentLogeCreates: number
  logeReadyTimeoutMs: number
  anchorDir: string
  anchorTtlDays: number
  sweepIntervalMs: number
  claudeOauthSecret: string
}

export function configFromEnv(env: NodeJS.ProcessEnv): ManagerConfig {
  const logeImage = env.LOGE_IMAGE
  if (!logeImage) throw new Error('LOGE_IMAGE is required (digest-pinned loge image)')
  return {
    port: Number(env.PORT ?? 8080),
    sharedSupervisorUrl: env.SHARED_SUPERVISOR_URL ?? 'http://agent:8080',
    agentRunsNs: env.AGENT_RUNS_NS ?? 'agent-runs',
    logeImage,
    channelImage: env.CHANNEL_IMAGE ?? 'ghcr.io/arnaultbretagne/agora-website:latest',
    logeLingerMs: Number(env.LOGE_LINGER_MS ?? 120_000),
    maxConcurrentLogeCreates: Number(env.MAX_CONCURRENT_LOGE_CREATES ?? 2),
    logeReadyTimeoutMs: Number(env.LOGE_READY_TIMEOUT_MS ?? 90_000),
    anchorDir: env.ANCHOR_DIR ?? '/anchors',
    anchorTtlDays: Number(env.ANCHOR_TTL_DAYS ?? 30),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 30_000),
    claudeOauthSecret: env.CLAUDE_OAUTH_SECRET ?? 'claude-oauth-token',
  }
}

/** The loge pod template (agent-runtime ADR 0010 §6 / infra-k8s ADR 0028 §3) — pinned here as the
 *  single source of truth; the plan's yaml is the spec this must match. */
export function buildLogePodSpec(group: string, config: ManagerConfig): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `loge-${group}`,
      labels: { app: 'loge', 'agora.bretagne.dev/group': group },
    },
    spec: {
      restartPolicy: 'Never',
      runtimeClassName: 'sandboxed',
      automountServiceAccountToken: false,
      // runAsNonRoot at pod level so it covers every container uniformly (PSA `restricted`
      // requires it explicitly true somewhere for EACH container — a real rejection hit live
      // 2026-07-05: the initContainers didn't set it and agent-runs enforces restricted from
      // birth, unlike the Phase V verrou namespace which was deliberately unlabelled).
      securityContext: { fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' }, runAsNonRoot: true },
      initContainers: [
        {
          name: 'fetch-channel',
          image: config.channelImage,
          command: ['sh', '-c', 'cp -r /opt/agora/. /channel-src/'],
          volumeMounts: [{ name: 'channel-src', mountPath: '/channel-src' }],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        },
        {
          name: 'seed',
          image: config.logeImage,
          command: [
            'sh',
            '-c',
            'set -e\n' +
              'if [ ! -d "$HOME/.claude/plugins/cache/agora" ]; then\n' +
              '  echo "installing agora channel plugin"\n' +
              '  claude plugin marketplace add /channel-src\n' +
              '  claude plugin install agora@agora\n' +
              'else\n' +
              '  echo "agora plugin already installed — keeping"\n' +
              'fi\n',
          ],
          env: [{ name: 'HOME', value: '/home/node' }],
          volumeMounts: [
            { name: 'claude', mountPath: '/home/node/.claude' },
            { name: 'channel-src', mountPath: '/channel-src' },
          ],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        },
      ],
      containers: [
        {
          name: 'supervisor',
          image: config.logeImage,
          ports: [{ containerPort: 8080 }],
          env: [
            { name: 'PORT', value: '8080' },
            { name: 'HOST', value: '0.0.0.0' },
            { name: 'RUNTIME_CWD', value: '/home/node/work' },
            { name: 'PTY_LOG_DIR', value: '/logs' },
            {
              name: 'CLAUDE_CODE_OAUTH_TOKEN',
              valueFrom: { secretKeyRef: { name: config.claudeOauthSecret, key: 'token' } },
            },
            { name: 'DISABLE_AUTOUPDATER', value: '1' },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsNonRoot: true,
          },
          resources: {
            requests: { cpu: '100m', memory: '320Mi' },
            limits: { cpu: '1', memory: '1536Mi' },
          },
          readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 2 },
          volumeMounts: [
            { name: 'claude', mountPath: '/home/node/.claude' },
            { name: 'channel-src', mountPath: '/channel-src', readOnly: true },
            { name: 'logs', mountPath: '/logs' },
          ],
        },
      ],
      volumes: [
        { name: 'claude', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'channel-src', emptyDir: {} },
        { name: 'logs', emptyDir: {} },
      ],
    },
  }
}

/** How long an exited run stays reported as a tombstone, mirroring the supervisor's EXITED_TTL_MS
 *  (agent-runtime ADR 0009) so the hub's poll reliably reads the exit code before it disappears. */
const EXITED_TOMBSTONE_MS = 60_000

interface LogeEntry {
  podName: string
  lastEmptyAt?: number
}

type RunLocation = { where: 'shared' } | { where: 'loge'; podName: string; group: string }

interface Tombstone {
  status: 'exited'
  exitCode?: number
  expiresAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Bounds concurrent loge *creations* only — reusing an existing loge never queues (ADR 0010 §5,
 *  the 2026-07-04 thundering-herd lesson). FIFO: waiters are granted slots in arrival order. */
export class CreateGate {
  private inFlight = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.inFlight++
  }

  release(): void {
    this.inFlight--
    const next = this.queue.shift()
    if (next) next()
  }
}

export interface ManagerDeps {
  k8s: K8sPods
  config: ManagerConfig
  /** Poll interval while waiting for a fresh pod's Ready condition. Defaults to 1s (§1.3); tests
   *  override it to keep the suite fast. */
  readyPollMs?: number
}

export class Manager {
  private readonly runLocations = new Map<string, RunLocation>()
  private readonly loges = new Map<string, LogeEntry>()
  private readonly tombstones = new Map<string, Tombstone>()
  private readonly createGate: CreateGate
  private readonly readyPollMs: number

  constructor(private readonly deps: ManagerDeps) {
    this.createGate = new CreateGate(deps.config.maxConcurrentLogeCreates)
    this.readyPollMs = deps.readyPollMs ?? 1000
  }

  /** Boot reconcile (§1.3): list loge pods, adopt every Ready one by reading its live sessions.
   *  The manager is jetable — a restart kills no loge, this rebuilds both maps from the cluster. */
  async bootReconcile(): Promise<void> {
    const pods = await this.deps.k8s.listPods('app=loge')
    for (const pod of pods) {
      const group = pod.metadata?.labels?.['agora.bretagne.dev/group']
      const podName = pod.metadata?.name
      if (!group || !podName || !this.isReady(pod)) continue
      this.loges.set(group, { podName })
      try {
        const sessions = await this.fetchLogeSessions(pod.status.podIP)
        for (const s of sessions) this.runLocations.set(s.id, { where: 'loge', podName, group })
      } catch {
        /* unreachable right now — the next sweep will reconcile it */
      }
    }
  }

  /** POST /sessions — routes by substrate (default 'shared'). */
  async spawn(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const substrate = (body.substrate as string | undefined) ?? 'shared'
    if (substrate !== 'shared' && substrate !== 'isolated') {
      return { status: 400, body: { error: `invalid substrate: ${String(substrate)}` } }
    }
    const { substrate: _s, group: rawGroup, ...forwarded } = body

    if (substrate === 'shared') {
      const result = await this.forwardSpawn(this.deps.config.sharedSupervisorUrl, forwarded)
      this.rememberSpawnLocation(result, { where: 'shared' })
      return result
    }

    const group = rawGroup as string | undefined
    if (typeof group !== 'string' || !group) {
      return { status: 400, body: { error: '`group` is required for substrate=isolated' } }
    }
    const loge = await this.getOrCreateLoge(group)
    if ('error' in loge) return { status: 503, body: { error: loge.error } }

    const resumeUuid = this.extractResumeUuid(forwarded.args)
    if (resumeUuid) {
      const resolved = await this.resolveResumeTranscript(loge.podIp, resumeUuid)
      if (resolved === undefined) return { status: 409, body: { error: 'anchor_transcript_missing' } }
      if (resolved !== null) forwarded.transcript = { sessionUuid: resumeUuid, content: resolved }
    }

    const result = await this.forwardSpawn(`http://${loge.podIp}:8080`, forwarded)
    this.rememberSpawnLocation(result, { where: 'loge', podName: loge.podName, group })
    return result
  }

  /** Resolution order (§1.1): loge-local (pod-reuse case, nothing to inject) > the manager's own
   *  anchor store (inject) > missing everywhere (null = 409, distinct from "found, no injection needed"). */
  private async resolveResumeTranscript(podIp: string, uuid: string): Promise<string | null | undefined> {
    const local = await this.fetchLogeTranscript(podIp, uuid)
    if (local !== undefined) return null
    const anchored = this.readAnchor(uuid)
    return anchored !== undefined ? anchored : undefined
  }

  private rememberSpawnLocation(result: { status: number; body: unknown }, loc: RunLocation): void {
    if (result.status < 200 || result.status >= 300) return
    const id = (result.body as { id?: string } | undefined)?.id
    if (id) this.runLocations.set(id, loc)
  }

  private extractResumeUuid(args: unknown): string | undefined {
    if (!Array.isArray(args)) return undefined
    const idx = args.indexOf('--resume')
    return idx >= 0 && typeof args[idx + 1] === 'string' ? (args[idx + 1] as string) : undefined
  }

  private async getOrCreateLoge(
    group: string,
  ): Promise<{ podName: string; podIp: string } | { error: 'quota_exceeded' }> {
    const existing = this.loges.get(group)
    if (existing) {
      const pod = await this.deps.k8s.getPod(existing.podName)
      const ip = pod?.status?.podIP
      if (pod && ip && this.isReady(pod)) return { podName: existing.podName, podIp: ip }
      this.loges.delete(group) // stale entry (pod gone/unready) — fall through and recreate
    }

    await this.createGate.acquire()
    try {
      const podName = `loge-${group}`
      const spec = buildLogePodSpec(group, this.deps.config)
      let pod: any
      try {
        pod = await this.deps.k8s.createPod(spec)
      } catch (err) {
        if ((err as HttpError).status === 409) {
          pod = await this.deps.k8s.getPod(podName) // AlreadyExists — adopt it
        } else {
          // Incident 2026-07-05: this used to swallow the real reason (here, a PSA rejection —
          // the initContainers didn't set runAsNonRoot, invisible in the Phase V verrou
          // namespace which had no PSA). quota_exceeded is still the contract (ADR 0010 §1.1 —
          // any pod-creation failure buckets here), but the operator needs the real cause logged.
          console.error(`[manager] createPod failed for ${podName}:`, (err as HttpError).status, (err as Error).message, (err as HttpError).body)
          return { error: 'quota_exceeded' }
        }
      }
      const ready = await this.waitReady(podName)
      if (!ready) {
        console.error(`[manager] ${podName} never became Ready within logeReadyTimeoutMs`)
        await this.deps.k8s.deletePod(podName).catch(() => {})
        return { error: 'quota_exceeded' }
      }
      this.loges.set(group, { podName })
      return { podName, podIp: ready.status.podIP }
    } finally {
      this.createGate.release()
    }
  }

  private async waitReady(podName: string): Promise<any | undefined> {
    const deadline = Date.now() + this.deps.config.logeReadyTimeoutMs
    for (;;) {
      const pod = await this.deps.k8s.getPod(podName)
      if (pod && this.isReady(pod)) return pod
      if (Date.now() >= deadline) return undefined
      await sleep(this.readyPollMs)
    }
  }

  private isReady(pod: any): boolean {
    const conditions = pod?.status?.conditions ?? []
    return conditions.some((c: any) => c.type === 'Ready' && c.status === 'True')
  }

  /** One sweep pass (§1.3) — called on an interval by the bootstrap. */
  async sweepOnce(): Promise<void> {
    const now = Date.now()
    for (const [group, loge] of [...this.loges]) {
      const pod = await this.deps.k8s.getPod(loge.podName)
      if (!pod) {
        this.loges.delete(group)
        continue
      }
      const phase = pod.status?.phase
      if (phase === 'Failed' || phase === 'Succeeded') {
        this.tombstoneRunsFor(loge.podName, this.extractExitCode(pod), now)
        await this.deps.k8s.deletePod(loge.podName).catch(() => {})
        this.forgetRunsFor(loge.podName)
        this.loges.delete(group)
        continue
      }
      if (phase === 'Pending') {
        const createdAt = new Date(pod.metadata?.creationTimestamp ?? now).getTime()
        if (now - createdAt > this.deps.config.logeReadyTimeoutMs) {
          await this.deps.k8s.deletePod(loge.podName).catch(() => {})
          this.forgetRunsFor(loge.podName)
          this.loges.delete(group)
        }
        continue
      }
      if (!this.isReady(pod)) continue
      const podIp = pod.status?.podIP
      let sessionCount: number
      try {
        const sessions = await this.fetchLogeSessions(podIp)
        sessionCount = sessions.length
        for (const s of sessions) this.runLocations.set(s.id, { where: 'loge', podName: loge.podName, group })
      } catch {
        continue // unreachable this tick — try again next sweep
      }
      if (sessionCount === 0) {
        if (loge.lastEmptyAt === undefined) {
          loge.lastEmptyAt = now
        } else if (now - loge.lastEmptyAt > this.deps.config.logeLingerMs) {
          await this.drainLoge(loge.podName, podIp)
          await this.deps.k8s.deletePod(loge.podName).catch(() => {})
          this.forgetRunsFor(loge.podName)
          this.loges.delete(group)
        }
      } else {
        loge.lastEmptyAt = undefined
      }
    }
    this.gcExpiredTombstones(now)
    this.gcOldAnchors(now)
  }

  private tombstoneRunsFor(podName: string, exitCode: number | undefined, now: number): void {
    for (const [runId, loc] of this.runLocations) {
      if (loc.where === 'loge' && loc.podName === podName) {
        this.tombstones.set(runId, { status: 'exited', exitCode, expiresAt: now + EXITED_TOMBSTONE_MS })
      }
    }
  }

  private forgetRunsFor(podName: string): void {
    for (const [runId, loc] of this.runLocations) {
      if (loc.where === 'loge' && loc.podName === podName) this.runLocations.delete(runId)
    }
  }

  private gcExpiredTombstones(now: number): void {
    for (const [id, tomb] of this.tombstones) if (tomb.expiresAt <= now) this.tombstones.delete(id)
  }

  private extractExitCode(pod: any): number | undefined {
    const statuses = pod.status?.containerStatuses ?? []
    const supervisor = statuses.find((c: any) => c.name === 'supervisor')
    return supervisor?.state?.terminated?.exitCode
  }

  /** Drain (§1.3): pull every transcript a dying loge holds onto the manager's own anchor store,
   *  tmp+rename so a crash mid-write never leaves a half-written anchor. Best-effort: an
   *  unreachable loge loses its transcripts since birth (accepted, ADR 0010 §5). */
  private async drainLoge(podName: string, podIp: string): Promise<void> {
    let uuids: string[]
    try {
      const res = await fetch(`http://${podIp}:8080/transcripts`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return
      uuids = ((await res.json()) as { uuids?: string[] }).uuids ?? []
    } catch {
      return
    }
    for (const uuid of uuids) {
      const content = await this.fetchLogeTranscript(podIp, uuid)
      if (content !== undefined) this.writeAnchor(uuid, content)
    }
  }

  private async fetchLogeSessions(podIp: string): Promise<Array<{ id: string; [k: string]: unknown }>> {
    const res = await fetch(`http://${podIp}:8080/sessions`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) throw new Error(`loge /sessions -> ${res.status}`)
    const data = (await res.json()) as { sessions?: Array<{ id: string }> }
    return data.sessions ?? []
  }

  private async fetchLogeTranscript(podIp: string, uuid: string): Promise<string | undefined> {
    try {
      const res = await fetch(`http://${podIp}:8080/transcripts/${uuid}`, { signal: AbortSignal.timeout(1500) })
      return res.ok ? await res.text() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Incident 2026-07-05: this used to catch-all into a fake `503 quota_exceeded`, which masked a
   * CNP gap (the shared supervisor's ingress didn't yet allow the manager) as if it were a loge
   * quota problem. `quota_exceeded` means specifically "couldn't create/ready a loge pod"
   * (getOrCreateLoge) — a forwarding failure here is a distinct, honest 502.
   */
  private async forwardSpawn(baseUrl: string, payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    try {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => undefined)
      return { status: res.status, body }
    } catch (err) {
      return { status: 502, body: { error: 'spawn_forward_failed', detail: (err as Error).message } }
    }
  }

  private writeAnchor(uuid: string, content: string): void {
    mkdirSync(this.deps.config.anchorDir, { recursive: true })
    const tmp = join(this.deps.config.anchorDir, `.${uuid}.jsonl.tmp`)
    const final = join(this.deps.config.anchorDir, `${uuid}.jsonl`)
    writeFileSync(tmp, content)
    renameSync(tmp, final)
  }

  private readAnchor(uuid: string): string | undefined {
    try {
      return readFileSync(join(this.deps.config.anchorDir, `${uuid}.jsonl`), 'utf8')
    } catch {
      return undefined
    }
  }

  deleteAnchor(uuid: string): void {
    try {
      unlinkSync(join(this.deps.config.anchorDir, `${uuid}.jsonl`))
    } catch {
      /* absent is fine — the caller always sees success */
    }
  }

  private gcOldAnchors(now: number): void {
    let files: string[]
    try {
      files = readdirSync(this.deps.config.anchorDir)
    } catch {
      return
    }
    const ttlMs = this.deps.config.anchorTtlDays * 24 * 60 * 60 * 1000
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(this.deps.config.anchorDir, f)
      try {
        if (now - statSync(p).mtimeMs > ttlMs) unlinkSync(p)
      } catch {
        /* raced with something else removing it — fine */
      }
    }
  }

  /** GET /sessions — merges shared + every loge (parallel, 1.5s timeout each) + tombstones. */
  async listAllSessions(): Promise<unknown[]> {
    const results: unknown[] = []
    try {
      const res = await fetch(`${this.deps.config.sharedSupervisorUrl}/sessions`)
      if (res.ok) results.push(...(((await res.json()) as { sessions?: unknown[] }).sessions ?? []))
    } catch {
      /* shared unreachable — best effort, matches the hub's existing tolerance of a 404/gap */
    }
    await Promise.all(
      [...this.loges.values()].map(async (loge) => {
        const pod = await this.deps.k8s.getPod(loge.podName)
        const ip = pod?.status?.podIP
        if (!ip) return
        try {
          results.push(...(await this.fetchLogeSessions(ip)))
        } catch {
          /* timeout/unreachable this round — skip, next GET /sessions retries */
        }
      }),
    )
    for (const [id, tomb] of this.tombstones) {
      results.push({ id, status: tomb.status, exitCode: tomb.exitCode })
    }
    return results
  }

  async getSession(id: string): Promise<{ status: number; body: unknown }> {
    const tomb = this.tombstones.get(id)
    if (tomb) return { status: 200, body: { id, status: tomb.status, exitCode: tomb.exitCode } }
    const loc = this.runLocations.get(id)
    if (!loc) return { status: 404, body: { error: 'not found' } }
    const base = await this.baseUrlFor(loc)
    if (!base) return { status: 404, body: { error: 'not found' } }
    const res = await fetch(`${base}/sessions/${id}`)
    return { status: res.status, body: await res.json().catch(() => undefined) }
  }

  async touch(id: string): Promise<{ status: number; body: unknown }> {
    const loc = this.runLocations.get(id)
    if (!loc) return { status: 404, body: { id, touched: false } }
    const base = await this.baseUrlFor(loc)
    if (!base) return { status: 404, body: { id, touched: false } }
    const res = await fetch(`${base}/sessions/${id}/touch`, { method: 'POST' })
    return { status: res.status, body: await res.json().catch(() => undefined) }
  }

  async deleteSession(id: string): Promise<{ status: number; body: unknown }> {
    const loc = this.runLocations.get(id)
    if (!loc) return { status: 404, body: { id, killed: false } }
    const base = await this.baseUrlFor(loc)
    if (base) {
      const res = await fetch(`${base}/sessions/${id}`, { method: 'DELETE' })
      if (res.ok) this.runLocations.delete(id)
      return { status: res.status, body: await res.json().catch(() => undefined) }
    }
    this.runLocations.delete(id)
    return { status: 404, body: { id, killed: false } }
  }

  private async baseUrlFor(loc: RunLocation): Promise<string | undefined> {
    if (loc.where === 'shared') return this.deps.config.sharedSupervisorUrl
    const pod = await this.deps.k8s.getPod(loc.podName)
    const ip = pod?.status?.podIP
    return ip ? `http://${ip}:8080` : undefined
  }
}

export function createManagerServer(manager: Manager) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const method = req.method ?? 'GET'

      if (path === '/healthz') return send(res, 200, { ok: true })
      if (path === '/kinds' && method === 'GET') return send(res, 200, { kinds: KNOWN_KINDS })

      const capsMatch = path.match(/^\/kinds\/([^/]+)\/capabilities$/)
      if (capsMatch && method === 'GET') {
        const kind = decodeURIComponent(capsMatch[1])
        if (!isKnownKind(kind)) return send(res, 404, { error: `unknown kind: ${kind}` })
        return send(res, 200, await getCapabilities(kind))
      }

      if (path === '/sessions') {
        if (method === 'GET') return send(res, 200, { sessions: await manager.listAllSessions() })
        if (method === 'POST') {
          const body = await readJson(req)
          const result = await manager.spawn(body)
          return send(res, result.status, result.body)
        }
        return send(res, 405, { error: 'method not allowed' })
      }

      const touchMatch = path.match(/^\/sessions\/([^/]+)\/touch$/)
      if (touchMatch) {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const result = await manager.touch(decodeURIComponent(touchMatch[1]))
        return send(res, result.status, result.body)
      }

      const sessionMatch = path.match(/^\/sessions\/([^/]+)$/)
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1])
        if (method === 'GET') {
          const result = await manager.getSession(id)
          return send(res, result.status, result.body)
        }
        if (method === 'DELETE') {
          const result = await manager.deleteSession(id)
          return send(res, result.status, result.body)
        }
        return send(res, 405, { error: 'method not allowed' })
      }

      const anchorMatch = path.match(/^\/anchors\/([^/]+)$/)
      if (anchorMatch) {
        if (method !== 'DELETE') return send(res, 405, { error: 'method not allowed' })
        manager.deleteAnchor(decodeURIComponent(anchorMatch[1]))
        res.writeHead(204)
        return res.end()
      }

      return send(res, 404, { error: 'not found' })
    } catch (err) {
      return send(res, 500, { error: (err as Error).message })
    }
  })
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

// Entry point (dist/manager.js, per package.json's start:manager) — guarded so importing this
// module for its exports (tests) never binds a port or starts the sweep loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv(process.env)
  const manager = new Manager({ k8s: new K8sClient(config.agentRunsNs), config })
  await manager.bootReconcile()
  setInterval(() => manager.sweepOnce().catch((e) => console.error('[manager] sweep failed:', e)), config.sweepIntervalMs).unref()
  createManagerServer(manager).listen(config.port, '0.0.0.0', () => {
    console.log(`[manager] listening on 0.0.0.0:${config.port}`)
  })
}
