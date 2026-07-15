/**
 * GitHub App installation tokens (agent-broker plan P6.3).
 *
 * The App's private key lives here and nowhere else. From it we sign a short App JWT — which proves
 * "I am this App" and can touch nothing by itself — and exchange it for an **installation access
 * token** narrowed to exactly the permissions a profile earns.
 *
 * Verified live before this was written (against a throwaway App with `contents: write` on 9 repos):
 *   - asking for `contents: read` when the App has `write` yields a READ token; writing with it 403s;
 *   - asking for one repo makes every other repo in the same installation 404;
 *   - a token with `pull_requests: write` but no `contents` cannot even create a branch (403);
 *   - `contents: write` reaches the default branch — GitHub has NO permission that says
 *     "branches but not main". That line is drawn by the repository ruleset, not by this token.
 * GitHub lets you narrow, never widen. So the ceiling is Arnault's App; the narrowing is ours.
 *
 * The honest asymmetry vs the vault: git's HTTPS client needs a real credential, so this token DOES
 * enter the loge. It is bounded to ~1h, the profile's permissions, and (for write) a repo set that
 * excludes infra-k8s. A compromised loge can use it for that hour — which is exactly why the
 * ruleset, not this file, is what keeps it to "propose".
 *
 * Nothing here logs a token, a JWT, or the key.
 */
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** GitHub caps App JWTs at 10 minutes. Stay well inside it, and back-date `iat` to survive clock skew. */
const JWT_TTL_S = 540
const JWT_SKEW_S = 60
/** Re-mint an installation token this long before it expires (they last ~1h). */
const DEFAULT_MARGIN_MS = 5 * 60_000

export interface GitHubAppConfig {
  appId: string
  privateKeyPem: string
  apiBase?: string
  /** Pinned installation id. Omitted -> discovered (and re-discovered after a reinstall changes it). */
  installationId?: number
  marginMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
}

export interface TokenRequest {
  /** The exact permission set this profile earns, e.g. {contents: 'read', metadata: 'read'}. */
  permissions: Record<string, string>
  /** Repo names (not full slugs) to scope to. Omitted -> every repo in the installation. */
  repositories?: string[]
}

export interface MintedToken {
  token: string
  expiresAt: string
  permissions: Record<string, string>
  repositories: string[] | 'all'
}

export class GitHubTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GitHubTokenError'
  }
}

/** Cache key: identical requests share a token; different permissions or repo sets never do. */
const cacheKey = (r: TokenRequest): string =>
  JSON.stringify([Object.entries(r.permissions).sort(), [...(r.repositories ?? ['*'])].sort()])

interface Cached {
  minted: MintedToken
  expiresAtMs: number
}

export class GitHubAppTokens {
  private readonly byRequest = new Map<string, Cached>()
  private readonly inFlight = new Map<string, Promise<MintedToken>>()
  private installationId?: number
  private readonly apiBase: string
  private readonly margin: number
  private readonly now: () => number
  private readonly doFetch: typeof fetch

  constructor(private readonly cfg: GitHubAppConfig) {
    this.apiBase = cfg.apiBase ?? 'https://api.github.com'
    this.margin = cfg.marginMs ?? DEFAULT_MARGIN_MS
    this.now = cfg.now ?? Date.now
    this.doFetch = cfg.fetchImpl ?? fetch
    this.installationId = cfg.installationId
  }

  /** A token for exactly this permission set + repo scope. Cached until expiry minus the margin;
   *  concurrent identical asks share ONE mint. */
  async get(req: TokenRequest): Promise<MintedToken> {
    const key = cacheKey(req)
    const hit = this.byRequest.get(key)
    if (hit && this.now() < hit.expiresAtMs - this.margin) return hit.minted
    const flying = this.inFlight.get(key)
    if (flying) return flying
    const flight = this.mint(req, key).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, flight)
    return flight
  }

  /** Drop every cached token. Called when a lease is revoked: a token already handed to a loge cannot
   *  be recalled (GitHub has no revoke-by-value for installation tokens), but nothing new is issued,
   *  and the outstanding one dies on its own within the hour. That gap is real and is the reason the
   *  ruleset — not the token's lifetime — is what bounds an agent's blast radius. */
  invalidate(): void {
    this.byRequest.clear()
  }

  private appJwt(): string {
    const t = Math.floor(this.now() / 1000)
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
    const head = b64({ alg: 'RS256', typ: 'JWT' })
    const body = b64({ iss: this.cfg.appId, iat: t - JWT_SKEW_S, exp: t + JWT_TTL_S })
    const signer = createSign('RSA-SHA256')
    signer.update(`${head}.${body}`)
    // node:crypto, not a shell-out to openssl (plan P6.3): no argv, no temp file, no /bin/sh.
    return `${head}.${body}.${signer.sign(this.cfg.privateKeyPem, 'base64url')}`
  }

  private async api(path: string, jwt: string, init?: RequestInit): Promise<Response> {
    return this.doFetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'agent-broker',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(8000),
    })
  }

  /** The installation to mint against. Discovered rather than pinned by default: reinstalling the App
   *  mints a NEW installation id, and a pinned one would fail closed forever with a puzzling 404. */
  private async resolveInstallation(jwt: string): Promise<number> {
    if (this.installationId) return this.installationId
    const r = await this.api('/app/installations', jwt)
    if (!r.ok) throw new GitHubAppTokensError(`listing installations returned ${r.status}`, r.status)
    const list = (await r.json()) as Array<{ id: number; account?: { login?: string } }>
    if (list.length === 0) throw new GitHubAppTokensError('the App is installed nowhere')
    if (list.length > 1) {
      // Ambiguous: minting against the wrong account is exactly the confusion this refuses to guess at.
      throw new GitHubAppTokensError(`the App has ${list.length} installations — pin GITHUB_INSTALLATION_ID`)
    }
    this.installationId = list[0].id
    console.log(`[broker-github] installation ${this.installationId} (${list[0].account?.login})`)
    return this.installationId
  }

  private async mint(req: TokenRequest, key: string): Promise<MintedToken> {
    const jwt = this.appJwt()
    const installation = await this.resolveInstallation(jwt)
    const body: Record<string, unknown> = { permissions: req.permissions }
    if (req.repositories) body.repositories = req.repositories

    const r = await this.api(`/app/installations/${installation}/access_tokens`, jwt, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      // Never echo GitHub's body: it is attacker-influenceable and this message goes to logs.
      throw new GitHubAppTokensError(`installation token request returned ${r.status}`, r.status)
    }
    const j = (await r.json()) as {
      token?: string
      expires_at?: string
      permissions?: Record<string, string>
      repositories?: Array<{ full_name: string }>
    }
    if (!j.token || !j.expires_at) throw new GitHubAppTokensError('GitHub returned no token')

    const expiresAtMs = Date.parse(j.expires_at)
    // Plan P6.3 §5: a token that does not expire soon is not a token we asked for. An hour is the
    // documented ceiling; anything beyond it means we misunderstood the API, so refuse rather than
    // hand a long-lived credential to a loge on an assumption.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs - this.now() > 2 * 3600_000) {
      throw new GitHubAppTokensError(`refusing a token whose expiry is ${j.expires_at}`)
    }
    // GitHub grants the INTERSECTION of what we asked and what the App has. If it came back wider
    // than we asked, our model of the API is wrong — fail rather than pass a loge more than intended.
    for (const [scope, level] of Object.entries(j.permissions ?? {})) {
      if (req.permissions[scope] === undefined || (req.permissions[scope] === 'read' && level === 'write')) {
        throw new GitHubAppTokensError(`GitHub granted ${scope}=${level}, which we did not ask for`)
      }
    }

    const minted: MintedToken = {
      token: j.token,
      expiresAt: j.expires_at,
      permissions: j.permissions ?? {},
      // Derived from what we ASKED, not from what came back: GitHub's response shape for an unscoped
      // token is not something to infer a security-relevant field from. We know if we scoped.
      repositories: req.repositories ? (j.repositories ?? []).map((x) => x.full_name) : 'all',
    }
    if (req.repositories && minted.repositories !== 'all' && minted.repositories.length !== req.repositories.length) {
      // A scope we asked for that came back different means the token is not what we think it is.
      throw new GitHubAppTokensError(
        `asked for ${req.repositories.length} repo(s), got ${minted.repositories.length}`,
      )
    }
    this.byRequest.set(key, { minted, expiresAtMs })
    console.log(
      `[broker-github] minted ${JSON.stringify(minted.permissions)} on ${
        minted.repositories === 'all' ? 'all repos' : `${minted.repositories.length} repo(s)`
      }, expires ${minted.expiresAt}`,
    )
    return minted
  }

}

/** Alias kept short at the throw sites above. */
class GitHubAppTokensError extends GitHubTokenError {}

/** Read the App key from a mounted file first, env second — same reasoning as the vault adapter:
 *  `kubectl exec … env` and a crashed process's environ both miss a file. */
export function readAppKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.GITHUB_APP_KEY_FILE
  if (file) {
    try {
      const pem = readFileSync(file, 'utf8')
      if (pem.includes('PRIVATE KEY')) return pem
      console.error(`[broker-github] ${file} is not a PEM private key`)
    } catch (err) {
      console.error(`[broker-github] cannot read ${file}: ${(err as Error).message}`)
    }
    return undefined
  }
  const inline = env.GITHUB_APP_KEY
  return inline?.includes('PRIVATE KEY') ? inline : undefined
}
