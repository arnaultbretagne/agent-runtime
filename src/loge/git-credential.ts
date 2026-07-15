/**
 * `git credential` helper for a loge (agent-broker plan P6.4).
 *
 * Unlike the vault — which the broker proxies, so no vault credential ever exists inside a loge —
 * git's HTTPS client needs a real credential in the loge. This helper is what puts it there, and it
 * is deliberately the only thing that does: it answers git on a pipe, then exits. The token is never
 * written to `~/.git-credentials`, never spliced into a remote URL, never passed as an argument.
 *
 * Why that is worth a program instead of an env var: a loge records the agent's session (the Claude
 * transcript under ~/.claude, and the PTY log under /logs). A token pasted onto a command line —
 * `git clone https://x-access-token:ghs_…@github.com/…` — is a live credential written into both,
 * and into `.git/config` on top. Fetching it per-call over a pipe leaves no copy anywhere, and the
 * token expires within the hour regardless.
 *
 * THE HOST CHECK IS THE ONE CONTROL HERE THAT IS NOT COSMETIC. git offers credentials to whatever
 * host it is aimed at, and a repository chooses its own submodule URLs (`.gitmodules`) — so without
 * it, cloning any hostile public repo hands that repo's author a GitHub token. That is the realistic
 * threat: not that the agent is malicious, but that the content it was asked to read is.
 *
 * It is NOT a defence against the agent itself, and nothing here is. The loge has world egress on
 * 443 (deliberately — Claude Code has hardcoded api.anthropic.com endpoints), and /app is writable
 * by uid 1000, so an agent that WANTS to leak its token can simply ask the broker itself. What
 * actually bounds a stolen token is elsewhere: the repository ruleset (it cannot merge — that needs
 * a review it cannot give itself), the App (no `Administration` permission, so it cannot switch the
 * ruleset off), and the hour the token lives.
 */

/** GitHub's documented username for an installation token; the token itself is the password. */
const USERNAME = 'x-access-token'
const GITHUB_HOST = 'github.com'
const TIMEOUT_MS = 10_000

export interface HelperEnv {
  AGENT_BROKER_URL?: string
  AGENT_BROKER_TOKEN?: string
}

export type HelperOutcome =
  | { kind: 'credential'; username: string; password: string }
  | { kind: 'silent'; reason: string }

/**
 * git writes `key=value` lines and ends the request with a blank line.
 *
 * Unknown keys are ignored by design rather than rejected: git ≥2.46 also sends `wwwauth[]` and
 * `capability[]`, and a helper that choked on a key it did not recognise would break the day git
 * adds the next one.
 */
export function parseRequest(stdin: string): Record<string, string> {
  const req: Record<string, string> = {}
  for (const line of stdin.split('\n')) {
    if (line === '') break // a blank line terminates the request
    const eq = line.indexOf('=')
    if (eq > 0) req[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return req
}

/**
 * Decide what to answer. Returns a credential, or silence with a reason — never throws, because a
 * credential helper that dies mid-protocol turns a clean "no credentials" into a git error the agent
 * cannot interpret.
 */
export async function handle(
  operation: string | undefined,
  req: Record<string, string>,
  env: HelperEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<HelperOutcome> {
  // `store` is git offering to cache the credential; `erase` is git asking us to forget it. Both are
  // answered with silence, and that silence IS the feature: this helper wrote the token nowhere, so
  // there is nothing to cache and nothing to forget.
  if (operation !== 'get') {
    return { kind: 'silent', reason: `nothing to ${operation ?? '(no operation)'} — this helper keeps no credential` }
  }

  // The check that matters. Everything else in this file is plumbing.
  if (req.protocol !== 'https' || req.host !== GITHUB_HOST) {
    return { kind: 'silent', reason: `refusing to offer a GitHub token to ${req.protocol ?? '?'}://${req.host ?? '?'}` }
  }

  const base = env.AGENT_BROKER_URL
  const lease = env.AGENT_BROKER_TOKEN
  if (!base || !lease) return { kind: 'silent', reason: 'this loge holds no broker lease — no GitHub access' }

  let res: Response
  try {
    res = await fetchImpl(`${base}/v1/github/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lease}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: 'silent', reason: `broker unreachable: ${(err as Error).message}` }
  }

  if (!res.ok) {
    // Status only. The broker's body is not echoed: this reason is printed inside the loge, where
    // the transcript would keep whatever it contained.
    const why = res.status === 403 ? "this run's equipment grants no repository access" : `broker returned ${res.status}`
    return { kind: 'silent', reason: `no GitHub token: ${why}` }
  }

  const body = (await res.json().catch(() => ({}))) as { token?: unknown }
  if (typeof body.token !== 'string' || !body.token) return { kind: 'silent', reason: 'broker returned no token' }
  return { kind: 'credential', username: USERNAME, password: body.token }
}

/** Read git's request. Bounded: a helper that blocks forever on a stdin nobody closes would hang the
 *  git command that spawned it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(argv: string[]): Promise<void> {
  const operation = argv[2]
  // Always drain stdin, including for store/erase: git writes the credential to us and closes. A
  // helper that exits without reading gives git a broken pipe on a call that should be a no-op.
  const stdin = await readStdin()
  const outcome = await handle(operation, parseRequest(stdin), process.env, fetch)

  if (outcome.kind === 'credential') {
    // The one and only place this token is ever written: git's pipe, on stdout. Not a file, not
    // argv, not a log line.
    process.stdout.write(`username=${outcome.username}\npassword=${outcome.password}\n\n`)
    return
  }
  // Silence on stdout is how a credential helper says "not me" — git then falls through to its own
  // behaviour, which with no terminal is a clean failure rather than a hang. Exit 0: a non-zero exit
  // makes git abort the whole operation with "credential helper failed", which would turn "this
  // profile has no repo access" into an unreadable error. The reason goes to stderr, where the agent
  // can read it and the token never is.
  process.stderr.write(`[agent-broker] ${outcome.reason}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv)
}
