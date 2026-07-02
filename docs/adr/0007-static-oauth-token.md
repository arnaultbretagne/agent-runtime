# ADR 0007 — Runtime auth = static long-lived token (`setup-token`), not rotating OAuth creds

## Status

Accepted — 2026-07-02 (incident-driven). **Supersedes ADR 0006** (the `claude auth login` +
self-refreshing creds on a RW PVC + bootstrap-Job design). Keeps 0006's *interactive-login-is-a-human-
gesture* premise; **drops its "self-refreshing creds on the PVC" mechanism and its "multi-process OK"
claim**, both falsified in production.

## Context

ADR 0006 chose `claude auth login` with **self-refreshing** credentials on a RW PVC, and explicitly
recorded *"Multi-process / multi-conv — operator-verified OK (not a risk)"*. **That was falsified on
2026-07-02**: agora went down; the runtime's `~/.claude/.credentials.json` on the `agent-claude` PVC was
blanked to a logged-out stub (`expiresAt:0`, 242 B) → every conversation showed *"Not logged in"*, claude
never called `reply`, the channel `redeliver`ed 3× then `ack_giveup`ed.

Root cause — **confirmed against upstream**, not assumed. Claude Code OAuth refresh tokens are
**single-use with rotation** (refreshing R1→R2 invalidates R1 server-side), and the CLI does a
read→HTTP-refresh→write on `.credentials.json` **with no file locking**. Two documented failure modes, and
agora is the only actor that trips them:

- **credential copied to a headless machine** → 401 on first host-side rotation instead of using the
  refresh token ([#21765](https://github.com/anthropics/claude-code/issues/21765)). Our PVC seed *is* a
  copy of the host credential.
- **concurrent-refresh race** between N runtimes sharing one file → the loser gets `invalid_grant` and is
  logged out with no recovery ([#24317](https://github.com/anthropics/claude-code/issues/24317),
  [#27933](https://github.com/anthropics/claude-code/issues/27933),
  [#43392](https://github.com/anthropics/claude-code/issues/43392),
  [#56339](https://github.com/anthropics/claude-code/issues/56339)).

The operator's 3 concurrent terminals never hit this because they **share one coherent file** (single
rotation chain) and claude.ai is a **separate** auth. agora is the worst case: a **copied** credential
**plus** a fan-out of concurrent runtimes writing the same PVC file.

## Decision

**Runtime auth = a static, non-rotating token from `claude setup-token`, injected as
`CLAUDE_CODE_OAUTH_TOKEN` from a SOPS Secret.**

- `claude setup-token` mints a **~1-year OAuth token** tied to the subscription that **does not rotate**.
  No refresh ⇒ no race, no self-invalidating fork.
- Injected as env `CLAUDE_CODE_OAUTH_TOKEN` via `secretKeyRef`. The runtime needs **no `.credentials.json`
  and never refreshes** (validated: `CLAUDE_CODE_OAUTH_TOKEN=… claude -p` authenticates with no creds file).
- **Static ⇒ SOPS is now the right home** — the exact inverse of ADR 0006's "not SOPS *because* it
  rotates". The encrypted Secret lives in git (`infra-k8s/apps/agent/claude-oauth.secrets.yaml`), decrypted
  in-cluster by Flux, exactly like `oauth2-proxy`.

## Rationale

- **Kills both failure modes at the root**: with no refresh, neither the copy-invalidation nor the
  concurrent-refresh race can occur. Fleet concurrency stops being a credential problem.
- **Restores full GitOps**: no more out-of-band `claude-creds` Secret; the credential is versioned
  (encrypted) like every other secret.
- ADR 0006's self-refresh design was elegant *for a single coherent consumer* — it is actively hostile to
  a fan-out of runtimes. We trade "auto-refreshing but fragile" for "manual once a year but rock-solid".

## Consequences

- **`claude-creds` (rotating) Secret + the creds-copy step of the `seed` initContainer are obsolete.**
  Left in place at cut-over (harmless — the env token takes precedence over any PVC file) → **scheduled
  cleanup**: the `seed` initContainer keeps only its plugin-install job; the creds-copy + `creds-seed`
  volume + the out-of-band `claude-creds` Secret are removed.
- **~1-year expiry + possible early revocation** → re-issue is a **rare** operational gesture (re-run
  `setup-token`, update the SOPS Secret, reconcile). This is exactly the recovery path the deferred agora
  *"re-login a runtime from the platform"* feature would automate — currently a **nice-to-have**, not
  mandatory (a year of runway).
- **Pin the claude version in the image.** claude **auto-updates at runtime** (observed 2.1.197→2.1.198
  mid-session, from under the image); pinning keeps auth/transcript/resume behaviour from shifting on a
  release (also relevant to agora ADR 0007 — native resume).
- **ToS posture**: `setup-token` is a first-party command ("requires Claude subscription"); the operator
  accepts long-lived-token use for the platform fleet.
- **Bootstrap is still one human gesture** (interactive OAuth is incompressible) — but now **decoupled
  from steady state**: the runtime never logs in itself, it only carries the token.

## Validation (2026-07-02)

- Token authenticates with **no creds file**: `CLAUDE_CODE_OAUTH_TOKEN=… claude -p` → replies.
- Prod: Secret + env deployed (imperative first, then GitOps via Flux commit `83ad6c4`); conversations
  reply (`STABLE`), the runtime performs **no refresh writes**. The `expiresAt:0` failure mode is gone by
  construction.
