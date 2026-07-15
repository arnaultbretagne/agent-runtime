import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { writeFileSync, mkdtempSync, chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handle, parseRequest, type HelperEnv } from './git-credential.js'

/** First file under `dir` whose bytes contain `needle`, or null. Used to assert a token is nowhere
 *  on disk — and, in the CONTROL test, that this sweep genuinely finds one when it IS. */
function grepTree(dir: string, needle: string): string | null {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      const hit = grepTree(p, needle)
      if (hit) return hit
    } else if (readFileSync(p).includes(needle)) return p
  }
  return null
}

const TOKEN = 'ghs_a_freshly_minted_installation_token'
const LEASE = 'sk-ant-oat01-broker-abcdef0123456789'
const ENV: HelperEnv = { AGENT_BROKER_URL: 'http://broker:8788', AGENT_BROKER_TOKEN: LEASE }
const GET = { protocol: 'https', host: 'github.com' }

/** A broker stand-in. Records what was asked so a test can assert it was NOT asked at all. */
function fakeBroker(reply: () => { status: number; body: unknown } = () => ({ status: 200, body: { token: TOKEN } })) {
  const asks: Array<{ path: string; method: string; auth: string }> = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>
    asks.push({ path: new URL(url).pathname, method: init.method ?? 'GET', auth: h.authorization ?? '' })
    const { status, body } = reply()
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, asks }
}

// ---------------------------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------------------------

test('a github.com get is answered with the App token as the password', async () => {
  const broker = fakeBroker()
  const out = await handle('get', GET, ENV, broker.fetchImpl)
  assert.deepEqual(out, { kind: 'credential', username: 'x-access-token', password: TOKEN })
  assert.deepEqual(broker.asks, [{ path: '/v1/github/token', method: 'POST', auth: `Bearer ${LEASE}` }])
})

test('REFUSES to hand a GitHub token to any other host — and does not even ask the broker', async () => {
  // The control this file exists for. A repository chooses its own submodule URLs, so cloning a
  // hostile repo makes git ask us for credentials for the attacker's host. git would happily send
  // whatever we answer. Not asking the broker at all is the belt: no token is minted to be leaked.
  for (const host of ['evil.com', 'github.com.evil.com', 'gist.github.com', 'raw.githubusercontent.com']) {
    const broker = fakeBroker()
    const out = await handle('get', { protocol: 'https', host }, ENV, broker.fetchImpl)
    assert.equal(out.kind, 'silent', `${host} must not receive a GitHub token`)
    assert.deepEqual(broker.asks, [], `${host} must not even cause a mint`)
  }
})

test('refuses plain http to github.com — a token must not cross a cleartext hop', async () => {
  const broker = fakeBroker()
  const out = await handle('get', { protocol: 'http', host: 'github.com' }, ENV, broker.fetchImpl)
  assert.equal(out.kind, 'silent')
  assert.deepEqual(broker.asks, [])
})

test('store and erase are no-ops — there is nothing stored to forget', async () => {
  for (const op of ['store', 'erase']) {
    const broker = fakeBroker()
    const out = await handle(op, { ...GET, username: 'x-access-token', password: TOKEN }, ENV, broker.fetchImpl)
    assert.equal(out.kind, 'silent', `${op} must never return a credential`)
    assert.deepEqual(broker.asks, [], `${op} must not mint anything`)
  }
})

test('a loge with no lease says so instead of failing obscurely', async () => {
  const out = await handle('get', GET, {}, fakeBroker().fetchImpl)
  assert.equal(out.kind, 'silent')
  assert.match((out as { reason: string }).reason, /no broker lease/)
})

test('a 403 (the profile earns no repo access) is reported in the agent’s own terms', async () => {
  const broker = fakeBroker(() => ({ status: 403, body: { error: 'capability_denied' } }))
  const out = await handle('get', GET, ENV, broker.fetchImpl)
  assert.equal(out.kind, 'silent')
  assert.match((out as { reason: string }).reason, /equipment grants no repository access/)
})

test('never echoes the broker’s body into a loge-visible reason', async () => {
  const leak = { error: 'boom', token: 'ghs_LEAKED_THROUGH_AN_ERROR_PATH' }
  const broker = fakeBroker(() => ({ status: 500, body: leak }))
  const out = await handle('get', GET, ENV, broker.fetchImpl)
  assert.equal(out.kind, 'silent')
  assert.equal((out as { reason: string }).reason.includes('LEAKED'), false)
})

test('a broker that is down, or answers garbage, yields silence — never a bogus credential', async () => {
  const dead = (async () => {
    throw new Error('connect ECONNREFUSED')
  }) as unknown as typeof fetch
  assert.equal((await handle('get', GET, ENV, dead)).kind, 'silent')

  for (const body of [{}, { token: '' }, { token: 42 }, 'not json at all']) {
    const broker = fakeBroker(() => ({ status: 200, body }))
    assert.equal((await handle('get', GET, ENV, broker.fetchImpl)).kind, 'silent', `${JSON.stringify(body)} is not a token`)
  }
})

// ---------------------------------------------------------------------------------------------
// the wire format
// ---------------------------------------------------------------------------------------------

test('parses git’s request, and ignores keys it does not know rather than choking', () => {
  // git >=2.46 sends wwwauth[]/capability[]. A helper that rejected unknown keys would break on the
  // next git that adds one.
  const req = parseRequest(
    'protocol=https\nhost=github.com\npath=arnaultbretagne/agora.git\nwwwauth[]=Basic realm="GitHub"\ncapability[]=authtype\n\n',
  )
  assert.equal(req.protocol, 'https')
  assert.equal(req.host, 'github.com')
  assert.equal(req.path, 'arnaultbretagne/agora.git')
})

test('stops at the blank line — trailing bytes are not part of the request', () => {
  const req = parseRequest('protocol=https\nhost=github.com\n\nhost=evil.com\n')
  assert.equal(req.host, 'github.com', 'anything after the terminator must not override the host')
})

test('a value containing = survives (git does not escape it)', () => {
  assert.equal(parseRequest('password=a=b=c\n\n').password, 'a=b=c')
})

// ---------------------------------------------------------------------------------------------
// against REAL git — the protocol is git's, not my reading of its docs
// ---------------------------------------------------------------------------------------------

const HELPER = fileURLToPath(new URL('./git-credential.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))

/** A real broker on a real socket: git -> helper process -> HTTP -> here. Nothing is stubbed. */
function serveBroker(): Promise<{ url: string; close: () => Promise<void>; asks: string[] }> {
  const asks: string[] = []
  return new Promise((resolve) => {
    const srv: Server = createServer((req, res) => {
      asks.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token: TOKEN, expiresAt: '2026-07-15T13:00:00Z', permissions: { contents: 'read' } }))
    })
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        asks,
        close: () => new Promise<void>((done) => srv.close(() => done())),
      })
    })
  })
}

function gitCredential(
  op: string,
  request: string,
  env: Record<string, string>,
  /** How the helper is wired in. `scoped` is what the image ships (git only consults it for
   *  github.com); `unscoped` forces git to consult it for EVERY host, which is the only way to
   *  exercise the helper's own host check through real git. */
  wiring: 'scoped' | 'unscoped' | 'git-builtin-store' = 'scoped',
): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'loge-cred-'))
  const shim = join(dir, 'git-credential-agent-broker')
  writeFileSync(shim, `#!/bin/sh\nexec ${TSX} ${HELPER} "$@"\n`)
  chmodSync(shim, 0o755)
  const config =
    wiring === 'git-builtin-store'
      ? 'credential.helper=store' // git's own on-disk helper — the control, not our helper
      : `${wiring === 'scoped' ? 'credential.https://github.com.helper' : 'credential.helper'}=${shim}`

  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', config, 'credential', op],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir, // an empty HOME: no ~/.gitconfig of this machine leaks into the test
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0', // no tty in a loge either — never let git fall back to asking
          ...env,
        },
        timeout: 30_000,
      },
      (err, stdout, stderr) => {
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr, home: dir })
      },
    )
    child.stdin?.end(request)
  })
}

test('REAL git fills a github.com credential from this helper over the real protocol', async () => {
  const broker = await serveBroker()
  try {
    const r = await gitCredential('fill', 'protocol=https\nhost=github.com\n\n', {
      AGENT_BROKER_URL: broker.url,
      AGENT_BROKER_TOKEN: LEASE,
    })
    // git's own plumbing invoked the helper, parsed its answer, and handed back a filled credential.
    assert.match(r.stdout, /^username=x-access-token$/m, `git did not take the username:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, new RegExp(`^password=${TOKEN}$`, 'm'), `git did not take the token:\n${r.stdout}\n${r.stderr}`)
    assert.equal(r.code, 0)
    assert.equal(broker.asks.length, 1, 'exactly one mint for one credential')
    assert.match(broker.asks[0], new RegExp(`^POST /v1/github/token auth=Bearer ${LEASE}$`))
  } finally {
    await broker.close()
  }
})

test('REAL git, helper wired for EVERY host: it is consulted for evil.com — and refuses', async () => {
  const broker = await serveBroker()
  try {
    // The load-bearing one. The image ships the SCOPED wiring (next test), so git would not normally
    // consult us for evil.com at all — which means that test alone proves git's config, not this
    // helper. Wiring the helper unscoped here forces real git to actually ask us for the attacker's
    // host, exactly as it would if the scoping were ever widened or a repo set its own
    // `credential.helper`. The refusal must come from the helper itself.
    const r = await gitCredential(
      'fill',
      'protocol=https\nhost=evil.com\n\n',
      { AGENT_BROKER_URL: broker.url, AGENT_BROKER_TOKEN: LEASE },
      'unscoped',
    )
    assert.equal(r.stdout.includes(TOKEN), false, `the token reached evil.com:\n${r.stdout}`)
    assert.equal(broker.asks.length, 0, 'no token may even be minted for a non-GitHub host')
    assert.match(r.stderr, /refusing to offer a GitHub token to https:\/\/evil\.com/, 'the refusal must be the helper’s')
  } finally {
    await broker.close()
  }
})

test('REAL git, as the image wires it: scoping means the helper is never even asked for evil.com', async () => {
  const broker = await serveBroker()
  try {
    // The second, independent layer: `credential.https://github.com.helper` is what the loge image
    // sets, so git filters by host before the helper ever runs. Belt AND braces — this passing while
    // the test above fails would mean the braces are gone.
    const r = await gitCredential('fill', 'protocol=https\nhost=evil.com\n\n', {
      AGENT_BROKER_URL: broker.url,
      AGENT_BROKER_TOKEN: LEASE,
    })
    assert.equal(r.stdout.includes(TOKEN), false)
    assert.equal(r.stderr.includes('[agent-broker]'), false, 'the helper should not even have run')
    assert.equal(broker.asks.length, 0)
  } finally {
    await broker.close()
  }
})

const APPROVE = `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n\n`

test('REAL git `approve`: the token is NOT written to ~/.git-credentials', async () => {
  // The plan's "ne stocke pas le token dans ~/.git-credentials", asserted directly. git offers us
  // the filled credential to cache after every successful auth; we take it and keep nothing.
  // A non-zero exit would also abort the real `git push` that triggered it, so it is part of the
  // contract too.
  const broker = await serveBroker()
  try {
    const r = await gitCredential('approve', APPROVE, { AGENT_BROKER_URL: broker.url, AGENT_BROKER_TOKEN: LEASE })
    assert.equal(r.code, 0, `store must not fail the git operation that called it:\n${r.stderr}`)
    assert.equal(broker.asks.length, 0, 'store must not mint anything')
    assert.equal(existsSync(join(r.home, '.git-credentials')), false, 'a credential file must not exist at all')
    // Nothing anywhere under HOME may contain it — .git-credentials is the documented path, not the
    // only writable one.
    assert.equal(grepTree(r.home, TOKEN), null, 'the token was written somewhere under HOME')
  } finally {
    await broker.close()
  }
})

test('CONTROL: the same assertion CATCHES git’s own `store` helper writing the token to disk', async () => {
  // Proves the test above can fail. Swap our helper for git's built-in on-disk one and re-run the
  // identical assertion: it must find the token. Without this, "no file appeared" would be just as
  // true if `git credential approve` silently did nothing at all.
  const r = await gitCredential('approve', APPROVE, {}, 'git-builtin-store')
  assert.equal(r.code, 0)
  assert.equal(existsSync(join(r.home, '.git-credentials')), true, 'git’s store helper must write the file we look for')
  assert.equal(grepTree(r.home, TOKEN), join(r.home, '.git-credentials'), 'the sweep must actually find a token on disk')
})

test('REAL git: a broker that refuses does not wedge git into prompting or hanging', async () => {
  // No broker at all: the port is closed. The helper must stay silent and exit 0, so git fails on
  // its own terms (no credential) instead of dying with "credential helper failed", and never hangs.
  const r = await gitCredential('fill', 'protocol=https\nhost=github.com\n\n', {
    AGENT_BROKER_URL: 'http://127.0.0.1:1',
    AGENT_BROKER_TOKEN: LEASE,
  })
  assert.equal(r.stdout.includes(TOKEN), false)
  assert.match(r.stderr, /\[agent-broker\]/, 'the agent must be told WHY it has no credential')
})
