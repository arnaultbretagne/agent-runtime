# ADR 0003 — Modèle de sécurité : le pod EST la frontière

## Status

Proposed — 2026-06-30

## Context

Le runtime fait tourner un agent qui **exécute du code généré par LLM** — donc sujet à l'injection
de prompt. Le réflexe classique serait de **durcir l'intérieur** du pod (readonly-fs,
micro-gestion des capabilities, egress ultra-restreint…). Mais **un agent trop bridé est inutile** :
il doit pouvoir installer des paquets, cloner du code public, browser, atteindre l'API Anthropic.
Et au fond, **si on se paie la complexité de k8s, c'est justement pour avoir des pods isolables** —
faire ce qu'on veut *dedans* sans crainte, parce que la **frontière** protège le reste.

Contexte concret : on bosse sur du **code public** (repos GitHub publics). Le token GitHub est donc
*low-stakes*. **La seule vraie crainte = fuiter des secrets d'infra.** Et l'agent **n'y a pas accès
par construction** (cf. les deux contrôles ci-dessous).

## Decision

**Le pod EST la frontière d'isolation. Dedans l'agent est libre ; dehors il est borné.**

On ne durcit **pas** l'intérieur (pas de readonly-fs paranoïaque, pas de capabilities micro-gérées
qui rendent l'agent débile). À la place, **deux contrôles de frontière — cheap et habilitants** :

1. **Pas d'accès à l'API K8s** : `automountServiceAccountToken: false`. Le pod ne porte **aucun**
   credential cluster.
2. **Egress = internet large, intra-cluster fermé** (CiliumNetworkPolicy) :
   - **allow** : internet (Anthropic, GitHub, npm/pip, browsing…), le **website** (le seul pair
     in-cluster dont le channel a besoin), et **DNS**.
   - **deny** : tout le reste de l'intra-cluster — kube-apiserver, pocket-id, CNPG, les autres
     apps/secrets.

Dedans, **`--dangerously-skip-permissions`** est acceptable *parce que* le pod est la sandbox
(l'agent est libre dans sa boîte). *(Le permission-relay via le channel — approuver les outils à
distance — reste une option future, cf. ADR channels du produit.)*

**Single-user** : un seul compte (l'opérateur) ; l'accès au website est gated OIDC (infra) et
l'abonnement est mono-tenant (contrainte Terms, ADR 0005).

## Rationale

- **Pourquoi pas de durcissement interne** — l'utilité de l'agent EXIGE qu'il soit libre dedans
  (installer, cloner, fetch). Le brider le casse. La valeur de k8s ici = la **frontière du pod**,
  pas mille restrictions internes.
- **Pourquoi ces deux contrôles précisément** — ils sont *la construction* sur laquelle repose
  « l'agent n'atteint pas l'infra ». No-SA-token + deny-intra-egress = l'agent fait ce qu'il veut
  **vers le dehors** mais est **aveugle au-dedans**, là où vivent les secrets infra. C'est ça qui
  borne le blast-radius.
- **Threat model honnête** — l'agent exécute du code LLM ⇒ injection possible. Mais que peut-il
  exfiltrer ? Le contenu de **son** pod : les creds d'abonnement Claude + du code public + un token
  GitHub scoped. **Aucun secret d'infra (inatteignable).** Les creds Claude qui fuiraient = ennuyeux
  mais **borné + rotatable**. On accepte l'egress internet large comme le coût d'un agent utile, la
  frontière protégeant les vrais actifs.
- **Disposabilité = sécurité** — le pod est jetable/remplaçable → une compromission **ne persiste
  pas** (nuke + recrée).

## Consequences

- Le pod agent-runtime tourne **non-root** (aussi requis par skip-permissions, cf. ADR Image),
  `automountServiceAccountToken: false`, sous une **CiliumNetworkPolicy** egress
  (internet + website + DNS ; deny le reste).
- L'agent est **libre dans le pod** (skip-permissions) ; pas de durcissement interne fragile.
- Le **website** doit être joignable depuis le pod runtime (allow ciblé) — le channel s'y connecte.
- **Multi-conv** : les N process partagent **le même pod = la même frontière** (acceptable :
  même opérateur, même confiance, code public). Pour isoler conv↔conv un jour (code privé, multi-user),
  il faudrait des **pods/frontières séparés** — hors scope aujourd'hui.
- Le token GitHub monté reste **scoped + low-stakes** (code public) ; à durcir si on touche du privé.
- **Ouvert** : permission-relay vs skip-permissions par défaut (le relay est plus « human-in-the-loop »
  mais fakechat ne le supporte pas ; notre channel pourrait) — affiné côté produit.
