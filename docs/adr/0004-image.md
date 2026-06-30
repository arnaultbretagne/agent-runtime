# ADR 0004 — The agent-runtime image: generic, non-root, baked-in deps, state on PVC

## Status

Proposed — 2026-06-30

## Context

The MVP was set up **by hand** in a stock pod (`oven/bun`): deps installed at runtime, `bun` symlinked,
onboarding/trust/bypass driven through tmux, credentials laid down by login, claude+socat in tmux
sessions. **Not reproducible** — a restart lost everything (apt deps, symlink, sessions). The image
must **freeze what must be frozen**, for a **clean, identical, restart-safe** startup.

## Decision

The `agent-runtime` image **bakes the infra, mounts the state, ignores the product.**

**Baked-in (image):**

- Base **Node LTS** (Debian-slim image, for `apt`), **non-root user** (skip-permissions requires it —
  ADR 0003). *(Stack: the supervisor **and** the channel are in **Node/TypeScript** — cf. Rationale.)*
- System deps **baked-in, not installed at runtime**: `git`, `curl`, `ca-certificates`, `tini`. *(The
  MVP's `socat` is dropped: it only served to bridge fakechat's localhost server; in the decoupled
  design the channel **connects outward to the website**, no inbound server to bridge.)*
- **The channel's runtime (`node`) on a standard PATH** — otherwise the channel's MCP spawn does not
  find it (MVP lesson, where it was `bun` not found from the spawn).
- **The runtime binaries** (Claude today; the image *bundles* the supported runtimes — ADR 0002).
- **The supervisor** (ADR 0001).
- **The onboarding seed** in `~/.claude.json` (HOME root): onboarding / theme / workdir trust / bypass
  **pre-accepted** → **zero interactive prompt**. Ephemeral (re-seeded at each boot, these are just
  flags).

**Mounted (PVC, not baked-in):**

- `~/.claude/.credentials.json` (auth — ADR 0006), `~/.claude/projects` (conversations),
  `~/.claude/plugins` (the **channel**, product, installed there).
- → **the PVC is mounted on the `~/.claude` directory**; the `~/.claude.json` file (HOME root) stays
  bakable/seeded. This cleanly separates **baked config** and **persistent state**.

**Out of image:** the channel (product, plugin on PVC), the website (separate pod), the secrets (SOPS).

**PTY:** the supervisor **allocates a PTY per process itself** via **`node-pty`**, holds the master,
keeps the process alive. **No tmux/dtach**: an external holder would only have value to make a session
survive a *supervisor-restart-without-pod-restart* — which does not exist (the supervisor = the pod's
main process ⇒ if it falls, the pod restarts and everything falls, resumed via `--resume`). The PTY
just satisfies the TUI's TTY need; **the conversation goes through the channel**, not the PTY.

**Lifecycle = runtime version.** A Claude Code update = **a new image** (intended coupling: the image
tracks its components).

## Rationale

- **Why bake everything (vs install-at-runtime)** — the MVP paid for it: not reproducible, lost on
  restart, OOM mid-`apt`. Baking = deterministic startup + restart-safe.
- **Why non-root + channel-runtime-on-PATH** — two hard lessons: skip-permissions refuses root; the
  channel's MCP spawn looks for its runtime on a standard PATH.
- **Why Node (not Bun)** — the supervisor needs a **reliable PTY** (`node-pty`, a native addon
  rock-solid on Node, dicey on Bun); and the **MCP SDK is node-native**. Bun's strengths (speed, direct
  TS) do not outweigh the risk on the single critical dependency (the PTY). Node = the safe/standard
  choice for the supervisor **and** the channel. *(fakechat-in-Bun was only the disposable MVP
  reference.)*
- **Why the `~/.claude.json` (baked) vs `~/.claude/` (PVC) split** — onboarding/trust/bypass are static
  → bakable; credentials/convos/plugins are state → PVC. Mounting the PVC on the `.claude` directory
  and leaving the `.claude.json` file bakable separates the two without hacks.
- **Why the supervisor owns the PTY (not tmux)** — it already owns the processes (ADR 0001); a pty lib
  suffices, with no external multiplexer. The PTY is not the I/O channel (the channel is).
- **Why lifecycle = runtime version** — the image changes only when its components change (Claude Code,
  deps). That is the intended clean coupling.

## Consequences

- **Clean and identical** startup at each boot; end of manual fiddling (the MVP's scratch pod *becomes*
  this image).
- The image **grows** with the bundled runtimes (Claude; + Codex one day) — acceptable.
- The **auth** is not in the image (PVC — ADR 0006); neither is the **channel** (product, PVC plugin).
- **Open**: the exact fields of `~/.claude.json` to seed (names have shifted between versions — to
  verify against the baked version).
