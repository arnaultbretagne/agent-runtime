# Architecture Decision Records — agent-runtime

Order = importance (the supervisor is the core).

1. [0001 — Thin generic supervisor](0001-thin-supervisor.md) — **Proposed**
2. [0002 — The supervisor spawns opaque processes (runtimes wire themselves)](0002-runtime-agnostic.md) — **Proposed**
3. [0003 — Security model: the pod is the boundary](0003-security-model.md) — **Proposed**
4. [0004 — The image (generic, non-root, baked-in deps, state on PVC, PTY)](0004-image.md) — **Proposed**
5. [0005 — Claude runtime: the interactive TUI on the OAuth subscription](0005-claude-runtime-oauth.md) — **Proposed**
6. [0006 — Auth: `claude auth login` + credentials on RW PVC, bootstrap via Job](0006-auth.md) — **Proposed**
