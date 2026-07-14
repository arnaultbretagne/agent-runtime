# ADR 0011 — The agent credential broker

## Status

Proposed — 2026-07-14. **Extends ADR 0003** (security model / trust split) and **ADR 0010** (the manager
owns loge lifecycle and holds the only ServiceAccount). **Supersedes ADR 0010 §6/§7** for credential
custody: a loge no longer carries `CLAUDE_CODE_OAUTH_TOKEN` (nor any real provider secret) — it carries
an opaque per-run lease. **Formalises and deprecates the inference-proxy** (shipped without an ADR, PR
\#7/#8): the base-URL substitution pattern it proved is generalised here and the pod itself is retired in
P7. Pairs with **ADR 0012** (capability profiles) and **agora ADR 0012** (run equipment as facts).

Master execution plan: `/srv/agent-broker-execution-plan.md`. Inputs: `/srv/agent-auth-sandbox-research.md`,
`/srv/vault-mcp-machine-token-findings.md`.

## Context

A loge is untrusted compute (ADR 0010 §7): any credential in its env or filesystem is exfiltratable.
ADR 0010 §7 states this honestly for the static OAuth token ("sits in every loge's env … annual
rotation stays the answer"), and base-URL dispossession then proved it live — the **inference-proxy**
already moves the real Claude token *out* of the loge: the loge holds a placeholder
`CLAUDE_CODE_OAUTH_TOKEN` + `ANTHROPIC_BASE_URL`, a trusted egress pod swaps in the real bearer.

That proved the substitution pattern, but it has three defects:

1. the proxy is a **manager-owned pod in the *untrusted* `agent-runs` namespace** — a durable secret
   living among untrusted compute;
2. there is **no per-loge identity or lease** — one shared token serves the whole fleet, so a single
   compromised loge speaks for all;
3. it **consumes an `agent-runs` quota unit**.

We are about to give loges *more* credentialed reach — Vault MCP (a Pocket-ID machine token) and GitHub
(a GitHub App installation token). Two findings (see `vault-mcp-machine-token-findings.md`) fix the
shape and forbid the easy paths:

- **A provider bearer must never enter the loge.** Claude Code's `headersHelper` runs *inside* the loge,
  so anything it emits is readable there — it may carry only the opaque lease, never a Pocket-ID bearer.
- **Pocket-ID's `aud` is client-forgeable** (the RFC 8707 `resource` is echoed verbatim), so the machine
  identity must be the IdP-asserted client `sub`, gated at the Vault MCP (obsidian-stack, PR #10).

Repeating an ad-hoc proxy per credential would multiply trusted surface and hand every loge blanket,
un-scoped, un-revocable access. We need one policy point, per-run scoping, and secret isolation.

## Decision

Introduce **`agent-broker`** — a single *logical* credential gateway in the trusted `agent` namespace,
fronting **isolated per-provider adapters**, reached by loges only with an **opaque per-run lease**.

### 1. One policy point, three isolated adapters

The front holds the lease store and all policy; it holds **no provider secret**. Each adapter holds
**only its own** secret and is reachable only from the front:

- `agent-broker` front — lease mint/revoke/validate, routing, audit; ports 8789 (admin) / 8788 (data).
- `claude-adapter` — the real Claude token + account UUID only.
- `vault-adapter` — the Pocket-ID broker client secret only.
- `github-adapter` — the GitHub App private key + installation id only.

A compromise of one adapter (or of the Vault path) must **not** yield another provider's secret. Three
Deployments is the target; a multi-container pod with per-container Secret mounts is an acceptable
first step, but a single process holding every key is not the target state.

### 2. Opaque per-run leases

The **manager** mints a lease per run, bound to at least `runId`, `profile`, `target`, `issuedAt`,
`expiresAt` and a CSPRNG nonce (≥256 bits). The loge receives **only** the opaque lease. Every data
call revalidates profile, target, expiry and revocation; the lease grants **only** the demanded
profile's capabilities (plan §2.2). A loge cannot choose or widen its own profile after creation.

### 3. Admin plane (8789) vs data plane (8788)

- **Admin (8789)** — `POST /v1/leases`, `DELETE /v1/leases/{id}`, `GET /healthz|/readyz`. Reachable
  **only** from the manager's ServiceAccount via CiliumNetworkPolicy. Never from a loge.
- **Data (8788)** — lease as `Authorization: Bearer <lease>`; routes to the Claude / Vault / GitHub
  adapters per capability. Reachable **only** from managed loge pods; no public ingress.

Full request/response contracts and stable error codes are pinned in plan §2.4/§2.5 and are part of
this decision.

### 4. Manager → supervisor lease injection

The browser cannot supply credentials. The manager **strips** any `credentialLease`,
`CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_BROKER_TOKEN` or broker-URL field arriving from upstream, validates
the profile/target, mints the lease, then passes a structured `credentialLease {id, token, brokerUrl}`
to the supervisor over the existing internal channel (plan §2.6). The supervisor turns it into child-
process env only (`CLAUDE_CODE_OAUTH_TOKEN`/`AGENT_BROKER_TOKEN` = the opaque lease, `AGENT_BROKER_URL`).
The lease token appears in **no** log, event, label, annotation, command argument or `SessionInfo` —
only `leaseId` is ever surfaced.

### 5. Lease store

V1: a local atomic file on a small RWO PVC with a **single** front replica (no Redis/distributed store
before multi-replica is actually needed). It holds `hash(token)` + claims, **never** the raw token.
Writes are `temp + fsync + rename`; expired entries are swept; the store reloads on restart; the front
**refuses to start** rather than silently recreate an empty store on a missing PVC. Absolute lifetime
starts at 90 min (> current idle TTL, to confirm against deployed values); no implicit sliding renewal
in v1 (long runs get an explicit manager rotation in a later palier).

### 6. Lifecycle binding

The manager mints the lease **before** creating the loge; if pod creation fails it revokes immediately.
It records `leaseId` in non-secret run/pod metadata and **revokes on every** kill, idle-reap, observed
crash and orphan cleanup. Deletion/expiry/reaping of a run revokes its lease (invariant §9 of the plan).

### 7. Security posture (extends ADR 0003, supersedes ADR 0010 §6/§7 custody)

Durable secrets — the real Claude token, the Pocket-ID broker secret, the GitHub App key — live **only**
in the `agent` namespace adapters, each in its own SOPS-backed Secret. The `agent-runs` namespace stays
**secret-free and key-free** (no Secret provider, no private key). No ingress gateway reaches the broker;
the manager is the only workload on the admin plane.

Honest residuals: (a) the per-run lease is opaque, bounded and revocable — a strict improvement over
today's fleet-shared static token, but a live lease still authorises its loge for its window; (b) for a
GitHub profile the broker returns a short-lived **installation access token** into the loge (a git HTTPS
client needs a usable credential) — readable there until it expires (~1 h), accepted as far below a PAT
or the App key, with a transparent Git Smart-HTTP proxy as a possible later hardening.

### 8. Migration and deprecation of the inference-proxy

The **claude-adapter** absorbs the inference-proxy's functional logic (swap the placeholder bearer for
the real token, inject the account UUID, stream SSE, bound sizes/timeouts). Cutover is compatible and
canaried (plan P3.4); after a stable rollback window the `agent-runs` `inference-proxy` pod **and its
Secret** are removed and the namespace quota drops 6 → 5 (plan P7.1). Until then both paths coexist
behind a feature flag.

## Consequences

- Trusted credential surface is consolidated to **one** policy point instead of one proxy per provider;
  each capability (Claude, Vault, GitHub) is independently activatable and reversible (plan P3/P5/P6).
- A new **stateful** trusted service appears (a PVC-backed lease store) — the one operational cost;
  offset by removing the `agent-runs` proxy and its secret in P7.
- ADR 0010 §6's loge env (`CLAUDE_CODE_OAUTH_TOKEN` = real token) is superseded: a loge's only
  credential is an opaque lease. ADR 0007's static token is unchanged *as a token* — only its **custody**
  moves (from every loge to the claude-adapter); annual rotation still applies, now in one place.
- Verify gates before **Accepted**: the security test matrix (plan §4) and the per-palier E2E proofs
  (P3/P5/P6), recorded in `/srv/agent-broker-runlog.md`.
