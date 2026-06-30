# ADR 0002 — Runtime-agnostic : un runtime est un profil pluggable

## Status

Proposed — 2026-06-30

## Context

L'ADR 0001 a fait du superviseur quelque chose de paramétré par *« quel runtime »*. Cet ADR
l'acte : la plateforme doit pouvoir héberger **différents runtimes agent**, pas seulement Claude
Code. Aujourd'hui Claude est le primaire (c'est lui qui tourne sur l'abonnement de l'opérateur),
mais on veut pouvoir en instancier d'autres (Codex, OpenCode, …) **sans ré-architecturer**.

Point crucial : les runtimes agent **ne sont PAS interchangeables** :

- **L'auth/billing diffère** — Claude = OAuth abonnement (firstParty/Max) ; Codex = abonnement
  ChatGPT via son *App Server* ; OpenCode/Pi = clés API provider (≠ abonnement).
- **Le mécanisme de bridge diffère** — Claude *pousse* dans la session vivante via la primitive
  **`channels`** (MCP stdio) ; Codex expose un **App Server (JSON-RPC)** ; OpenCode expose
  **ACP / un flux SSE**. (cf. l'ADR adopter-vs-builder du produit / le scout.)

Donc « runtime-agnostic » ne doit **pas** prétendre que tous les runtimes sont équivalents — il
doit permettre au superviseur d'en héberger plusieurs, chacun portant ses spécificités.

## Decision

**Un runtime = un profil pluggable.** Le superviseur et l'image **ne codent pas Claude en dur.**
Un *profil de runtime* encapsule ce que le superviseur a besoin de savoir, et qui varie d'un
runtime à l'autre :

- **comment le spawn** (commande/args, ex. `claude --channels <channel>`),
- **son auth** (où vivent les creds, comment elles se refresh — ex. `~/.claude/.credentials.json`
  sur le PVC),
- **comment un bridge s'attache** (le mécanisme : Claude = un **channel** MCP stdio ; un autre
  runtime = son mécanisme natif),
- **où il persiste** sessions/history (ex. `~/.claude/projects` pour Claude).

Le `POST /sessions` du superviseur prend un paramètre `runtime` qui sélectionne le profil. On
**livre exactement un profil aujourd'hui — Claude** — et on garde l'abstraction **thin** (un profil
= un petit descripteur spawn/auth/bridge/persist, **pas** un framework de plugins). Les autres
profils ne sont ajoutés que si un besoin réel apparaît.

Deux axes d'agnosticisme distincts, à ne pas confondre :

- **Runtime-agnostic** (cet ADR) : *quel runtime* + son mécanisme de bridge natif = un paramètre.
- **Channel-agnostic** (à l'intérieur du profil Claude) : *quel* plugin channel MCP est attaché =
  un paramètre (fourni par le produit).

## Rationale

- **Pourquoi ne pas coder Claude en dur** — le job du superviseur (spawn/héberger/reaper des process
  agent interactifs avec un PTY) est réellement générique ; y enfouir des spécificités Claude
  forcerait une réécriture pour ajouter un 2ᵉ runtime et ferait fuiter du détail-runtime dans le
  cœur d'orchestration.
- **Pourquoi un « profil » (thin) et pas un framework** — on a exactement un runtime aujourd'hui.
  Un descripteur thin (spawn/auth/bridge/persist) capture ce qui varie sans machinerie spéculative.
  YAGNI sur un SDK de plugins.
- **Pourquoi garder auth/bridge DANS le profil** — c'est précisément ce qui diffère par runtime ;
  l'isoler là est *ce qui rend le superviseur générique*.
- **Honnêteté du périmètre** — runtime-agnostic ≠ « tous les runtimes sont égaux ». Seul Claude
  colle à la contrainte abonnement aujourd'hui (ADR 0005) ; OpenCode/Pi sont facturés API.
  L'abstraction parle d'*extensibilité sans réécriture*, pas d'une promesse de parité drop-in.

## Consequences

- Superviseur + image restent génériques ; Claude est « juste le premier profil ».
- Un profil de runtime **s'étale sur deux repos** : la **recette spawn/auth/PTY** ici (infra), et le
  **code du bridge** dans le repo produit (le channel qui relaie vers le protocole du website).
  Pour Claude : recette spawn = infra ; plugin channel = produit.
- Ajouter un runtime plus tard = un nouveau profil (recette infra) + un nouveau bridge (produit) +
  sa réalité auth/billing (qui peut ne pas coller au modèle abonnement — décision par-runtime).
- Le website parle un **protocole commun** ; le bridge de chaque runtime **normalise** son mécanisme
  natif vers ce protocole (le website est donc lui-même runtime-agnostic) — détaillé dans les ADR
  produit.
- **Ouvert** : la forme exacte d'un descripteur de « profil » (fichier de conf ? code ?) — à fixer
  si/quand un 2ᵉ runtime apparaît ; on ne sur-spécifie pas pour un seul runtime.
