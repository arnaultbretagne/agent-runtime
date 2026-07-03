# ADR 0008 — Idle-reaping in the supervisor: a generic `touch` + `idleTtlMs`, still thin

## Status

Proposed — 2026-07-03. **Fulfils ADR 0001** (*"a conversation ends/idles → it should be reaped"* — the
mechanism was missing and had temporarily landed in the hub) within the bounds of **ADR 0002** (forward
structured params, interpret none). Companion to **agora ADR 0008**, which owns the *policy* side (the TTL
value and the decision to emit a heartbeat).

## Context

The platform needs live-but-idle runtimes reaped once their server-side prompt cache has lapsed: past that
point, keeping the process alive buys nothing (a re-seed / `--resume` is an equally-cold reprocess — agora
ADR 0007), so the RAM should be reclaimed. ADR 0001 always assigned reaping to the supervisor; the first
implementation instead ran the timer in the **hub**, keyed on an in-memory `lastTurnAt`. That value is lost
on every hub restart, so a re-claim granted a fresh full grace window regardless of real activity
(*fresh-1h*). The clock belongs with the process it governs.

The obstacle ADR 0002 raises: the supervisor must stay **infra** — no conversation semantics. And it is
**blind to turns**: messages flow hub↔channel↔runtime and never traverse the supervisor, so it cannot know
on its own when a session was last active.

## Decision

**The supervisor gains a generic idle-reap capability parameterised entirely by the caller. It interprets
neither the threshold nor the activity — it only does arithmetic on numbers the hub gives it.**

Two additions to the control API:

- **`idleTtlMs` — a spawn-time param** (part of the ADR 0002 structured payload, top-level in
  `POST /sessions`, *not* forwarded into the child's argv/env). An **opaque duration**: the supervisor does
  not know it means "the harness cache TTL", only "reap this session after this much idle".
- **`POST /sessions/:id/touch` — a lifecycle heartbeat.** Marks a session active *now*. The supervisor keeps
  one per-session `lastTouch`, **initialised at spawn**, refreshed on each touch. It attaches **no meaning**
  to a touch — it does not know a "turn" exists; it only records "the caller says this session is active".

A generic **idle sweep** (single supervisor timer, not per-session) kills any session where
`now − lastTouch ≥ idleTtlMs`, via the `DELETE /sessions/:id` path. Spawn is a valid clock start because a
runtime is *only ever* spawned to process a pending message — there is no "spawned but idle-waiting" state,
so **one clock** (no connect-timeout, no `claimed` flag) covers both a healthy idle runtime and a spawn that
never produced a turn. A session spawned without `idleTtlMs` is **never auto-reaped** (opt-in; other `kind`s
or ad-hoc sessions are unaffected). Startup failures (channel never connects, runtime never replies) are
surfaced fast as `error` by the **product** (agora ADR 0008's harness axis: `unresponsive` / startup grace);
the supervisor only needs to reclaim their RAM at the idle TTL — no urgency, no special timer.

The **hub is the sole toucher**: it sees every turn and already drives this API. When the supervisor reaps,
the PTY dies and the drop propagates to the hub through the normal channel-WS teardown (agora ADR 0008's
state composition) — the supervisor emits no product event, it just ends a process.

## Rationale

- **Stays thin (ADR 0002).** `idleTtlMs` and `touch` are structured, opaque inputs — a number and a ping.
  The supervisor learns nothing about conversations, turns, history, or *why* the TTL is what it is. Reaping
  is process-lifecycle, which is exactly its job (ADR 0001), now parameterised instead of hardcoded.
- **The clock survives hub restarts.** `lastTouch` lives beside the PTY, so a hub restart / re-claim does
  not reset it — provided the hub touches **only on real turns, never on reconnect** (the discipline is on
  the *emitter*, agora side). *Fresh-1h* is gone by construction.
- **Opt-in and generic.** No `idleTtlMs` → no reaping. Works for any future `kind` without the supervisor
  knowing that kind's caching model — the caller supplies the number.

## Consequences

- **API surface:** `POST /sessions` accepts an optional `idleTtlMs`; new `POST /sessions/:id/touch`;
  a supervisor-wide idle sweep. `GET /sessions/:id` remains the **authority on terminal liveness** that the
  hub reads for its state composition (agora ADR 0008 §1) — its truthfulness about process death is assumed
  here and hardened separately (the orphan/onExit follow-up).
- **No image/runtime change** beyond the supervisor code; the `kind` registry is untouched.
- **Security (ADR 0003):** `touch` is idempotent, side-effect-limited to a timestamp, and — like the rest of
  the API — reachable only by the in-cluster website. `idleTtlMs` is a bounded number, not exec/env input.
- **No re-adoption of live processes.** `lastTouch` lives only in-memory beside a live registry entry. A
  hub restart leaves the supervisor (and its `lastTouch`) untouched; a supervisor restart kills its PTY
  children with it (nothing to cadence). The murky third case — a `claude` orphaned *past* a supervisor
  restart — is a **bug to remove, not a state to reconstruct**: on shutdown the supervisor kills its
  children, and on boot it sweeps strays to a clean slate (specified in **ADR 0009**). So the
  supervisor never re-adopts a live session and `lastTouch` never needs seeding from anything but a spawn.
