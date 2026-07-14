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
