/**
 * Pocket-ID machine token provider (agent-broker plan P5.3).
 *
 * Mints the broker's own `client_credentials` bearer for the Vault MCP and keeps it in memory. This
 * is the ONLY place the client secret is used, and the resulting bearer never leaves the vault
 * adapter's process: a loge holds an opaque lease and nothing else.
 *
 * Verified facts this is built on (`/srv/artifacts/vault-mcp-machine-token-findings.md`, live):
 *   - grant `client_credentials` with a plain `client_secret` (no federated JWT);
 *   - `resource=<vault url>` is echoed into `aud` (RFC 8707) — that is how the vault MCP binds the
 *     token to itself, so the parameter is mandatory, not decorative;
 *   - `expires_in = 3600`, and **no refresh token** is issued: the only renewal is a re-mint.
 *
 * Nothing here logs a token, a secret, or a provider response body — an error path that echoes the
 * IdP's payload is how bearers end up in a log aggregator (plan P5.3: "masque toute erreur contenant
 * un token").
 */
import { readFileSync } from 'node:fs'

export interface TokenProviderOpts {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  /** RFC 8707 `resource` — becomes the token's `aud`. */
  resource: string
  /** Re-mint this long before expiry, covering clock skew and the request itself. */
  marginMs?: number
  /** Test seams. */
  now?: () => number
  fetchImpl?: typeof fetch
}

interface CachedToken {
  token: string
  /** Absolute ms epoch, derived from `expires_in` at mint time. */
  expiresAt: number
}

const DEFAULT_MARGIN_MS = 60_000

export class TokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'TokenError'
  }
}

export class PocketIdTokenProvider {
  private cached?: CachedToken
  /** The in-flight mint, if any — every concurrent caller awaits this ONE promise (single-flight).
   *  Without it, a burst of MCP calls arriving on an expired token would fire N identical
   *  client_credentials requests at the IdP and race to overwrite each other's cache entry. */
  private inFlight?: Promise<string>
  private readonly margin: number
  private readonly now: () => number
  private readonly doFetch: typeof fetch

  constructor(private readonly opts: TokenProviderOpts) {
    this.margin = opts.marginMs ?? DEFAULT_MARGIN_MS
    this.now = opts.now ?? Date.now
    this.doFetch = opts.fetchImpl ?? fetch
  }

  /** The current bearer: cached while it is comfortably valid, otherwise minted (once, however many
   *  callers ask at the same moment). */
  async get(): Promise<string> {
    const cached = this.cached
    if (cached && this.now() < cached.expiresAt - this.margin) return cached.token
    if (this.inFlight) return this.inFlight
    const flight = this.mint().finally(() => {
      if (this.inFlight === flight) this.inFlight = undefined
    })
    this.inFlight = flight
    return flight
  }

  /** Drop the cached token — called when the vault rejects it (401), so the ONE retry re-mints
   *  instead of replaying the same rejected bearer. Covers the cases a TTL cannot see: the token
   *  revoked at the IdP, or the client's secret rotated under us. */
  invalidate(): void {
    this.cached = undefined
  }

  /** Test/introspection aid: when the cached token expires (undefined = nothing cached). */
  get expiresAt(): number | undefined {
    return this.cached?.expiresAt
  }

  private async mint(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      // Mandatory: this is what binds the token to the vault (aud), and the vault refuses anything else.
      resource: this.opts.resource,
    })
    // client_secret_basic (advertised by Pocket-ID): the secret rides in the Authorization header
    // rather than the form body, so it stays out of any request-body logging on the way.
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64')

    let res: Response
    try {
      res = await this.doFetch(this.opts.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      // The IdP is unreachable/slow. Report the shape, never the request we sent.
      throw new TokenError(`pocket-id unreachable: ${(err as Error).name}`)
    }

    if (!res.ok) {
      // Deliberately NOT echoing the body: an OAuth error payload is attacker-influenced and this
      // message travels to logs. The status is what an operator needs.
      throw new TokenError(`pocket-id token endpoint returned ${res.status}`, res.status)
    }

    let payload: { access_token?: unknown; expires_in?: unknown; token_type?: unknown }
    try {
      payload = (await res.json()) as typeof payload
    } catch {
      throw new TokenError('pocket-id returned a non-JSON token response')
    }

    const token = typeof payload.access_token === 'string' ? payload.access_token : ''
    if (!token) throw new TokenError('pocket-id returned no access_token')

    // No refresh token is expected (standard client_credentials) — if one ever appears we ignore it
    // rather than build a second, untested renewal path.
    const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600
    this.cached = { token, expiresAt: this.now() + expiresIn * 1000 }
    console.log(`[broker-vault] minted a machine token, valid ${expiresIn}s`)
    return token
  }
}

/**
 * Read the client secret from a mounted file first, env second.
 *
 * A file is the safer home: `kubectl exec … env`, a crashed process's environ, and anything that
 * dumps the environment all miss it, and it can be rotated by updating the Secret without rebuilding
 * the pod spec. The env var stays as a fallback so the adapter is testable outside k8s.
 */
export function readClientSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.POCKET_ID_CLIENT_SECRET_FILE
  if (file) {
    try {
      const secret = readFileSync(file, 'utf8').trim()
      if (secret) return secret
      console.error(`[broker-vault] ${file} is empty`)
    } catch (err) {
      console.error(`[broker-vault] cannot read ${file}: ${(err as Error).message}`)
    }
    return undefined
  }
  return env.POCKET_ID_CLIENT_SECRET || undefined
}
