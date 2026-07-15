# ADR 0012 — Capability profiles

## Status

Proposed — 2026-07-14. Pairs with **ADR 0011** (the broker grants exactly one profile's capabilities per
lease) and **agora ADR 0012** (the run records `profile` + `target` as immutable facts). Master plan:
`/srv/agent-broker-execution-plan.md` §2.2.

## Context

A lease grants a loge the capabilities of **one** profile (ADR 0011 §2). What a profile *is* must be a
**versioned catalogue in code** — the security authority — never an arbitrary list supplied by the
browser. The human picks a profile *id* and, for repo profiles, a *target*; they cannot compose scopes,
GitHub permissions or provider URLs. This ADR fixes the catalogue and its rules; the broker and the
manager enforce them, and only the shapes proven in later paliers are switched on.

## Decision

### 1. The catalogue (v1)

| Profile | Broker capabilities | `target` | Initial state |
|---|---|---|---|
| `chat-v1` | `claude:invoke` | forbidden | enabled, default |
| `vault-v1` | `claude:invoke`, `vault:full` | forbidden | enabled after P5 |
| `repo-read-v1` | `claude:invoke`, `github:contents:read`, `github:metadata:read` | `github:<owner>/<repo>` required | enabled after P6 read |
| `repo-dev-v1` | read + Git/contents write per the App's exact permissions | GitHub target required | disabled until branch controls |
| `repo-dev-vault-v1` | controlled union of `repo-dev-v1` and `vault-v1` | GitHub target required | disabled by default |

Profiles are a catalogue, not a free capability set: a lease names a profile, and the broker maps that
profile to its fixed capability list server-side.

### 2. Target

`target` is normalised (lowercase owner/repo), validated against an allow-list, then stored canonically.
Required **only** for repo profiles; **forbidden** otherwise. `github:arnaultbretagne/infra-k8s` is
refused before any GitHub call — a code deny-list independent of whatever the GitHub App is technically
installed on (plan invariant #10). An unknown profile or a target/profile mismatch is rejected.

### 3. No false granularity

`vault:full` is deliberately explicit: the Vault MCP server cannot enforce per-tool authorization today
(vault-mcp-machine-token-findings.md), so we do **not** advertise a fake `vault:read`. A profile either
grants full Vault MCP access or none — the UI must not imply a scoping the server can't apply.

### 4. Non-escalation

A loge cannot choose or widen its profile after creation (ADR 0011 §2). Changing the profile or target
creates a **new run** (agora ADR 0012), never a silent mutation of a live one. Combined profiles
(`repo-dev-vault-v1`) are not exposed in the UI until a concrete need justifies them.

#### Amendment (2026-07-15, P4) — a new run is not enough: equipment is part of a loge's identity

"A new run" was underspecified, and read literally it left the hole this ADR exists to close. A loge is
get-or-create'd per **group** (the conversation) and outlives the runs inside it, while its lease is
minted once and injected into the pod env at creation. So a *new run* alone would land in the *old
loge* and inherit its lease: switch `vault-v1` → `chat-v1` and the "chat" run keeps `vault:full`, with
the run journalling a profile it is not actually confined to. The fact would be a lie, and §4's promise
with it.

Therefore `(profile, target)` is part of a loge's identity. `getOrCreateLoge` reuses a loge only when
its equipment matches; otherwise it **drains, deletes and replaces** it, revoking the old lease. Neither
half can change in place — a lease's claims are frozen at mint, a pod's env at creation — so replacement
is the only sound move. The equipment rides on the pod (profile as a label, target as an annotation)
because the manager is jetable: after a restart, the cluster is the only truth about what a live loge
was equipped with. The lease id rides there too, so a restarted manager can still revoke a lease its
predecessor minted rather than leak it to its TTL.

Cost: switching equipment forces a cold loge (~10s), the same price the product already pays for any
other config change (agora ADR 0010). The drain is what keeps that price honest — the loge holds the
only live copy of its native transcripts, so skipping it would turn a settings change into a silent
history reset (ADR 0007).

### 5. Authority split

- The **security authority** for the catalogue lives here, in `agent-runtime`.
- **agora** consumes a versioned, build-time **projection** carrying only `{ label, description,
  needsTarget, visible }` — never the capability lists — so the browser can render choices without being
  able to define them.
- The **manager** is the final authority: it refuses any profile its own version does not know, even if
  a newer agora offers it.

## Consequences

- Gated rollout: `chat-v1` is the only enabled profile until P5/P6 flip `vault-v1` / `repo-read-v1`;
  write profiles stay disabled until branch-protection non-bypass is proven on a sandbox (plan P6.6).
- `infra-k8s` is unreachable through any agent profile by construction, defence-in-depth against a
  future over-broad GitHub App installation.
- Adding or retiring a profile is a code change in the catalogue plus a projection rebuild — auditable,
  never a runtime toggle from the browser.
