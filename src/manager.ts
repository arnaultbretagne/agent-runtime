import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { K8sClient, type K8sPods, type HttpError } from './k8s.js'
import { KNOWN_KINDS, isKnownKind } from './runtimes.js'
import { getCapabilities } from './capabilities.js'
import { DEFAULT_PROFILE, checkProfileTarget } from './broker/profiles.js'

/**
 * The manager (agent-runtime ADR 0010 §1.1/§1.3): a superset of the supervisor's own control API.
 * `shared` spawns proxy verbatim to the shared supervisor; `isolated` spawns get-or-create a
 * sandboxed per-group pod (a "loge") in AGENT_RUNS_NS via the Kubernetes API and forward there.
 * The manager holds the only ServiceAccount in `agent` (pod CRUD in agent-runs, nothing else).
 */

export interface ManagerConfig {
  port: number
  /** Deployment substrate, baked deterministically in configFromEnv — never a spawn-body field. */
  substrate: 'isolated' | 'shared'
  sharedSupervisorUrl: string
  agentRunsNs: string
  logeImage: string
  logeLingerMs: number
  maxConcurrentLogeCreates: number
  logeReadyTimeoutMs: number
  anchorDir: string
  anchorTtlDays: number
  sweepIntervalMs: number
  claudeOauthSecret: string
  /** Port the inference-proxy listens on; loges reach it at http://<proxy-ip>:<proxyPort>. */
  proxyPort: number
  /** Account UUID the inference-proxy fills into the request body ('' → it resolves via profile). */
  accountUuid: string
  /** Broker migration (P3): when true, a new loge gets a per-loge broker LEASE (not the inference-proxy
   *  placeholder) and points at the broker data plane. The proxy path stays for old loges + rollback
   *  (flip this off). */
  useBroker: boolean
  brokerAdminUrl: string
  brokerDataUrl: string
}

export function configFromEnv(env: NodeJS.ProcessEnv): ManagerConfig {
  const logeImage = env.LOGE_IMAGE
  if (!logeImage) throw new Error('LOGE_IMAGE is required (digest-pinned loge image)')
  return {
    port: Number(env.PORT ?? 8080),
    // Baked deterministically, NOT from env: shared vs isolated provision differently (a shared
    // pod+PVC vs per-conv loges), so switching is a deliberate code+deploy change — never a runtime
    // knob, never a per-request payload. Today: isolated. Flip here to route to the shared pod.
    substrate: 'isolated',
    sharedSupervisorUrl: env.SHARED_SUPERVISOR_URL ?? 'http://agent:8080',
    agentRunsNs: env.AGENT_RUNS_NS ?? 'agent-runs',
    logeImage,
    logeLingerMs: Number(env.LOGE_LINGER_MS ?? 120_000),
    maxConcurrentLogeCreates: Number(env.MAX_CONCURRENT_LOGE_CREATES ?? 2),
    logeReadyTimeoutMs: Number(env.LOGE_READY_TIMEOUT_MS ?? 90_000),
    anchorDir: env.ANCHOR_DIR ?? '/anchors',
    anchorTtlDays: Number(env.ANCHOR_TTL_DAYS ?? 30),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 30_000),
    claudeOauthSecret: env.CLAUDE_OAUTH_SECRET ?? 'claude-oauth-token',
    proxyPort: Number(env.PROXY_PORT ?? 8788),
    accountUuid: env.ANTHROPIC_ACCOUNT_UUID ?? '',
    useBroker: env.USE_BROKER === 'true',
    brokerAdminUrl: env.BROKER_ADMIN_URL ?? 'http://agent-broker.agent.svc.cluster.local:8789',
    brokerDataUrl: env.BROKER_DATA_URL ?? 'http://agent-broker.agent.svc.cluster.local:8788',
  }
}

/** The loge's supervisor runs in subscription-LOGIN mode — enough for claude to emit the
 *  `anthropic-beta: …,oauth-2025-04-20` capability the upstream requires — but with a WORTHLESS token.
 *  The real one is injected by the inference-proxy. Any well-shaped `sk-ant-oat…` value works; this
 *  one is unmistakably a placeholder so a leak is obviously inert. */
const PLACEHOLDER_OAUTH_TOKEN =
  'sk-ant-oat01-DISPOSSESSED-loge-holds-no-real-token-injected-by-inference-proxy-000000000000-AA'

/** The singleton inference-proxy pod's name (agent-runs). The manager owns its lifecycle. */
export const PROXY_POD_NAME = 'inference-proxy'

/** What a run is equipped with (agora ADR 0012): a catalogue profile, plus a target for repo
 *  profiles. Frozen into the run by agora; re-validated here, which is the final authority. */
export interface Equipment {
  profile: string
  target: string | null
}

export const sameEquipment = (a: Equipment, b: Equipment): boolean =>
  a.profile === b.profile && (a.target ?? null) === (b.target ?? null)

export const describeEquipment = (e: Equipment): string => (e.target ? `${e.profile}@${e.target}` : e.profile)

const LABEL_PROFILE = 'agora.bretagne.dev/profile'
const ANNOTATION_TARGET = 'agora.bretagne.dev/target'
const ANNOTATION_LEASE = 'agora.bretagne.dev/lease-id'

/** Re-read a loge's equipment off the pod itself. The manager is jetable (ADR 0010 §1.3) — after a
 *  restart the cluster is the only truth about what a running loge was equipped with, so the facts
 *  ride on the pod. A pre-P4 loge carries no label and reads back as `chat-v1`: exactly what P3
 *  minted it with, so adoption stays correct across the upgrade. */
export function equipmentFromPod(pod: any): Equipment {
  const profile = pod?.metadata?.labels?.[LABEL_PROFILE]
  const target = pod?.metadata?.annotations?.[ANNOTATION_TARGET]
  return {
    profile: typeof profile === 'string' && profile ? profile : DEFAULT_PROFILE,
    target: typeof target === 'string' && target ? target : null,
  }
}

/** Env the manager MINTS onto the loge pod. A spawn body may not set these: the session env is
 *  layered over the pod's in the child process, so accepting one would let a caller OVERRIDE the
 *  credential and the base-URL the manager chose — i.e. name its own upstream (plan §2.6). */
const MINTED_ENV: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AGENT_BROKER_TOKEN',
  'AGENT_BROKER_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
])

/** Drop any minted env off an inbound spawn body, reporting what was dropped so the caller can log
 *  it. Names only — a refused value is never echoed anywhere. */
export function stripMintedEnv(raw: unknown): { env?: Record<string, unknown>; dropped: string[] } {
  if (!raw || typeof raw !== 'object') return { dropped: [] }
  const dropped: string[] = []
  const env: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (MINTED_ENV.has(k.toUpperCase())) dropped.push(k)
    else env[k] = v
  }
  return { env, dropped }
}

/** Everything the manager MINTS and hands a loge at birth. Never sourced from a spawn body: the
 *  manager is the only party that may decide what credential a loge holds (plan §2.6). */
export interface LogeCustody {
  /** The Claude credential the loge presents: a broker lease, or the inference-proxy placeholder. */
  oauthToken: string
  /** Where its inference must go: the broker data plane, or the inference-proxy. */
  baseUrl: string
  /** The equipment its lease was minted for — recorded on the pod so a restarted manager re-derives it. */
  equipment: Equipment
  /** The lease's ID (never its token — plan §2.6) — recorded so a restarted manager can still revoke it. */
  leaseId?: string
}

/** The loge pod template (agent-runtime ADR 0010 §6 / infra-k8s ADR 0028 §3) — pinned here as the
 *  single source of truth; the plan's yaml is the spec this must match. */
export function buildLogePodSpec(group: string, config: ManagerConfig, custody: LogeCustody): Record<string, unknown> {
  const { oauthToken, baseUrl, equipment, leaseId } = custody
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `loge-${group}`,
      // The profile is a LABEL (selectable: `kubectl get pods -l agora.bretagne.dev/profile=vault-v1`
      // answers "what is privileged right now"). The target is an ANNOTATION — `github:owner/repo`
      // is not a legal label value.
      labels: { app: 'loge', 'agora.bretagne.dev/group': group, [LABEL_PROFILE]: equipment.profile },
      annotations: {
        ...(equipment.target ? { [ANNOTATION_TARGET]: equipment.target } : {}),
        ...(leaseId ? { [ANNOTATION_LEASE]: leaseId } : {}),
      },
    },
    spec: {
      restartPolicy: 'Never',
      runtimeClassName: 'sandboxed',
      automountServiceAccountToken: false,
      // runAsNonRoot + runAsUser at pod level so they cover every container uniformly. Two-stage
      // bug hit live 2026-07-05 (P4.1): (1) PSA `restricted` admission only checks the field is
      // SET on every container (agent-runs enforces it from birth, unlike the unlabelled Phase V
      // verrou namespace) — passing runAsNonRoot alone got the pod admitted; (2) but both images
      // declare their non-root user by NAME (`USER node` in both Dockerfiles), and kubelet's
      // startup-time check refuses to trust a named user as non-root — it needs a numeric uid.
      // 1000 is that user in both images (agent-runtime and agora-website both build on
      // node:20-bookworm-slim; agent-runtime's Dockerfile documents it explicitly).
      securityContext: { fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' }, runAsNonRoot: true, runAsUser: 1000 },
      initContainers: [
        {
          // Read-driven boot (ADR 0010 amendment 2026-07-07): the loge image bakes the plugin
          // install's durable output at /home/node/agora-state (see Dockerfile.loge) — plugins/ AND
          // settings.json (which carries enabledPlugins → claude spawns the channel MCP server).
          // Restore both into the fresh emptyDir HOME (sub-second) instead of running `claude plugin
          // install` (~14s) on every cold boot. The `if` keeps a lingered-then-reused loge from re-copying.
          name: 'seed',
          image: config.logeImage,
          command: [
            'sh',
            '-c',
            'set -e\n' +
              'if [ ! -d "$HOME/.claude/plugins/cache/agora" ]; then\n' +
              '  echo "restoring baked agora channel plugin + settings"\n' +
              '  cp -a /home/node/agora-state/plugins "$HOME/.claude/plugins"\n' +
              '  cp -a /home/node/agora-state/settings.json "$HOME/.claude/settings.json"\n' +
              'else\n' +
              '  echo "agora plugin already present — keeping"\n' +
              'fi\n',
          ],
          env: [{ name: 'HOME', value: '/home/node' }],
          volumeMounts: [{ name: 'claude', mountPath: '/home/node/.claude' }],
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
            // Token dispossession (2026-07-09): the loge NEVER holds the real token — it holds a
            // worthless bearer (so claude still emits the oauth beta header) and points
            // ANTHROPIC_BASE_URL at a trusted egress that swaps in the real token + fills account_uuid.
            // Two shapes (P3): the inference-proxy placeholder + the proxy IP, OR an opaque broker
            // LEASE + the broker data plane (the broker validates the lease and forwards to the
            // isolated claude-adapter). Either way the loge has nothing worth stealing.
            { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken },
            { name: 'ANTHROPIC_BASE_URL', value: baseUrl },
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
            { name: 'logs', mountPath: '/logs' },
          ],
        },
      ],
      volumes: [
        { name: 'claude', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'logs', emptyDir: {} },
      ],
    },
  }
}

/** The inference-auth proxy pod: a standing singleton, SEPARATE from the loges, the ONLY holder of
 *  the real token. The manager owns its lifecycle with the pod-CRUD it already has (agent-runs), so
 *  the whole feature lives in agent-runtime — no infra-k8s Deployment/Service. It is a different pod
 *  from any loge, so a compromised loge cannot read its token (pod isolation) — it only reaches the
 *  proxy over HTTP. It runs gVisor-sandboxed too: agent-runs' admission policy (ADR 0027) mandates
 *  runtimeClassName: sandboxed for EVERY pod; harmless (gVisor is host-isolation, orthogonal to the
 *  token custody that pod isolation already gives). Runs the loge image (which is FROM the base
 *  agent-runtime image → carries dist/inference-proxy.js) via a CMD override, keeping the tini
 *  entrypoint. Resources are tiny; note it consumes one of the agent-runs pod-quota slots. */
export function buildProxyPodSpec(config: ManagerConfig): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: PROXY_POD_NAME, labels: { app: 'inference-proxy' } },
    spec: {
      // agent-runs mandates gVisor for EVERY pod (ADR 0027 admission policy) — sandbox the proxy too.
      runtimeClassName: 'sandboxed',
      restartPolicy: 'Always', // standing service — the kubelet restarts the container on a crash
      automountServiceAccountToken: false,
      securityContext: { fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' }, runAsNonRoot: true, runAsUser: 1000 },
      containers: [
        {
          name: 'proxy',
          image: config.logeImage,
          // keep the image's tini entrypoint, override its CMD (WORKDIR /app carries dist/)
          args: ['node', 'dist/inference-proxy.js'],
          ports: [{ containerPort: config.proxyPort }],
          env: [
            { name: 'PORT', value: String(config.proxyPort) },
            // the REAL token — it lives ONLY here, never in a loge
            {
              name: 'CLAUDE_CODE_OAUTH_TOKEN',
              valueFrom: { secretKeyRef: { name: config.claudeOauthSecret, key: 'token' } },
            },
            { name: 'ANTHROPIC_ACCOUNT_UUID', value: config.accountUuid },
            { name: 'UPSTREAM_ORIGIN', value: 'https://api.anthropic.com' },
          ],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true },
          resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '250m', memory: '256Mi' } },
          readinessProbe: { httpGet: { path: '/healthz', port: config.proxyPort }, periodSeconds: 2 },
        },
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
  /** The broker lease minted for this loge (P3, broker mode) — revoked when the loge is torn down.
   *  Only the leaseId is tracked (never the token); undefined on the inference-proxy path. */
  leaseId?: string
  /** What that lease was minted for (agora ADR 0012). Part of the loge's identity: a run asking for
   *  different equipment cannot reuse this loge — see getOrCreateLoge. */
  equipment: Equipment
}

type RunLocation = { where: 'shared' } | { where: 'loge'; podName: string; group: string }

interface Tombstone {
  status: 'exited'
  exitCode?: number
  /** Why a `creating` run failed (ADR 0010 amendment 2026-07-07) — read by the hub; e.g.
   *  `anchor_transcript_missing` drives its one-shot forceFresh, as the old synchronous 409 did. */
  reason?: string
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
  /** Read-driven liveness (ADR 0010 amendment 2026-07-07): an isolated spawn registers here the
   *  instant its POST arrives, giving the run a readable `creating` status (via GET /sessions/:id)
   *  while its loge is built in the background. Deliberately kept OUT of GET /sessions (the list) so
   *  an old hub still reads boot as absence during the manager-first rollout. */
  private readonly creating = new Map<string, { group: string; since: number }>()
  /** In-flight background loge creations, keyed by run id — awaited by tests and graceful shutdown. */
  private readonly settling = new Map<string, Promise<void>>()
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
      // Both facts are re-read off the pod: its equipment (so a spawn asking for something else
      // replaces it rather than silently inheriting) and its leaseId (so this manager can still
      // revoke a lease minted by the instance it replaced, instead of leaking it to its TTL).
      this.loges.set(group, {
        podName,
        equipment: equipmentFromPod(pod),
        leaseId: pod.metadata?.annotations?.[ANNOTATION_LEASE],
      })
      try {
        const sessions = await this.fetchLogeSessions(pod.status.podIP)
        for (const s of sessions) this.runLocations.set(s.id, { where: 'loge', podName, group })
      } catch {
        /* unreachable right now — the next sweep will reconcile it */
      }
    }
  }

  /** POST /sessions — routes by substrate, which is the manager's own deployment config, NOT a
   *  spawn-body field: shared and isolated provision differently (a shared pod+PVC vs a per-conv
   *  loge), so which one is used is baked deterministically in configFromEnv (agora ADR 0011
   *  superseded) — never a per-request payload. Today it is `isolated` → get-or-create the loge.
   *  The `shared` branch stays: `shared` is a value the manager still understands; flip the baked
   *  config to select it (a deliberate code+deploy change, its pod being undeployed today). */
  async spawn(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const substrate = this.deps.config.substrate
    // Strip any legacy `substrate` a transitional hub might still send — it is NOT a routing input
    // (routing is the baked config above). `group` and the equipment pair are manager-consumed:
    // the supervisor has no use for them. `credentialLease` is REFUSED, not consumed: only the
    // manager may decide what credential a loge holds (plan §2.6).
    const {
      substrate: _legacy,
      group: rawGroup,
      equipmentProfile: rawProfile,
      target: rawTarget,
      credentialLease: injectedLease,
      ...rest
    } = body
    const { env, dropped } = stripMintedEnv(rest.env)
    const forwarded: Record<string, unknown> = { ...rest, ...(env ? { env } : {}) }
    if (injectedLease !== undefined || dropped.length > 0) {
      // Loud on purpose: nothing legitimate sends these, so this is either a bug in a caller or the
      // hub speaking for a browser that tried to pick its own credential.
      console.error(
        `[manager] refused minted fields on a spawn body: ${[
          ...(injectedLease !== undefined ? ['credentialLease'] : []),
          ...dropped,
        ].join(', ')}`,
      )
    }

    // The manager is the FINAL authority on equipment (plan §P4.4): agora validates too, but a
    // profile this version does not know — or one it knows and has not enabled — is refused here,
    // whatever agora's (possibly stale) projection offered.
    const check = checkProfileTarget(
      typeof rawProfile === 'string' && rawProfile ? rawProfile : DEFAULT_PROFILE,
      typeof rawTarget === 'string' ? rawTarget : null,
    )
    if (!check.ok) {
      return { status: 400, body: { error: check.error, ...(check.detail ? { detail: check.detail } : {}) } }
    }
    const equipment: Equipment = { profile: check.profile.name, target: check.target }

    if (substrate === 'shared') {
      const result = await this.forwardSpawn(this.deps.config.sharedSupervisorUrl, forwarded)
      this.rememberSpawnLocation(result, { where: 'shared' })
      return result
    }

    const group = rawGroup as string | undefined
    if (typeof group !== 'string' || !group) {
      return { status: 400, body: { error: '`group` is required for substrate=isolated' } }
    }
    const id = forwarded.id as string | undefined
    if (typeof id !== 'string' || !id) {
      return { status: 400, body: { error: '`id` is required for substrate=isolated' } }
    }

    // Read-driven liveness (ADR 0010 amendment 2026-07-07): register `creating` and return at once;
    // build the loge in the background. The hub READS the status (creating → running | exited) via
    // GET /sessions/:id instead of guessing boot from an ambiguous absence + a settle window.
    this.creating.set(id, { group, since: Date.now() })
    this.settling.set(
      id,
      this.createLogeAndForward(id, group, equipment, forwarded).finally(() => this.settling.delete(id)),
    )
    return { status: 202, body: { id, status: 'creating' } }
  }

  /** The background half of an isolated spawn: create/reuse the loge, inject resume custody (§4),
   *  forward — resolving the run's readable status (creating → running | exited). Bounded by
   *  getOrCreateLoge's own timeout, so a `creating` run always resolves to a definite fact. */
  private async createLogeAndForward(
    id: string,
    group: string,
    equipment: Equipment,
    forwarded: Record<string, unknown>,
  ): Promise<void> {
    try {
      const loge = await this.getOrCreateLoge(group, equipment)
      if ('error' in loge) return this.markExited(id, loge.error)

      const resumeUuid = this.extractResumeUuid(forwarded.args)
      if (resumeUuid) {
        const resolved = await this.resolveResumeTranscript(loge.podIp, resumeUuid)
        // §4: the anchor transcript is gone everywhere → a terminal, readable fact. The hub maps it
        // to its one-shot forceFresh, exactly as the old synchronous 409 did.
        if (resolved === undefined) return this.markExited(id, 'anchor_transcript_missing')
        if (resolved !== null) forwarded.transcript = { sessionUuid: resumeUuid, content: resolved }
      }

      const result = await this.forwardSpawn(`http://${loge.podIp}:8080`, forwarded)
      if (result.status >= 200 && result.status < 300) {
        // Running now — the loge reports it via its own /sessions; drop the creating marker.
        this.rememberSpawnLocation(result, { where: 'loge', podName: loge.podName, group })
        this.creating.delete(id)
      } else {
        this.markExited(id, `forward_failed_${result.status}`)
      }
    } catch (err) {
      this.markExited(id, (err as Error).message)
    }
  }

  /** creating → exited{reason}: a readable, TTL'd terminal fact (mirrors the Failed-pod tombstone). */
  private markExited(id: string, reason: string): void {
    this.creating.delete(id)
    this.tombstones.set(id, { status: 'exited', reason, expiresAt: Date.now() + EXITED_TOMBSTONE_MS })
  }

  /** Test/shutdown aid: await every in-flight background loge creation. */
  async awaitSettled(): Promise<void> {
    await Promise.all([...this.settling.values()])
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

  /**
   * The loge for a group, equipped as the run asked — reused when it already matches, REPLACED when
   * it does not (agora ADR 0012 §3). Equipment is part of a loge's identity because neither half of
   * it can change in place: a lease's claims are frozen at mint, and a pod's env at creation. Reusing
   * a mismatched loge would hand the new run the OLD profile — a run journaled `chat-v1` still
   * holding `vault:full` (plan invariant #5). The cost is a cold loge on every equipment switch,
   * which is the same cost the product already pays for any other config change (agora ADR 0010).
   */
  private async getOrCreateLoge(
    group: string,
    equipment: Equipment,
  ): Promise<{ podName: string; podIp: string } | { error: 'quota_exceeded' }> {
    const existing = this.loges.get(group)
    if (existing) {
      const pod = await this.deps.k8s.getPod(existing.podName)
      const ip = pod?.status?.podIP
      const live = Boolean(pod && ip && this.isReady(pod))
      if (live && sameEquipment(existing.equipment, equipment)) return { podName: existing.podName, podIp: ip as string }
      if (live) {
        console.log(
          `[manager] ${group}: re-equipping ${describeEquipment(existing.equipment)} → ${describeEquipment(equipment)} — replacing the loge`,
        )
        // The loge holds the only live copy of its native transcripts; the idle-reap path drains for
        // exactly this reason. Without it, switching equipment would cost the conversation its resume
        // anchor (ADR 0007) — a silent history reset dressed up as a settings change.
        await this.drainLoge(existing.podName, ip as string)
      }
      // Not reusable, either way. Delete and WAIT for it to be gone: `loge-<group>` is a deterministic
      // name, so racing a Terminating pod makes createPod 409 and the adopt branch below hand this run
      // the OLD pod — carrying the lease we are about to revoke.
      await this.deps.k8s.deletePod(existing.podName).catch(() => {})
      await this.revokeLease(existing.leaseId)
      this.forgetRunsFor(existing.podName)
      this.loges.delete(group)
      if (!(await this.waitGone(existing.podName))) {
        console.error(`[manager] ${existing.podName} still Terminating past logeReadyTimeoutMs — refusing to adopt it`)
        return { error: 'quota_exceeded' }
      }
    }

    // The loge is dispossessed — it reaches Anthropic only through a trusted egress that holds the real
    // token. P3: the inference-proxy (placeholder) OR the broker (a per-loge lease + the broker data
    // plane, which validates the lease and forwards to the isolated claude-adapter). USE_BROKER flips
    // new loges to the broker; old loges + rollback keep the proxy.
    let oauthToken: string
    let baseUrl: string
    let leaseId: string | undefined
    if (this.deps.config.useBroker) {
      const lease = await this.mintLease(group, equipment)
      if (!lease) return { error: 'quota_exceeded' } // broker unreachable → provision failure (rollback: USE_BROKER=false)
      oauthToken = lease.token
      baseUrl = this.deps.config.brokerDataUrl
      leaseId = lease.leaseId
    } else {
      const proxyBaseUrl = await this.ensureProxyBaseUrl()
      if (!proxyBaseUrl) return { error: 'quota_exceeded' }
      oauthToken = PLACEHOLDER_OAUTH_TOKEN
      baseUrl = proxyBaseUrl
    }

    await this.createGate.acquire()
    try {
      const podName = `loge-${group}`
      const spec = buildLogePodSpec(group, this.deps.config, { oauthToken, baseUrl, equipment, leaseId })
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
          await this.revokeLease(leaseId) // the loge won't exist — don't leave its lease dangling
          return { error: 'quota_exceeded' }
        }
      }
      const ready = await this.waitReady(podName)
      if (!ready) {
        console.error(`[manager] ${podName} never became Ready within logeReadyTimeoutMs`)
        await this.deps.k8s.deletePod(podName).catch(() => {})
        await this.revokeLease(leaseId)
        return { error: 'quota_exceeded' }
      }
      this.loges.set(group, { podName, leaseId, equipment })
      return { podName, podIp: ready.status.podIP }
    } finally {
      this.createGate.release()
    }
  }

  /** Poll until a pod is really gone. Deliberately bounded by the same timeout as readiness: a pod
   *  stuck Terminating (gVisor teardown is not instant) must surface as a provision failure, never as
   *  a silent adoption of the pod we just condemned. */
  private async waitGone(podName: string): Promise<boolean> {
    const deadline = Date.now() + this.deps.config.logeReadyTimeoutMs
    for (;;) {
      if (!(await this.deps.k8s.getPod(podName))) return true
      if (Date.now() >= deadline) return false
      await sleep(this.readyPollMs)
    }
  }

  /** Ensure the singleton inference-proxy pod is up (the manager owns its lifecycle like a loge:
   *  get-or-create + waitReady), returning its base-URL — or undefined if it can't be readied.
   *  Called before every loge create (the loge is dispossessed, so it depends on the proxy) and once
   *  at boot. Recreates the pod if it vanished/terminated; restartPolicy:Always covers plain crashes. */
  private async ensureProxyBaseUrl(): Promise<string | undefined> {
    const pod = await this.deps.k8s.getPod(PROXY_POD_NAME)
    const phase = pod?.status?.phase
    if (!pod || phase === 'Failed' || phase === 'Succeeded') {
      if (pod) await this.deps.k8s.deletePod(PROXY_POD_NAME).catch(() => {})
      try {
        await this.deps.k8s.createPod(buildProxyPodSpec(this.deps.config))
      } catch (err) {
        if ((err as HttpError).status !== 409) {
          console.error('[manager] inference-proxy create failed:', (err as HttpError).status, (err as Error).message, (err as HttpError).body)
          return undefined
        }
      }
    }
    const ready = await this.waitReady(PROXY_POD_NAME)
    if (!ready?.status?.podIP) {
      console.error('[manager] inference-proxy never became Ready')
      return undefined
    }
    return `http://${ready.status.podIP}:${this.deps.config.proxyPort}`
  }

  /** Ensure the inference-proxy is up — public wrapper for the boot path. */
  async ensureProxy(): Promise<void> {
    await this.ensureProxyBaseUrl()
  }

  /** Mint a per-loge broker lease (P3, broker mode) for the run's validated equipment (P4). The
   *  profile/target here have already passed `checkProfileTarget` in spawn(); the broker checks them
   *  again on its own side of the boundary. Returns undefined if the broker admin plane is
   *  unreachable — the caller treats that as a provision failure (rollback: USE_BROKER=false). */
  private async mintLease(group: string, equipment: Equipment): Promise<{ leaseId: string; token: string } | undefined> {
    try {
      const res = await fetch(`${this.deps.config.brokerAdminUrl}/v1/leases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: group,
          profile: equipment.profile,
          ...(equipment.target ? { target: equipment.target } : {}),
        }),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) {
        console.error('[manager] lease mint failed:', res.status)
        return undefined
      }
      const j = (await res.json()) as { leaseId?: string; token?: string }
      return j.leaseId && j.token ? { leaseId: j.leaseId, token: j.token } : undefined
    } catch (e) {
      console.error('[manager] lease mint error:', (e as Error).message)
      return undefined
    }
  }

  /** Revoke a lease (idempotent, best-effort — the lease TTL is the backstop). Only ever the leaseId
   *  in a log, never the token. */
  private async revokeLease(leaseId: string | undefined): Promise<void> {
    if (!leaseId) return
    try {
      await fetch(`${this.deps.config.brokerAdminUrl}/v1/leases/${encodeURIComponent(leaseId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      /* best-effort */
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
        await this.revokeLease(loge.leaseId)
        this.loges.delete(group)
        continue
      }
      const phase = pod.status?.phase
      if (phase === 'Failed' || phase === 'Succeeded') {
        this.tombstoneRunsFor(loge.podName, this.extractExitCode(pod), now)
        await this.deps.k8s.deletePod(loge.podName).catch(() => {})
        this.forgetRunsFor(loge.podName)
        await this.revokeLease(loge.leaseId)
        this.loges.delete(group)
        continue
      }
      if (phase === 'Pending') {
        const createdAt = new Date(pod.metadata?.creationTimestamp ?? now).getTime()
        if (now - createdAt > this.deps.config.logeReadyTimeoutMs) {
          await this.deps.k8s.deletePod(loge.podName).catch(() => {})
          this.forgetRunsFor(loge.podName)
          await this.revokeLease(loge.leaseId)
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
          await this.revokeLease(loge.leaseId)
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
    // NB: `creating` runs are intentionally NOT listed here (see the `creating` field) — the list
    // stays absence-based for an old hub; the new hub reads `creating` via GET /sessions/:id.
    for (const [id, tomb] of this.tombstones) {
      results.push({ id, status: tomb.status, exitCode: tomb.exitCode, reason: tomb.reason })
    }
    return results
  }

  async getSession(id: string): Promise<{ status: number; body: unknown }> {
    // Read-driven liveness (ADR 0010 amendment): a still-booting run is a fact, not an absence.
    if (this.creating.has(id)) return { status: 200, body: { id, status: 'creating' } }
    const tomb = this.tombstones.get(id)
    if (tomb) return { status: 200, body: { id, status: tomb.status, exitCode: tomb.exitCode, reason: tomb.reason } }
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
  await manager.ensureProxy().catch((e) => console.error('[manager] initial inference-proxy ensure failed:', e))
  setInterval(() => manager.sweepOnce().catch((e) => console.error('[manager] sweep failed:', e)), config.sweepIntervalMs).unref()
  createManagerServer(manager).listen(config.port, '0.0.0.0', () => {
    console.log(`[manager] listening on 0.0.0.0:${config.port}`)
  })
}
