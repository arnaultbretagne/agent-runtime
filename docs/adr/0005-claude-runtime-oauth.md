# ADR 0005 — Claude runtime = the interactive TUI on the OAuth subscription

## Status

Proposed — 2026-06-30

## Context

Claude Code can be driven several ways: the **interactive TUI** (on subscription), the **headless
`claude -p`** mode / the **Agent SDK** (programmatic), or via the **Anthropic API** (key, billed per
token). We must choose **how our Claude runtime runs.**

Hard constraint (operator knowledge): **`claude -p` and the Agent SDK are going to be REMOVED from the
subscription** (Anthropic has delayed it, but it is settled). Building on them = **sword of Damocles**:
the day it flips to API billing, all the dev rests on a mode that costs per token. And the **API**
itself is excluded (cost, it is not the intended model).

## Decision

**The Claude runtime = the interactive `claude` TUI, on the OAuth subscription** (firstParty / Max).
Period.

- **Not the API** (key, billed per token).
- **Not `claude -p` / the Agent SDK** (programmatic) — they leave the subscription.
- It is the **interactive claude**: the one the `channels` primitive targets (push into the live
  session), the one running on the operator's subscription.

**Assumed consequence: the coupling to the terminal is irreducible.** claude is a TUI ⇒ it needs a
**PTY** (ADR 0004), the bridge is **stdio** (channels — product side), etc. We do **not** try to make
it "pure API/headless": that path does not exist for us (subscription).

**Single-user (Terms clause).** Anthropic forbids **offering the claude.ai login / the rate-limits to
OTHER users** (multi-tenant product) without agreement. So: **the operator, solo, on their subscription
= OK**; opening access to others = grey zone → **out of scope** (the OIDC gate only lets the operator
through).

## Rationale

- **Why not the API** — per-token cost; it is not the model (we want the subscription).
- **Why not SDK/`-p`** — they leave the subscription (settled) ⇒ Damocles: we do not build the runtime
  on a mode whose billing is about to flip.
- **Why assume the terminal coupling** — it is the price of the subscription. The **TUI IS the
  runtime** supported by the subscription; the whole architecture (PTY, channels-stdio) follows from
  it, and it is coherent.
- **Why single-user** — the Terms clause; and anyway the pod/subscription is single-operator by
  construction (OIDC gate).

## Consequences

- The Claude runtime is a **TUI process** (PTY — ADR 0004), driven from outside via the **channel**
  (stdio, product) — not a headless API.
- The **bridge can NOT be a remote MCP**: channels = stdio (cf. `agora` ADR 0002) → co-located
  with the runtime.
- If Anthropic one day opened a programmatic mode **stable on subscription**, we could reconsider — but
  **we do not bet on it**.
- **Multi-tenant forbidden** without Anthropic's agreement → the platform stays single-user (OIDC
  gate, `infra-k8s` ADR 0021); to revisit only to open access (and then: agreement + a **per-user
  credential gateway / credential broker**).
- The **auth** of this runtime (how to connect to the subscription) = **ADR 0006**.
