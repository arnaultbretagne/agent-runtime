# Architecture Decision Records — agent-runtime

Ordre = importance (le superviseur est le cœur).

1. [0001 — Superviseur thin générique](0001-thin-supervisor.md) — **Proposed**
2. [0002 — Le superviseur spawn des process opaques (runtimes se câblent eux-mêmes)](0002-runtime-agnostic.md) — **Proposed**
3. 0003 — Modèle de sécurité : le pod est la frontière — *planned*
4. 0004 — L'image (générique, non-root, deps bakées, cycle = version du runtime, hôte-PTY) — *planned*
5. 0005 — Runtime Claude : le TUI interactif sur l'abonnement OAuth — *planned*
6. 0006 — Auth : `claude auth login` + creds sur PVC (méthode de bootstrap à trancher) — *planned*
