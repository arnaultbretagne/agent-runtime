/**
 * Capability profiles — the versioned catalogue (agent-runtime ADR 0012).
 *
 * The security authority for what a lease may do. A lease names a *profile*; the
 * broker maps that name to a fixed capability set here — never an arbitrary list
 * from the browser. `target` (repo profiles) is normalised to lowercase, checked
 * against an allow-list, and `infra-k8s` is hard-denied regardless of what the
 * GitHub App is actually installed on (plan invariant #10).
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
  'vault-v1': profile(
    'vault-v1',
    'Vault',
    'Lecture et écriture sur tout le vault Obsidian.',
    ['claude:invoke', 'vault:full'],
    false,
    false,
    false,
  ),
  'repo-read-v1': profile(
    'repo-read-v1',
    'Dépôt — lecture',
    'Lecture seule du dépôt choisi.',
    ['claude:invoke', 'github:contents:read', 'github:metadata:read'],
    true,
    false,
    false,
  ),
  'repo-dev-v1': profile(
    'repo-dev-v1',
    'Dépôt — écriture',
    'Lecture et écriture sur le dépôt choisi.',
    ['claude:invoke', 'github:metadata:read', 'github:contents:read', 'github:contents:write'],
    true,
    false,
    false,
  ),
  'repo-dev-vault-v1': profile(
    'repo-dev-vault-v1',
    'Dépôt — écriture + Vault',
    'Lecture et écriture sur le dépôt choisi, plus tout le vault.',
    ['claude:invoke', 'vault:full', 'github:metadata:read', 'github:contents:read', 'github:contents:write'],
    true,
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

/** Repos an agent may ever target. Refined in P6 (owner/repo -> repository ID). `infra-k8s`
 *  is hard-denied below and MUST NOT appear here — defence in depth, plan invariant #10. */
export const REPO_ALLOWLIST: ReadonlySet<string> = new Set([
  'arnaultbretagne/agora',
  'arnaultbretagne/agent-runtime',
  'arnaultbretagne/obsidian-stack',
])
/** Denied before any GitHub call, whatever the allow-list or the App's installation says. */
export const REPO_DENYLIST: ReadonlySet<string> = new Set(['arnaultbretagne/infra-k8s'])

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
  if (REPO_DENYLIST.has(slug)) return { ok: false, error: 'target_denied', detail: 'repository is deny-listed' }
  if (!REPO_ALLOWLIST.has(slug)) return { ok: false, error: 'target_denied', detail: 'repository not on the allow-list' }
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

/** The repos an allow-listed target may name, projected for agora's autocomplete (ADR 0012 §6:
 *  a controlled list, never a free URL). Deny-listed repos are excluded by construction. */
export function projectedTargets(): string[] {
  return [...REPO_ALLOWLIST].filter((slug) => !REPO_DENYLIST.has(slug)).sort()
}
