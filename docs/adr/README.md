# Architecture Decision Records — agent-runtime

Ordre = importance (le superviseur est le cœur).

1. [0001 — Superviseur thin générique](0001-thin-supervisor.md) — **Proposed**
2. [0002 — Le superviseur spawn des process opaques (runtimes se câblent eux-mêmes)](0002-runtime-agnostic.md) — **Proposed**
3. [0003 — Modèle de sécurité : le pod est la frontière](0003-security-model.md) — **Proposed**
4. [0004 — L'image (générique, non-root, deps bakées, état sur PVC, PTY)](0004-image.md) — **Proposed**
5. [0005 — Runtime Claude : le TUI interactif sur l'abonnement OAuth](0005-claude-runtime-oauth.md) — **Proposed**
6. [0006 — Auth : `claude auth login` + creds sur PVC RW, bootstrap par Job](0006-auth.md) — **Proposed**
