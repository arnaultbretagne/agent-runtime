# ADR 0001 — Thin generic supervisor (runtime session manager)

## Status

Proposed — 2026-06-30

## Context

The platform must run **multiple parallel agent conversations**. A single Claude Code process
is **one conversation** — there is no parallel multi-session inside a process (the channels
reference is explicit: *"To process independent event streams concurrently, run separate
sessions."*). So **N parallel conversations = N runtime processes.**

Those processes must be **spawned and reaped on demand**: the website says *"new conversation"*
→ a runtime process must start; a conversation ends/idles → it should be reaped.

Two hard placement facts:

- The website (the **product**) lives in a **separate pod**. It cannot fork processes inside the
  runtime pod.
- Spawning a runtime **must be co-located** with the runtime: the process needs the runtime
  binary, the auth credentials (PVC), and the channel plugin **in the same container filesystem**.
  Cross-pod / cross-container spawning does not provide that.

So we need a small **control plane inside the runtime pod** — and a clean boundary that keeps the
runtime image **infra** (no product logic leaking in).

## Decision

Ship a **thin, generic supervisor** in the `agent-runtime` image: a **runtime session manager**
exposing a minimal control API.

```
POST   /sessions      → spawn a session (a runtime process + its channel) ; returns a session id
GET    /sessions      → list active sessions
DELETE /sessions/:id  → kill / reap a session
GET    /sessions/:id  → status / health
```

A **session** = exactly one runtime process (e.g. `claude --channels <channel>`), PTY-hosted,
with its own channel attached. The supervisor is:

- **Runtime-agnostic** (see ADR 0002): *which* runtime to spawn is a parameter — Claude first,
  others pluggable.
- **Channel-agnostic**: *which* channel to attach is a parameter (the product supplies it as a
  plugin).
- **Thin**: it carries **no product logic** — no conversation semantics, no UI, no message
  routing, no history. It only manages **process lifecycle**. That is what keeps it *infra*.

The supervisor's API **is the bridge** between the website (product) and the runtime pod: the
website *drives* it, the supervisor *executes*. Message relay itself does **not** go through the
supervisor — each channel relays its own session's messages directly to the website (see the
product ADRs); the supervisor owns only lifecycle.

## Rationale

- **Why a supervisor at all** — multi-conv means processes spawned on demand; the website cannot
  reach into the runtime pod to fork them. A local control plane is required.
- **Why co-located** — it `exec`s runtime processes that need the binary + auth + channel in the
  same filesystem. That forces it into the runtime pod, not the website pod.
- **Why thin/generic ⇒ infra (not product)** — if the supervisor knew what a *conversation* is, or
  did routing/history/UI, it would couple infra to product and its lifecycle would track the
  product. Kept thin, its lifecycle tracks **only its components** (the runtime / Claude Code
  version): *a Claude Code bump = an image bump.* That is exactly the coupling we want.
- **Why an API (not shared FS / signals)** — a clear contract decouples website↔runtime: the
  website needs only `spawn/kill/list`, nothing about *how* a process runs.
- **Why lifecycle-only (relay goes direct channel→website)** — routing every message through the
  supervisor would drag product concerns (conversation identity, ordering) into infra. Keeping the
  supervisor to lifecycle, and letting each channel relay its own stream, preserves the boundary.

## Consequences

- The supervisor is the **only control plane** inside the runtime pod; the website is its only
  client (channels self-register to the website for message relay — product side).
- It is **shipped in, and versioned with, the `agent-runtime` image.**
- **RAM scales with active sessions** (N × runtime footprint). Capacity limits / sharding across
  pods are downstream concerns (Image ADR / deployment), not the supervisor's.
- The **runtime and channel are parameters**, not hardcoded → enables ADR 0002 (runtime-agnostic)
  and the product's pluggable channel.
- **Open / deferred:**
  - PTY hosting per session (how the supervisor allocates a PTY for each runtime) → Image ADR (0004).
  - Sharing one credential across N processes (refresh-token rotation) → Auth ADR (0006).
  - Auth/transport of the supervisor API itself (it must only be reachable by the website, in-cluster).
