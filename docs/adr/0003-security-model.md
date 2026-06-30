# ADR 0003 — Security model: the pod IS the boundary

## Status

Proposed — 2026-06-30

## Context

The runtime runs an agent that **executes LLM-generated code** — hence subject to prompt injection.
The classic reflex would be to **harden the inside** of the pod (readonly-fs, micro-managed
capabilities, ultra-restricted egress…). But **an over-restricted agent is useless**: it must be able
to install packages, clone public code, browse, reach the Anthropic API. And fundamentally, **if we
pay the complexity of k8s, it is precisely to get isolable pods** — do whatever we want *inside*
without fear, because the **boundary** protects the rest.

Concrete context: we work on **public code** (public GitHub repos). The GitHub token is therefore
*low-stakes*. **The only real fear = leaking infra secrets.** And the agent **has no access to them by
construction** (cf. the two controls below).

## Decision

**The pod IS the isolation boundary. Inside, the agent is free; outside, it is bounded.**

We do **not** harden the inside (no paranoid readonly-fs, no micro-managed capabilities that make the
agent dumb). Instead, **two boundary controls — cheap and enabling**:

1. **No access to the K8s API**: `automountServiceAccountToken: false`. The pod carries **no** cluster
   credential.
2. **Network = intra-cluster closed but for two declared holes** (CiliumNetworkPolicy):
   - **egress allow**: internet (Anthropic, GitHub, npm/pip, browsing…), the **website** (the only
     in-cluster peer the channel dials out to), and **DNS**.
   - **ingress allow**: the **website → the supervisor API** only (the control plane; the website is
     the supervisor's sole client — ADR 0001).
   - **deny**: all the rest of intra-cluster — kube-apiserver, pocket-id, CNPG, the other
     apps/secrets.

Inside, **`--dangerously-skip-permissions`** is the **default** *because* the pod is the sandbox (the
agent is free in its box). The permission mode is ultimately a **per-conversation parameter chosen
from agora** (passed through the spawn payload — ADR 0002); **permission-relay** via the channel
(approving tools remotely) is the **opt-in** alternative (`agora` ADR 0002).

**Single-user**: a single account (the operator); website access is OIDC-gated (`infra-k8s` ADR 0021)
and the subscription is single-tenant (Terms constraint, ADR 0005).

**The supervisor API is the one inbound surface — and it is not an exec channel.** It accepts a
**closed `kind` + structured params** (ADR 0002), never a raw command, so a compromised or abused
website cannot make the pod run arbitrary code; its reachability is locked to the website by the
ingress rule above.

## Rationale

- **Why no internal hardening** — the agent's usefulness REQUIRES it to be free inside (install,
  clone, fetch). Restraining it breaks it. The value of k8s here = the **pod boundary**, not a
  thousand internal restrictions.
- **Why these two controls precisely** — they are *the construction* on which "the agent does not
  reach the infra" rests. No-SA-token + deny-intra-egress = the agent does whatever it wants
  **outward** but is **blind inward**, where the infra secrets live. That is what bounds the
  blast-radius.
- **Honest threat model** — the agent executes LLM code ⇒ injection possible. But what can it
  exfiltrate? The contents of **its** pod: the Claude subscription credentials + public code + a
  scoped GitHub token. **No infra secret (unreachable).** Leaked Claude credentials = annoying but
  **bounded + rotatable**. We accept broad internet egress as the cost of a useful agent, the boundary
  protecting the real assets.
- **Disposability = security** — the pod is disposable/replaceable → a compromise **does not persist**
  (nuke + recreate).

## Consequences

- The agent-runtime pod runs **non-root** (also required by skip-permissions, cf. Image ADR),
  `automountServiceAccountToken: false`, under an egress **CiliumNetworkPolicy** (internet + website +
  DNS; deny the rest).
- The agent is **free inside the pod** (skip-permissions); no fragile internal hardening.
- The **website** must be reachable from the runtime pod (targeted allow) — the channel connects to
  it.
- **Multi-conv**: the N processes share **the same pod = the same boundary** (acceptable: same
  operator, same trust, public code). To isolate conv↔conv one day (private code, multi-user), it
  would take **separate pods/boundaries** — out of scope today.
- The mounted GitHub token stays **scoped + low-stakes** (public code); to harden if we touch private
  code.
- **Decided**: **skip-permissions is the default** (above); the mode becomes a per-conversation
  parameter from agora, with **relay** as the opt-in (more "human-in-the-loop"; fakechat doesn't
  support it, our channel could) — `agora` ADR 0002.
