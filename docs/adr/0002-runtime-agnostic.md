# ADR 0002 — The supervisor spawns opaque processes; runtimes wire themselves

## Status

Proposed — 2026-06-30

## Context

We want to be able to host different runtimes (Claude today; maybe Codex/OpenCode later) without
re-architecting. The temptation is a "runtime profile" abstraction (spawn/auth/bridge/persist
descriptors) so the supervisor *knows how to manage* each runtime. That is over-engineering: at
bottom, the platform's need is **just to run processes**.

## Decision

**The supervisor spawns opaque processes. Nothing more.**

```
POST   /sessions {command}  → start the process, return an id
DELETE /sessions/:id        → kill
GET    /sessions            → list
```

The supervisor has **no notion** of runtime, channel, auth, or "profile". It **does not interpret**
what it launches.

**Wiring is the process's job.** A runtime process is responsible for fetching what it needs to
**wire itself to the website**: Claude fetches/uses its **channel** (an MCP plugin); a future Codex
would fetch its **own bridge** (App-Server relay), different from a channel. **That bridge code lives
in the product repo**, and it is the *process* that pulls it in — not the supervisor.

So **runtime-agnosticism is structural, not a feature**: because the supervisor only knows how to
"launch a process", any runtime works, as long as the process knows how to wire itself.

## Rationale

- **Zero templating / zero profile framework.** We have a single runtime. A profile abstraction
  (auth/bridge/persist descriptors) = speculative machinery. The honest minimum: spawn a process.
- **The process is the right owner of its wiring.** Auth, fetching the bridge, connecting to the
  site — that is runtime-specific and self-contained; hoisting it into the supervisor would re-couple
  it to every runtime (exactly what we avoid).
- **What varies per runtime stays out of the supervisor**: the spawn command (a string) + the wiring
  code (in the product repo). Neither becomes an abstraction in the infra.

## Consequences

- **The supervisor stays trivially generic** (a process manager) and its **code does not change**
  when a runtime is added.
- **But adding a runtime is neither free nor magic.** Concretely, adding Codex requires:
  1. **baking its binary/deps into the `agent-runtime` image** — the image **bundles the runtimes it
     supports**, it is not runtime-empty (infra);
  2. a **Codex bridge in the product repo** (≠ channel — e.g. its App-Server relay);
  3. caller-side, **asking the supervisor to spawn a `codex`** (not a `claude`) — a runtime selector
     + an id.

  The process's "self-wiring" = its **connection to the site** (fetching its bridge + connecting),
  **not** the appearance of its binary.
- The split, then: **infra = the image (supervisor + env + runtime binaries)**; **product = the
  bridges + the website + how to launch a wired runtime**.
- Only Claude sticks to the subscription today (ADR 0005); other runtimes carry their own
  auth/billing reality.
- Allocating a **PTY** (runtimes are TUIs) stays a **generic** capability of the supervisor
  (spawn-with-PTY), not per-runtime knowledge → Image ADR (0004).
- **Open**: where the runtime selector / command comes from (website per-call vs configured) + the
  session id — a detail to settle as needed.
