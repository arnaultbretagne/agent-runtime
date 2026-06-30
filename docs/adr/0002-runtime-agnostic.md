# ADR 0002 — The supervisor spawns by `kind`, from a closed registry; runtimes wire themselves

## Status

Proposed — 2026-06-30

## Context

We want to host different runtimes (Claude today; maybe Codex/OpenCode later) without
re-architecting. Two traps to avoid **at once**:

- **Over-engineering** a "runtime profile" abstraction (spawn/auth/bridge/persist descriptors) so the
  supervisor *understands* each runtime — speculative machinery for a single runtime.
- **Under-specifying** to "the supervisor runs an opaque `{command}` string" — because if that string
  comes from the website, it is an **arbitrary-exec channel** from the product into the infra pod (a
  real security hole, cf. ADR 0003).

## Decision

**The supervisor spawns by `kind`, resolved against a closed, baked-in registry. It forwards
structured params without interpreting them. No product logic.**

```
POST   /sessions {kind, id?, ...params}  → resolve kind→argv (baked registry), spawn, return an id
GET    /sessions                          → list
GET    /sessions/:id                      → status / health
DELETE /sessions/:id                      → kill / reap
```

- **`kind` ∈ a closed set** (`claude`; tomorrow `codex`), **never a raw command string**. The
  supervisor maps `kind → argv` via a **registry baked into the image** (the image already bundles the
  runtimes it supports — ADR 0004).
- **`...params` is an extensible, structured payload** — e.g. the model, known flags, the channel
  selector, the permission mode, a resume target. The supervisor **forwards** these to the invocation
  **without interpreting** them. The payload **can grow** (new flags/params) without the supervisor
  learning runtime semantics.
- So the supervisor has **no product/conversation logic, no auth/profile/routing/history** — it
  resolves a `kind` and forwards params. That is what keeps it **infra**.

**Wiring is still the process's job.** Once spawned, a runtime wires *itself* to the website: Claude
loads/uses its **channel** (a product plugin on the PVC); a future Codex would pull its **own bridge**
(e.g. an App-Server relay). **That bridge code lives in the product repo**, and the *process* pulls it
in — not the supervisor.

So **runtime-agnosticism is structural**: the supervisor only knows "resolve a kind, spawn, forward
params"; any runtime works as long as (a) its binary is in the image and (b) the process knows how to
wire itself.

## Rationale

- **Why `kind` + a closed registry (not `{command}`)** — it gives runtime-agnosticism **and** closes
  the exec-injection vector: the website picks from a **whitelist**, it cannot ask the infra pod to run
  an arbitrary command. The `kind → argv` map is **infra config** (baked), not product input.
- **Why an extensible *structured* payload (not a free string)** — we *will* need to pass a model, a
  flag, a resume target, a channel, a permission mode (cf. ADR 0003, ADR 0006, and the product).
  Structured params cover that **without** reopening "arbitrary command" and **without** the supervisor
  interpreting them.
- **Why no profile framework** — a profile abstraction (auth/bridge/persist descriptors) is speculative
  machinery for one runtime. The honest minimum: resolve a kind, spawn, forward params.
- **Why the process owns its wiring** — auth, fetching the bridge, connecting to the site is
  runtime-specific and self-contained; hoisting it into the supervisor would re-couple it to every
  runtime (exactly what we avoid).

## Consequences

- **The supervisor stays trivially generic** (resolve-kind + process manager) and its **code does not
  change** when a runtime is added.
- **But adding a runtime is neither free nor magic.** Adding Codex requires:
  1. **baking its binary/deps into the `agent-runtime` image** (the image **bundles the runtimes it
     supports** — it is not runtime-empty);
  2. **adding its `kind → argv` entry** to the baked registry;
  3. a **Codex bridge in the product repo** (≠ channel — e.g. its App-Server relay);
  4. caller-side, **asking the supervisor for `kind: codex`** (+ id + any params).
- **Security**: because the API takes a **closed `kind` + structured params** (never a raw command),
  there is **no arbitrary-exec vector** from product into the infra pod (made explicit in ADR 0003).
- **The channel is not interpreted by the supervisor** — it's a product plugin the runtime loads itself
  (`agora` ADR 0002/0003). Whether it is selected via a forwarded **flag** (e.g. `--channels …`) or via
  **PVC plugin config** is an **open mechanism to validate by spike** (ADR 0004) — either way the
  supervisor only *forwards*, it does not understand the channel.
- The split: **infra = the image (supervisor + env + runtime binaries + the `kind` registry)**;
  **product = the bridges + the website + which `kind`/params to launch**.
- Only Claude sticks to the subscription today (ADR 0005); other runtimes carry their own auth/billing
  reality.
- Allocating a **PTY** (runtimes are TUIs) stays a **generic** supervisor capability (spawn-with-PTY),
  not per-runtime knowledge → Image ADR (0004).
- **Open**: where the `kind`/params come from per call (website-driven) + the session id — settled with
  the product.
