/**
 * Capability profiles — the versioned catalogue (agent-runtime ADR 0012).
 *
 * The security authority for what a lease may do. A lease names a *profile*; the
 * broker maps that name to a fixed capability set here — never an arbitrary list
 * from the browser.
 *
 * No profile takes a `target` any more (P6). Scoping a repo per run was friction without safety:
 * GitHub has no permission that separates "push a branch" from "push main", so the line between
 * proposing and disposing is drawn by the repository RULESET, not by a token's repo scope — and
 * scoping READ protects nothing on repos that are public anyway. The target plumbing survives in
 * the types and the run facts (additive, harmless); nothing sets one.
 *
 * There is no repo deny-list either, including for `infra-k8s`. That was plan invariant #10, and it
 * is deliberately dropped: with the repository RULESET active (PR + an approving review the App
 * cannot give itself, no force-push, no deletion, App not a bypass actor), the deny-list only
 * stopped an agent from OPENING a pull request — noise, not compromise. Meanwhile it barred agents
 * from the infra work that is most of this platform's actual workload.
 *
 * What keeps an agent from editing what confines it is therefore, in order:
 *   1. it cannot merge — the ruleset requires a review, and nobody approves their own PR;
 *   2. it cannot disable the ruleset — the App has no `Administration` permission;
 *   3. a human reads the diff before approving. On infra-k8s that human must not be a rubber stamp:
 *      that repo's manifests ARE the confinement (NetworkPolicies, USE_BROKER, the catalogue).
 * Point 3 is process, not code, and this file cannot enforce it.
 */

export interface Profile {
  readonly name: string
  /** Human label + description: the ONLY prose the agora projection carries (agora ADR 0012 §5).
   *  Kept here so the catalogue stays the single source for what a profile is and is called. */
  readonly label: string
  readonly description: string
  readonly capabilities: readonly string[]
  readonly targetRequired: boolean
  readonly visible: boolean // exposed in the agora projection
  readonly enabled: boolean // gated rollout — P5/P6 flip these on
}

const profile = (
  name: string,
  label: string,
  description: string,
  capabilities: string[],
  targetRequired: boolean,
  visible: boolean,
  enabled: boolean,
): Profile => ({
  name,
  label,
  description,
  capabilities: Object.freeze(capabilities),
  targetRequired,
  visible,
  enabled,
})

/** The v1 catalogue (plan §2.2). Disabled/invisible profiles exist in code but are
 *  not grantable until their palier flips `enabled`. */
export const CATALOGUE: Readonly<Record<string, Profile>> = Object.freeze({
  'chat-v1': profile(
    'chat-v1',
    'Chat',
    'Conversation seule. Aucun accès au vault ni à un dépôt.',
    ['claude:invoke'],
    false,
    true,
    true,
  ),
  // ENABLED 2026-07-15 (P5). The credential chain behind it is proven live: the broker mints its own
  // Pocket-ID machine bearer, the vault MCP now gates on that client's `sub`, and a forged-audience
  // token from any other client is refused (403). `vault:full` stays deliberately coarse — the MCP
  // server cannot authorize per tool, so advertising a `vault:read` would be a scoping we cannot
  // actually enforce.
  'vault-v1': profile(
    'vault-v1',
    'Vault',
    'Lecture et écriture sur tout le vault Obsidian.',
    ['claude:invoke', 'vault:full'],
    false,
    true,
    true,
  ),
  // No target: scoping READ to one repo protects nothing — every repo is public, and the loge has no
  // internet, so the broker is already the only door. Asking the human to pick a repo up front just
  // broke the real workflow (this very migration spans four repos at once).
  'repo-read-v1': profile(
    'repo-read-v1',
    'Dépôts — lecture',
    'Lecture de tous tes dépôts GitHub.',
    ['claude:invoke', 'github:contents:read', 'github:metadata:read'],
    false,
    false,
    false,
  ),
  // No target either: GitHub has no permission that says "push branches but never main" (proven —
  // `contents: write` reaches the default branch, and without it an agent cannot even create a
  // branch). The line between proposing and disposing is drawn by the repository RULESET, not by the
  // token's repo scope. So scoping to one repo buys friction, not safety. Stays disabled until P6.6
  // proves the App cannot push to main nor merge its own PR.
  'repo-dev-v1': profile(
    'repo-dev-v1',
    'Dépôts — écriture',
    'Peut ouvrir des PR sur tes dépôts (jamais pousser sur main).',
    ['claude:invoke', 'github:metadata:read', 'github:contents:read', 'github:contents:write', 'github:pull_requests:write'],
    false,
    false,
    false,
  ),
  'repo-dev-vault-v1': profile(
    'repo-dev-vault-v1',
    'Dépôts — écriture + Vault',
    'Peut ouvrir des PR sur tes dépôts, plus tout le vault.',
    ['claude:invoke', 'vault:full', 'github:metadata:read', 'github:contents:read', 'github:contents:write', 'github:pull_requests:write'],
    false,
    false,
    false,
  ),
})

/** The profile every run gets when none is named: the floor, and the only one enabled before P5/P6.
 *  A hub that predates equipment (or a bare API call) lands here — never on a privileged profile. */
export const DEFAULT_PROFILE = 'chat-v1'

export function getProfile(name: string): Profile | undefined {
  return Object.prototype.hasOwnProperty.call(CATALOGUE, name) ? CATALOGUE[name] : undefined
}

const GITHUB_TARGET_RE = /^github:([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)$/

export type TargetResult =
  | { ok: true; target: string }
  | { ok: false; error: 'target_malformed' | 'target_denied'; detail?: string }

/** Parse + normalise a `github:<owner>/<repo>` target to canonical lowercase form; reject the
 *  deny-list first, then anything off the allow-list. */
export function normalizeTarget(raw: string): TargetResult {
  const lowered = raw.trim().toLowerCase()
  const m = GITHUB_TARGET_RE.exec(lowered)
  if (!m) return { ok: false, error: 'target_malformed', detail: 'expected github:<owner>/<repo>' }
  const slug = `${m[1]}/${m[2]}`
  return { ok: true, target: `github:${slug}` }
}

export type ProfileCheck =
  | { ok: true; profile: Profile; target: string | null }
  | {
      ok: false
      error: 'unknown_profile' | 'profile_disabled' | 'target_required' | 'target_forbidden' | 'target_malformed' | 'target_denied'
      detail?: string
    }

/**
 * The full gate a mint request must pass: the profile must exist and be enabled; a repo profile
 * requires a valid, allow-listed target; a non-repo profile forbids one. Returns the frozen profile
 * and the canonical target (or null).
 */
export function checkProfileTarget(profileName: string, rawTarget: string | null | undefined): ProfileCheck {
  const p = getProfile(profileName)
  if (!p) return { ok: false, error: 'unknown_profile' }
  if (!p.enabled) return { ok: false, error: 'profile_disabled' }
  const hasTarget = typeof rawTarget === 'string' && rawTarget.trim() !== ''
  if (p.targetRequired) {
    if (!hasTarget) return { ok: false, error: 'target_required' }
    const t = normalizeTarget(rawTarget as string)
    if (!t.ok) return { ok: false, error: t.error, detail: t.detail }
    return { ok: true, profile: p, target: t.target }
  }
  if (hasTarget) return { ok: false, error: 'target_forbidden', detail: 'this profile takes no target' }
  return { ok: true, profile: p, target: null }
}

export interface ProjectedProfile {
  name: string
  label: string
  description: string
  needsTarget: boolean
  visible: boolean
}

/**
 * The build-time projection agora consumes (agora ADR 0012 §5): what to CALL a profile and what
 * shape its form takes — never the capability lists, never `enabled`. agora renders it; the
 * manager stays the final authority and re-checks every mint against the real catalogue, so a
 * stale projection can only ever offer a profile the manager then refuses (fail-closed).
 *
 * `npm run print-projection` emits this as the JSON agora vendors in `shared/`.
 */
export function publicProjection(): ProjectedProfile[] {
  return Object.values(CATALOGUE).map((p) => ({
    name: p.name,
    label: p.label,
    description: p.description,
    needsTarget: p.targetRequired,
    visible: p.visible,
  }))
}

