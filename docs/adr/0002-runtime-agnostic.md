# ADR 0002 — Le superviseur spawn des process opaques ; les runtimes se câblent eux-mêmes

## Status

Proposed — 2026-06-30

## Context

On veut pouvoir héberger différents runtimes (Claude aujourd'hui ; peut-être Codex/OpenCode plus
tard) sans ré-architecturer. La tentation est une abstraction « profil de runtime » (des
descripteurs spawn/auth/bridge/persist) pour que le superviseur *sache gérer* chaque runtime.
C'est de la sur-ingénierie : au fond, le besoin de la plateforme est **juste de faire tourner des
process**.

## Decision

**Le superviseur spawn des process opaques. Rien de plus.**

```
POST   /sessions {command}  → lance le process, renvoie un id
DELETE /sessions/:id        → kill
GET    /sessions            → list
```

Le superviseur n'a **aucune notion** de runtime, de channel, d'auth, ni de « profil ». Il
**n'interprète pas** ce qu'il lance.

**Le câblage est le job du process.** Un process runtime est responsable d'aller chercher ce qu'il
lui faut pour **se câbler au website** : Claude récupère/utilise son **channel** (un plugin MCP) ;
un futur Codex irait chercher son **propre bridge** (relais App-Server), différent d'un channel.
**Ce code de bridge vit dans le repo produit**, et c'est le *process* qui va le piocher — pas le
superviseur.

Donc le **runtime-agnosticisme est structurel, pas une feature** : parce que le superviseur ne sait
que « lancer un process », n'importe quel runtime marche, du moment que le process sait se câbler.

## Rationale

- **Zéro templating / zéro framework de profils.** On a un seul runtime. Une abstraction de profil
  (descripteurs auth/bridge/persist) = de la machinerie spéculative. Le minimum honnête : spawn un
  process.
- **Le process est le bon propriétaire de son câblage.** Auth, récupération du bridge, connexion au
  site — c'est spécifique au runtime et auto-contenu ; le remonter dans le superviseur le
  re-coupterait à chaque runtime (exactement ce qu'on évite).
- **Ce qui varie par runtime reste hors du superviseur** : la commande de spawn (une string) + le
  code de câblage (dans le repo produit). Aucun des deux ne devient une abstraction dans l'infra.

## Consequences

- Le superviseur reste **trivialement générique** (un gestionnaire de process). Ajouter un runtime =
  un nouveau process qui se câble tout seul (son bridge vit dans le produit) → **zéro changement
  côté superviseur**.
- `agent-runtime` (infra) livre : l'image de base (binaires runtime + env) **+ le superviseur bête**.
  **Le câblage (channel/bridge + comment lancer un runtime câblé) est produit**, pas infra.
- Seul Claude colle à l'abonnement aujourd'hui (ADR 0005) ; les autres runtimes portent leur propre
  réalité auth/billing — mais c'est l'affaire du *process*, pas du superviseur.
- L'allocation d'un **PTY** (les runtimes sont des TUI) reste une capacité **générique** du
  superviseur (spawn-with-PTY), pas une connaissance par-runtime → détaillé dans l'ADR Image (0004).
- **Ouvert** : d'où vient la commande de spawn (le website par-appel vs configurée) — un détail, à
  fixer au besoin.
