# ADR 0010 — Execution substrates: the manager and the loges

## Status

Accepted — 2026-07-05 (verrous V1–V3 passés — voir RUNLOG `/srv/runtime-isolation-plan.RUNLOG.md`).
**Extends ADR 0001** (the supervisor stays a thin process manager — a *manager* appears above it),
**ADR 0003** (the pod boundary generalises to per-conversation pods) and **ADR 0004** (one image, two
entrypoints). Leaves **ADR 0008** untouched (the idle clock still lives with the session).

## Context

Today one pod carries everything: the supervisor *and* every claude runtime it spawns, all sharing one
`~/.claude` PVC, one memory limit, one network identity, one PID namespace. Consequences, in trust
order:

- **One trust domain across all conversations.** Any runtime can read every other conversation's
  native transcript on the shared HOME, kill sibling processes, or poison the shared plugin install
  (which persists across pods — the "plugin delivery gotcha"). Conversations telescope.
- **One blast radius.** A single ballooning runtime OOM-kills the whole fleet (the 2026-07-04 host
  freeze was exactly this failure mode, host-side).
- **F3 blocked.** infra-k8s ADR 0024 classifies the agent namespace `untrusted-compute`, but it cannot
  be labelled (the ADR 0027 sandbox VAP would reject its pods), because one pod *mixes* trusted
  control plane (supervisor) with untrusted compute (runtimes).

The platform is heading toward runs that execute increasingly autonomous code (the agent dev loop:
dev/review/QA runs over arbitrary PR content). "What to run" (agora's run facts, agora ADR 0010) must
decouple from "where to run it".

## Decision

### 1. Two substrates, one opaque hint

`POST /sessions` gains two optional fields:

- `substrate: 'shared' | 'isolated'` (default `shared`) — where to place the runtime;
- `group: string` — an opaque co-location key (the hub passes its conversation id; the runtime layer
  attaches **no meaning** to it beyond "sessions with the same group share a loge" — ADR 0002 holds).

`shared` = the current pod (dense interactive fleet, PVC HOME, warm). `isolated` = one sandboxed pod
per group — a **loge** — in the `agent-runs` namespace (infra-k8s ADR 0028).

### 2. The manager

A new small service (same repo, same image, second entrypoint `dist/manager.js`), deployed as its own
*trusted* pod in the `agent` namespace. It is the hub's **single** endpoint (ADR 0001's "the hub is
the sole client" is preserved transitively: hub → manager → supervisors).

- **Routing.** `shared` spawns proxy verbatim to the shared supervisor service. `isolated` spawns
  create (or reuse) the group's loge pod via the Kubernetes API, wait for Ready, then forward the same
  `POST /sessions` to the supervisor *inside* the loge.
- **Aggregation.** `GET /sessions` merges all substrates (the hub's 3s liveness poll is unchanged);
  `GET /sessions/:id`, `touch`, `DELETE` route by a runId→location map rebuilt at boot from the loge
  pod list (label `app=loge`). Unknown id → 404 (the hub already reads that as `dormant`). A loge pod
  in phase `Failed` is reported once as `exited`+exitCode (60s tombstone, mirroring `EXITED_TTL_MS`),
  then drained and deleted.
- **Capabilities.** `/kinds` and `/kinds/:kind/capabilities` are served locally — the manager runs the
  same image, so the co-located claude binary gives identical answers.
- **K8s client.** A raw `node:https` client against `kubernetes.default.svc` with the mounted SA
  token (~100 lines: create/get/list/delete pod). No new npm dependency — poll, no watch; the 3s
  liveness cadence already exists.

### 3. The supervisor is reused unchanged as the loge server

One binary, both roles. Three **additive, substrate-agnostic** endpoints:

- `POST /sessions` accepts optional `transcript: { sessionUuid, content }` — written to the native
  transcript path (`$HOME/.claude/projects/<cwd-slug>/<uuid>.jsonl`) *before* the pty spawn, and
  **never clobbering** an existing file. This is how a resumed anchor enters a fresh loge; note the
  existing `transcriptBase` snapshot then naturally sees the injected bytes as "previous runtime's
  turns", so the resolved-model report stays correct with zero extra code.
- `GET /transcripts` → the uuids present on this HOME (stateless — survives session GC).
- `GET /transcripts/:uuid` → the raw jsonl, or 404.

### 4. Anchor custody (with agora ADR 0007/0011)

A loge's HOME is an **emptyDir** — ephemeral by design (state that must survive is either platform
data or disposable). The manager owns transcript continuity:

- **Out:** before deleting a loge pod, the manager pulls every transcript the loge holds and stores
  them on its own small PVC (`/anchors/<uuid>.jsonl`). The flow is one-way and always trusted-side
  initiated: **a loge never mounts shared storage** — this closes the cross-conversation write channel
  the shared PVC is today.
- **In:** on a spawn carrying `--resume <uuid>`, the manager checks the loge first
  (`GET /transcripts/:uuid` — the pod-reuse case), then its store (inject via the spawn body). Found
  nowhere → the spawn fails `409 { error: 'anchor_transcript_missing' }`, a typed signal the hub maps
  to its existing one-shot `forceFresh` fallback. **The re-seed floor of agora ADR 0007 remains the
  correctness floor — no new invariant.**
- **GC:** `DELETE /anchors/:uuid` (called best-effort by the hub on conversation deletion) + a TTL
  sweep (`ANCHOR_TTL_DAYS`, default 30) as backstop.

### 5. Loge lifecycle

- **Birth:** first `isolated` spawn for a group. Creation is rate-limited
  (`MAX_CONCURRENT_LOGE_CREATES`, default 2, FIFO queue — the 2026-07-04 cold-start thundering-herd
  lesson) and bounded by the namespace ResourceQuota.
- **Life:** in-loge idle-reaping is exactly ADR 0008 (the `idleTtlMs` clock lives with the session).
- **Linger:** when its last session ends, the loge **lingers** (`LOGE_LINGER_MS`, default 120s) so
  the kill-then-respawn config switch (agora ADR 0010) reuses the same pod — native `--resume` stays
  pod-local, no transcript shuttling in the hot path.
- **Death:** after the linger, drain (pull transcripts) → delete pod. A pod that *crashes* loses the
  transcripts written since its birth → floor re-seed (accepted: transcripts are the disposable tier).
- `restartPolicy: Never` — the hub owns every respawn decision, kubelet restarts would lie to it.

### 6. The loge pod template (pinned in manager code)

`runtimeClassName: sandboxed` (gVisor, infra ADR 0027) · `automountServiceAccountToken: false` ·
non-root `node`, caps dropped, seccomp RuntimeDefault (PSA `restricted`) · emptyDir HOME with
`sizeLimit` · the **same two initContainers as today's deployment** (fetch-channel from the
agora-website image + plugin seed — now running on every loge birth, which *kills* the plugin-delivery
gotcha for this substrate: every loge gets the current channel code) · env
`CLAUDE_CODE_OAUTH_TOKEN` (namespace-local SOPS secret copy) + `DISABLE_AUTOUPDATER=1` · image from
`LOGE_IMAGE` (digest-pinned) · explicit requests/limits — **per-loge OOM blast radius** instead of
fleet-wide.

### 7. Security posture (extends ADR 0003)

Trust split: the **manager** is trusted control plane — it holds the *only* ServiceAccount (pods CRUD
in `agent-runs`, nothing else, no exec) and the anchors PVC. **Loges** are untrusted compute: no SA
token, gVisor, per-loge CNP identity (egress Anthropic/world:443 + hub:8600 + DNS; ingress
manager + kubelet probes). What this does **not** buy, stated honestly: the static OAuth token sits in
every loge's env (exfiltratable, exactly as today — annual rotation stays the answer, ADR 0007); and
prompt-injection acting through *legitimate* channels (a reply, a future GitHub PAT) is bounded by
those credentials' scopes, not by gVisor.

## Consequences

- The image gains a second entrypoint; CI unchanged (same build).
- The plugin-delivery gotcha and the `~/.local` auto-update residue both die on the isolated
  substrate (ephemeral HOME + fresh seed each birth).
- F3 (infra ADR 0024) is unblocked: compute evacuates to `agent-runs`; a **gated follow-up phase**
  moves the shared-substrate pod there too (sandboxed, PVC riding along), after which the `agent`
  namespace holds only platform components and relabels `private-app`.
- Spawn latency on a cold loge ≈ pod create + gVisor + seed + claude boot (~4–8s to `starting→live`) —
  acceptable for job-like runs; the policy default keeps interactive chat on `shared`.
- **Verify gates before Accepted:**
  - **V1** — claude runs under gVisor: PTY (node-pty), channel WS, transcript writes, in a `sandboxed`
    pod from the current image;
  - **V2** — a transplanted transcript resumes: inject a foreign `<uuid>.jsonl` into a fresh HOME,
    `--resume <uuid>` recalls its content;
  - **V3** — the network paths hold under CNP: loge→website:8600 (cross-ns), loge→api.anthropic.com,
    manager→loge:8080, everything else denied.
  All three passed 2026-07-05 (measurements, one operational deviation — the loge/manager dial-back
  target must be a pod, never the VPS host: its nftables INPUT chain default-drops unlisted ports
  regardless of which host-owned address is targeted — and one sequencing note — the loge→website
  path needs this ADR's manager-side CNP *and* the paired website-ingress amendment (infra-k8s ADR
  0028 §3) deployed together, verified analytically via Cilium drop logs pending that joint rollout —
  in `/srv/runtime-isolation-plan.RUNLOG.md`).
