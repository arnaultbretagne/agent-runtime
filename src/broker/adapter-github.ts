/**
 * GitHub adapter (dist/broker/adapter-github.js) — holds the GitHub App private key ONLY.
 *
 * P6.3/P6.4. Unlike the vault adapter, this one does NOT proxy: git's HTTPS client needs a real
 * credential in the loge, so this vends one. `POST /v1/github/token` returns an installation access
 * token narrowed to the lease's profile — and nothing else.
 *
 * What each profile earns (capability -> permission set lives here, beside the catalogue, so agora
 * names a profile and never learns what it unlocks):
 *
 *   github:contents:read      -> {contents: read, metadata: read}   on ALL installed repos
 *   github:contents:write     -> {contents: write, pull_requests: write, metadata: read}
 *                                on all installed repos EXCEPT the deny-list
 *
 * No per-run repo target. Scoping READ buys nothing (the repos are public, and a loge has no
 * internet — the broker is already the only door), and scoping WRITE buys nothing either: GitHub has
 * no permission separating "push a branch" from "push main" (proven — `contents: write` reaches the
 * default branch, and without it an agent cannot even branch). The line between proposing and
 * disposing is drawn by the repository RULESET. A repo scope would only have broken the real
 * workflow, where one change spans several repos at once.
 *
 * So the deny-list is the single hard line, and it is enforced by CONSTRUCTION: a write token is
 * minted with an explicit repository list that excludes it, so GitHub itself refuses — the agent
 * does not hold a credential that can reach infra-k8s at all.
 */
import { startAdapter, type AdapterHandler, type AdapterClaims } from './adapter-common.js'
import { getProfile, deniedForWrite } from './profiles.js'
import { GitHubAppTokens, readAppKey, type MintedToken } from './github-token.js'

const TOKEN_PATH = '/v1/github/token'

export interface GitHubForwarderOpts {
  tokens: GitHubAppTokens
}

function sendJson(res: { writeHead: Function; end: Function }, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The permission set a profile's capabilities earn — never wider than the capability says. */
export function permissionsFor(claims: AdapterClaims): { permissions: Record<string, string>; write: boolean } | undefined {
  const caps = getProfile(claims.profile)?.capabilities
  if (!caps) return undefined
  if (caps.includes('github:contents:write')) {
    return {
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      write: true,
    }
  }
  if (caps.includes('github:contents:read')) {
    return { permissions: { contents: 'read', metadata: 'read' }, write: false }
  }
  return undefined
}

export function createGitHubForwarder(opts: GitHubForwarderOpts): AdapterHandler {
  return (req, res, claims) => {
    void (async () => {
      if (!claims.leaseId) return sendJson(res, 401, { error: 'no_broker_claim' })

      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path !== TOKEN_PATH) return sendJson(res, 404, { error: 'not_found' })

      const want = permissionsFor(claims)
      if (!want) return sendJson(res, 403, { error: 'capability_denied' })

      try {
        let repositories: string[] | undefined
        if (want.write) {
          // Enforced by construction: the deny-listed repo is left OUT of the token's repo list, so
          // GitHub refuses it — rather than us trusting a check somewhere downstream to hold.
          const all = await opts.tokens.listRepositories()
          repositories = all.filter((r) => !deniedForWrite(r.full_name)).map((r) => r.name)
          const denied = all.length - repositories.length
          if (denied > 0) console.log(`[broker-github] write scope excludes ${denied} deny-listed repo(s)`)
          if (repositories.length === 0) return sendJson(res, 403, { error: 'no_writable_repositories' })
        }

        const minted: MintedToken = await opts.tokens.get({ permissions: want.permissions, repositories })
        // Only the token and its bounds. The loge gets what git needs and not one field more —
        // no installation id, no App id, no JWT.
        sendJson(res, 200, {
          token: minted.token,
          expiresAt: minted.expiresAt,
          permissions: minted.permissions,
          repositories: minted.repositories,
        })
      } catch (err) {
        // Shape only: GitHubTokenError never carries GitHub's body.
        console.error(`[broker-github] mint failed for lease ${claims.leaseId}: ${(err as Error).message}`)
        sendJson(res, 502, { error: 'credential_unavailable' })
      }
    })()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const privateKeyPem = readAppKey()
  const appId = process.env.GITHUB_APP_ID
  if (!privateKeyPem || !appId) {
    const missing = [!appId && 'GITHUB_APP_ID', !privateKeyPem && 'GITHUB_APP_KEY_FILE|GITHUB_APP_KEY'].filter(Boolean)
    console.warn(`[broker-github] unconfigured (503) — missing: ${missing.join(', ')}`)
    startAdapter('github', (_req, res) => sendJson(res, 503, { error: 'adapter_unconfigured' }))
  } else {
    const installationId = process.env.GITHUB_INSTALLATION_ID ? Number(process.env.GITHUB_INSTALLATION_ID) : undefined
    console.log(`[broker-github] configured: app=${appId}${installationId ? ` installation=${installationId}` : ' (installation discovered)'}`)
    startAdapter('github', createGitHubForwarder({ tokens: new GitHubAppTokens({ appId, privateKeyPem, installationId }) }))
  }
}
