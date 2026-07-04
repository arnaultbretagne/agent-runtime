# agent-runtime

**Infra** brick: a generic image + a **thin supervisor** that instantiates and manages **agent
runtime sessions** (Claude Code first) inside a Kubernetes pod. Each session runs an interactive
agent on its subscription, connected to the outside through a **channel** (a stdio MCP server the
agent spawns itself).

This repo is **product-agnostic**: it knows how to *run processes* (runtime sessions), nothing
about conversations, the UI, or any specific channel/website. The product (channel + website) lives
in its own repo and plugs into this one.

Design decisions: see [`docs/adr/`](docs/adr/).

## ⚠️ Headless channel spawn — the gate checklist (READ THIS before debugging "stuck `starting`")

A runtime spawned as `claude --channels plugin:<p>@<m>` only reaches the hub if its channel
**MCP server actually spawns**. If any gate below fails, the failure is **silent and identical**:
the hub conversation sits in `starting` forever — **no reply, no error, no channel log written, and
the hub never logs `channel attached`** (the `hello` never arrives because the MCP server was never
started). This exact symptom has been root-caused **more than once** at real token cost; do not
re-derive it — walk the gates.

Diagnostic (from inside the supervisor container): spawn once with `CHANNEL_LOG=/tmp/x.log` in the
env and `--debug-file /tmp/c.log` in the args. **If `/tmp/x.log` is never written, the channel MCP
server never spawned → it's a gate below (usually gate C).** The bridge itself is almost never the
bug — confirm by running `node <plugin>/server.js` standalone with the `CHANNEL_*` env: it will
`mcp_connected → ws_connecting → claude_ready` and dial the hub fine.

The gates, all required, and each independently sufficient to cause the silent hang:

| Gate | What it is | How it's satisfied | State |
|------|-----------|--------------------|-------|
| **A — channel is a declared plugin** | `plugin.json` has top-level `channels:[{server:"<mcp>"}]`; `.mcp.json` declares that server; plugin installed + `enabledPlugins:{"<p>@<m>":true}` | static, in the plugin + `~/.claude/settings.json` | ✅ in place |
| **B — channel org allowlist** | subscription (firstParty) sessions are org-gated: `managed-settings.json` needs `channelsEnabled:true` + `allowedChannelPlugins:[{marketplace,plugin}]`, else *"plugin … is not on the approved channels allowlist"* | baked in the image at `/etc/claude-code/managed-settings.json` | ✅ in place |
| **C — `.mcp.json` MCP-server APPROVAL** 🔴 | **the recurring trap.** Since claude **2.1.153 / 2.1.196**, a plugin `.mcp.json` server is `⏸ Pending approval` and **is NOT spawned** until approved. Headless (node-pty, no operator) **cannot answer the interactive approval prompt** → server stays pending → channel dead. Shows up as `1 setup issue: MCP` at startup. | **`--dangerously-skip-permissions` in the spawn args** (see below) | ⚠️ **the fix — must be wired into `spawnSpec`** |
| **D — reply tool allow** | the `reply` tool must be permitted | `--allowedTools mcp__plugin_<p>_<s>__reply` | ✅ in place |

### Gate C — the durable fix and the traps that are NOT durable

**Durable fix: pass `--dangerously-skip-permissions` in the runtime spawn args.** Proven to make the
channel MCP server spawn (`mcp_connected → claude_ready`, hub `hello` arrives). Requirements/rationale:
- **Requires a non-root user** — the image runs as `node`, so ✓. This is the **ADR 0003 in-boundary
  posture**: the runtime pod *is* the sandbox, so bypassing permission prompts *inside* it is by design.
- Do **not** rely on approving the server via `.claude.json` (`enableAllProjectMcpServers` /
  `enabledMcpjsonServers` in the project scope): it works for one spawn but **claude rewrites
  `~/.claude.json` on every startup and STRIPS the flag** → reverts to `undefined` → not durable.
  (The seed `image/claude.json.seed` sets it, but the running file loses it — do not chase this.)
- Do **not** use `--dangerously-load-development-channels`: it is **not headless-seedable** and always
  shows a blocking warning prompt. The channel must be an **installed/approved plugin** run via
  `--channels plugin:<p>@<m>`, never a dev-loaded `server:` (FINDINGS §4/§5).

**Two distinct permission gates — do not conflate them** (this conflation is why C keeps getting
re-discovered): gate **D** is the *reply-tool* permission (handled by `--allowedTools`); gate **C** is
the *MCP-server-spawn* approval (needs `--dangerously-skip-permissions`). `--allowedTools` covering
`reply` does **not** approve the server's spawn. The 2026-07-01 note "skip-permissions not needed"
was about D and is **obsolete for C** since the 2.1.153/2.1.196 approval tightening.

Full spike write-up: [`/srv/spike/FINDINGS.md`](../spike/FINDINGS.md) §1–§5. Image/permission posture:
[`docs/adr/0003`](docs/adr/) and [`docs/adr/0004-image.md`](docs/adr/0004-image.md).
