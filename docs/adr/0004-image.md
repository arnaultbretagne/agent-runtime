# ADR 0004 — L'image agent-runtime : générique, non-root, deps bakées, état sur PVC

## Status

Proposed — 2026-06-30

## Context

Le MVP a été monté **à la main** dans un pod stock (`oven/bun`) : deps installées au runtime, `bun`
symlinké, onboarding/trust/bypass drivés au tmux, creds posées par login, claude+socat en sessions
tmux. **Non reproductible** — un restart perdait tout (deps apt, symlink, sessions). L'image doit
**figer ce qui doit l'être**, pour un démarrage **propre, identique, restart-safe**.

## Decision

L'image `agent-runtime` **bake l'infra, monte l'état, ignore le produit.**

**Bakées (image) :**

- Base **Node LTS** (image Debian-slim, pour `apt`), **user non-root** (skip-permissions l'exige —
  ADR 0003). *(Stack : le superviseur **et** le channel sont en **Node/TypeScript** — cf. Rationale.)*
- Deps système **bakées, pas installées au runtime** : `git`, `curl`, `ca-certificates`, `tini`.
  *(Le `socat` du MVP est abandonné : il ne servait qu'à ponter le serveur localhost de fakechat ;
  dans le design découplé le channel **se connecte au website en sortant**, aucun serveur entrant à
  ponter.)*
- **Le runtime du channel (`node`) sur un PATH standard** — sinon le spawn MCP du channel ne le
  trouve pas (leçon MVP, où c'était `bun` introuvable depuis le spawn).
- **Les binaires runtime** (Claude aujourd'hui ; l'image *bundle* les runtimes supportés — ADR 0002).
- **Le superviseur** (ADR 0001).
- **Le seed d'onboarding** dans `~/.claude.json` (racine du HOME) : onboarding / theme / trust du
  workdir / bypass **pré-acceptés** → **zéro prompt interactif**. Éphémère (re-seedé à chaque boot,
  ce ne sont que des flags).

**Montées (PVC, pas bakées) :**

- `~/.claude/.credentials.json` (auth — ADR 0006), `~/.claude/projects` (conversations),
  `~/.claude/plugins` (le **channel**, produit, installé là).
- → **le PVC est monté sur le dossier `~/.claude`** ; le fichier `~/.claude.json` (racine HOME) reste
  bakable/seedé. Ça sépare proprement **config-baked** et **état-persistant**.

**Hors image :** le channel (produit, plugin sur PVC), le website (pod séparé), les secrets (SOPS).

**PTY :** le superviseur **alloue lui-même un PTY par process** via **`node-pty`**, en détient le
master, garde le process vivant. **Pas de tmux/dtach** : un détenteur externe n'aurait de valeur que
pour faire survivre une session à un *restart-superviseur-sans-restart-pod* — qui n'existe pas (le
superviseur = le process principal du pod ⇒ s'il tombe, le pod redémarre et tout tombe, repris via
`--resume`). Le PTY satisfait juste le besoin de TTY du TUI ; **la conversation passe par le
channel**, pas par le PTY.

**Cycle de vie = version du runtime.** Une maj de Claude Code = **une nouvelle image** (couplage
voulu : l'image suit ses composants).

## Rationale

- **Pourquoi tout baker (vs install-au-runtime)** — le MVP l'a payé : non reproductible, perdu au
  restart, OOM en plein `apt`. Baker = démarrage déterministe + restart-safe.
- **Pourquoi non-root + runtime-du-channel-sur-PATH** — deux leçons dures : skip-permissions refuse
  root ; le spawn MCP du channel cherche son runtime sur un PATH standard.
- **Pourquoi Node (pas Bun)** — le superviseur a besoin d'un **PTY fiable** (`node-pty`, addon natif
  rock-solid sur Node, hasardeux sur Bun) ; et le **MCP SDK est node-natif**. Les atouts de Bun
  (vitesse, TS direct) ne valent pas le risque sur la seule dépendance critique (le PTY). Node = le
  choix sûr/standard pour le superviseur **et** le channel. *(fakechat-en-Bun n'était que la réf MVP
  jetable.)*
- **Pourquoi le split `~/.claude.json` (baked) vs `~/.claude/` (PVC)** — l'onboarding/trust/bypass
  sont statiques → bakables ; creds/convos/plugins sont de l'état → PVC. Monter le PVC sur le dossier
  `.claude` et laisser le fichier `.claude.json` bakable sépare les deux sans bricolage.
- **Pourquoi le superviseur possède le PTY (pas tmux)** — il est déjà propriétaire des process
  (ADR 0001) ; une lib pty suffit, sans multiplexeur externe. Le PTY n'est pas le canal d'I/O
  (c'est le channel).
- **Pourquoi cycle = version du runtime** — l'image ne change que quand ses composants changent
  (Claude Code, deps). C'est le couplage propre voulu.

## Consequences

- Démarrage **propre et identique** à chaque boot ; fin du bricolage manuel (le scratch pod du MVP
  *devient* cette image).
- L'image **grossit** avec les runtimes bundlés (Claude ; + Codex un jour) — acceptable.
- L'**auth** n'est pas dans l'image (PVC — ADR 0006) ; le **channel** non plus (produit, plugin PVC).
- **Ouvert** : les champs exacts de `~/.claude.json` à seeder (les noms ont bougé entre versions — à
  vérifier sur la version bakée).
