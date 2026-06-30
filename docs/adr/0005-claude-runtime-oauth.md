# ADR 0005 — Runtime Claude = le TUI interactif sur l'abonnement OAuth

## Status

Proposed — 2026-06-30

## Context

Claude Code se pilote de plusieurs façons : le **TUI interactif** (sur abonnement), le mode
**headless `claude -p`** / l'**Agent SDK** (programmatique), ou via l'**API Anthropic** (clé,
facturée au token). Il faut choisir **comment notre runtime Claude tourne.**

Contrainte dure (connaissance opérateur) : **`claude -p` et l'Agent SDK vont être SORTIS de
l'abonnement** (Anthropic a temporisé, mais c'est acté). Bâtir dessus = **épée de Damoclès** : le
jour où ça bascule en facturation API, tout le dev repose sur un mode qui coûte au token. Et l'**API**
elle-même est exclue (coût, ce n'est pas le modèle voulu).

## Decision

**Le runtime Claude = le TUI interactif `claude`, sur l'abonnement OAuth** (firstParty / Max). Point.

- **Pas l'API** (clé, facturée au token).
- **Pas `claude -p` / l'Agent SDK** (programmatique) — ils quittent le forfait.
- C'est le **claude interactif** : celui que la primitive `channels` cible (push dans la session
  vivante), celui qui tourne sur l'abonnement de l'opérateur.

**Conséquence assumée : le couplage au terminal est irréductible.** claude est un TUI ⇒ il faut un
**PTY** (ADR 0004), le bridge est **stdio** (channels — côté produit), etc. On ne cherche **pas** à
le rendre « pur API/headless » : ce chemin n'existe pas pour nous (forfait).

**Single-user (clause Terms).** Anthropic interdit d'**offrir le login claude.ai / les rate-limits à
d'AUTRES utilisateurs** (produit multi-tenant) sans accord. Donc : **l'opérateur, solo, sur son
abonnement = OK** ; ouvrir l'accès à d'autres = zone grise → **hors scope** (le gate OIDC ne laisse
passer que l'opérateur).

## Rationale

- **Pourquoi pas l'API** — coût au token ; ce n'est pas le modèle (on veut le forfait).
- **Pourquoi pas SDK/`-p`** — ils sortent de l'abonnement (acté) ⇒ Damoclès : on ne bâtit pas le
  runtime sur un mode dont le billing va basculer.
- **Pourquoi assumer le couplage terminal** — c'est le prix du forfait. Le **TUI EST le runtime**
  supporté par l'abonnement ; toute l'archi (PTY, channels-stdio) en découle, et c'est cohérent.
- **Pourquoi single-user** — la clause Terms ; et de toute façon le pod/abonnement est mono-opérateur
  par construction (gate OIDC).

## Consequences

- Le runtime Claude est un **process TUI** (PTY — ADR 0004), piloté de l'extérieur via le **channel**
  (stdio, produit) — pas une API headless.
- Le **bridge ne peut PAS être un MCP remote** : channels = stdio (cf. ADR channels, produit) →
  co-localisé avec le runtime.
- Si Anthropic ouvrait un jour un mode programmatique **stable sur abonnement**, on pourrait
  reconsidérer — mais **on ne parie pas dessus**.
- **Multi-tenant interdit** sans accord Anthropic → la plateforme reste single-user (gate OIDC) ; à
  revisiter seulement pour ouvrir l'accès (et alors : accord + un credential-gateway type OneCLI).
- L'**auth** de ce runtime (comment se connecter à l'abonnement) = **ADR 0006**.
