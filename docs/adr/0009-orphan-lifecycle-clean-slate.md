# ADR 0009 — Orphan lifecycle: a supervisor owns exactly what it spawned (clean-slate invariant)

## Status

Proposed — 2026-07-03. Reliability hardening of ADR 0001 (the supervisor *is* the process manager, so it
must not leak processes). Prerequisite for **agora ADR 0008**, whose state model trusts
`GET /sessions/:id` to tell the truth about terminal liveness — that trust only holds if there are no
runtimes alive that the supervisor doesn't track.

## Context

The supervisor spawns each runtime as a PTY child (`supervisor.ts`). Two gaps let `claude` processes
outlive the supervisor's knowledge of them:

- **No shutdown handler.** `index.ts` registers **no `SIGTERM`/`SIGINT` handler**. When the supervisor
  process is told to stop (`run.sh stop`, a pod termination, a crash-restart of the node process inside a
  living container), it dies **without killing its children**. The PTY master closing *may* send `SIGHUP`
  to the child, but empirically `claude --channels` processes have survived — leaving **orphans** that keep
  RAM, keep a stale channel WS, and (worst) can make a conversation look alive when its supervisor is gone.
- **`onExit` never forgets.** `onExit` (`supervisor.ts:94`) marks a dead session `status:'exited'` but never
  removes it, so the registry accumulates dead entries. (This is *deliberately* kept short-term — the hub
  reads `exitCode` off it for the state model, agora ADR 0008 — but it needs a GC.)

A pod **restart** is not the problem: it tears down the whole PID namespace, so nothing survives. The
problem is precisely the **supervisor process bouncing inside a still-running container** — the `run.sh
stop` case — where children can be reparented to init and live on.

## Decision

**Enforce one invariant: a running supervisor owns exactly the runtimes it spawned — and a freshly started
one owns none.** Two mechanisms, primary + backstop:

1. **Kill-on-shutdown (primary).** `index.ts` installs `SIGTERM`/`SIGINT` handlers that, before exiting,
   kill every tracked session: `proc.kill('SIGTERM')` on each, a short grace (~2 s), then `SIGKILL` the
   stragglers, then exit. This makes the normal stop path (`run.sh stop`, k8s pod termination honouring
   `terminationGracePeriodSeconds`) leave **zero** orphans — they are killed *before* they can be orphaned.

2. **Boot-sweep (backstop).** On startup, **before `server.listen()`**, the supervisor SIGKILLs any runtime
   process alive in its PID namespace — because a fresh supervisor has spawned none, anything runtime-shaped
   that is already running is, by definition, an orphan from a previous incarnation. This catches the case
   where kill-on-shutdown never ran (`SIGKILL`, OOM, hard crash). The match is **scoped to the runtimes' own
   commands** (the baked `RUNTIMES[kind].command` / `claude --channels`), never a blind `pkill`, and it is
   safe because it runs before any spawn can exist.

3. **Intentional kills carry no `exitCode`.** Every supervisor-initiated termination (idle/connect reap,
   `killAll` on shutdown, an explicit `DELETE`) sets an `intentional` flag on the session *before*
   `proc.kill()`, so `onExit` **suppresses the exit code** (it records `exited` with `reason:'reaped'`, no
   code). A `SIGTERM` otherwise surfaces as exit 143 and the hub would mis-read a deliberate reap as a
   **crash** (`error`/red). The rule the state model relies on (agora ADR 0008): **exitCode present ⇒
   unexpected ⇒ error; absent ⇒ deliberate ⇒ dormant.**

4. **`onExit` GC.** A voluntary kill already deletes its entry immediately (current `kill()` behaviour), so
   only *crash* entries linger as `exited`. Keep those briefly so the hub can read the `exitCode`, then drop
   (a short TTL, comfortably longer than the hub's ~2–5 s reconcile — 60 s is ample). With continuous
   reconcile the read-vs-GC race is a non-issue; the TTL is just an anti-accumulation bound.

## Rationale

- **The invariant is the whole point of a process manager.** ADR 0001 makes the supervisor responsible for
  reaping; a manager that leaks its children on its own shutdown fails its one job. Kill-on-shutdown is the
  missing half.
- **Boot-sweep makes the invariant self-healing**, not merely best-effort: even after a path that skipped
  cleanup, the *next* boot restores "owns exactly what it spawned = none." No manual orphan-hunting.
- **It is what lets agora ADR 0008 trust the supervisor.** The state model reads terminal liveness from
  `GET /sessions/:id`; that read is only honest if no untracked runtime is alive. This ADR guarantees it.
- **Scoped, ordered, and pod-safe.** Matching the runtime command (not a blind kill) and sweeping before
  `listen()` means the backstop can never harm a legitimate session, and it is a harmless no-op after a pod
  restart (nothing survived to sweep).

## Consequences

- **`index.ts`:** add `SIGTERM`/`SIGINT` handlers (kill-all + grace + exit) and a pre-`listen` boot-sweep.
- **`supervisor.ts`:** a `killAll()` used by the shutdown handler; an `onExit` GC for exited entries.
- **Deployment:** ensure the pod's `terminationGracePeriodSeconds` comfortably exceeds the shutdown grace
  (~2 s) so k8s does not `SIGKILL` the supervisor mid-drain.
- **No API/registry change**, no product coupling — this is pure lifecycle hygiene, stays infra (ADR 0002).
- **Open:** the exact boot-sweep discovery (walk `/proc` for the runtime command vs. track PIDs in a small
  on-disk file the sweep reconciles against). `/proc`-scan is simplest and needs no persistence; a PID file
  is more precise but adds state. Leaning `/proc`-scan by command match.
