/**
 * Per-kind capability discovery (agora ADR 0008 selectors). The supervisor is the ONLY
 * component co-located with the runtime binary + its creds + its agent dir, so capability
 * probing lives here — but it stays PER-KIND (like the spawn recipe): each harness knows
 * how to introspect itself. Adding a runtime kind = adding its probe here.
 *
 * For `claude` nothing is hardcoded that the harness can tell us itself:
 *   - models  → the aliases the harness's OWN `/model` picker exposes, read straight out of the
 *               co-located claude binary. NOT the API `/v1/models` catalogue: that is a different,
 *               longer set the CLI does not honor (passing an API id like `claude-opus-4-1` silently
 *               resolves to the `opus` alias' current target — so it must never drive the picker).
 *   - efforts → the `--effort` scale (low…max); every current tier supports the full set.
 *   - agents  → scan the `.claude/agents/*.md` definitions (project + user), `name:` frontmatter
 */
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export interface ModelInfo {
  id: string // the `--model` alias (sonnet/opus/haiku/fable/opusplan) — what the harness resolves
  name: string // the picker label (Sonnet, Opus, …)
  description?: string // the picker's one-line description
  /** Effort levels this model supports (subset of low/medium/high/xhigh/max). */
  efforts: string[]
}

export interface KindCapabilities {
  models: ModelInfo[]
  agents: string[]
  defaults: { model: string; effort?: string }
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// The model-TIER aliases the harness's `/model` picker offers. We read each row's label/description/
// presence from the binary, but filter to these known tiers so we skip the OTHER {value,label,
// description} pickers baked in the same binary (thinking on/off, subagent "inherit", PR-monitor
// "continue", …). `best`/others only appear if the binary actually ships a row for them.
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'best']

/** The harness's REAL model list = the aliases its own `/model` picker exposes, parsed straight out
 *  of the co-located claude binary (each row is a literal `{value:"…",label:"…",description:"…"}`).
 *  So the list is exactly THIS harness version's, updates when the binary does (e.g. `fable` appeared
 *  as a new row at its launch), and each alias resolves to the provider's current recommended version
 *  at spawn — a new *version* needs zero changes here. We grep the binary (≈245 MB) in a child rather
 *  than load it into the heap; misses (grep exit 1) and resolution failures yield an empty list. */
function claudeModels(): ModelInfo[] {
  let bin = ''
  try {
    bin = execFileSync('sh', ['-c', 'readlink -f "$(command -v claude)"']).toString().trim()
  } catch {
    /* claude not on PATH */
  }
  if (!bin) return []
  let out = ''
  try {
    out = execFileSync(
      'grep',
      ['-aoE', '\\{value:"[a-z]+",label:"[^"]+",description:"[^"]+"\\}', bin],
      { maxBuffer: 16 * 1024 * 1024 },
    ).toString()
  } catch {
    return [] // grep exits non-zero when nothing matches (or is absent)
  }
  const seen = new Map<string, ModelInfo>()
  const re = /\{value:"([a-z]+)",label:"([^"]+)",description:"([^"]+)"\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(out))) {
    const [, id, name, description] = m
    if (!MODEL_ALIASES.includes(id) || seen.has(id)) continue
    seen.set(id, { id, name, description, efforts: [...EFFORT_LEVELS] })
  }
  return [...seen.values()].sort((a, b) => MODEL_ALIASES.indexOf(a.id) - MODEL_ALIASES.indexOf(b.id))
}

/** Custom agent DEFINITIONS visible to the runtime (project + user). Built-in Claude Code
 *  dev subagents are intentionally not offered — agora's `--agent` is for product personas. */
function claudeAgents(): string[] {
  const dirs = [
    join(process.env.HOME ?? '', '.claude', 'agents'),
    join(process.cwd(), '.claude', 'agents'),
  ]
  const names = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue // dir absent
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      try {
        const m = readFileSync(join(dir, f), 'utf8').match(/^name:\s*(.+)$/m)
        if (m) names.add(m[1].trim())
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return [...names]
}

async function claudeCapabilities(): Promise<KindCapabilities> {
  const models = claudeModels()
  // Preselect a real tier (never a synthetic "Défaut"): claude's own no-`--model` default is the
  // recommended Sonnet, so mirror that with the `sonnet` alias when present, else the first tier.
  const defaultModel = models.find((m) => m.id === 'sonnet')?.id ?? models[0]?.id ?? ''
  const defaultEffort = models.find((m) => m.id === defaultModel)?.efforts.includes('high') ? 'high' : undefined
  return { models, agents: claudeAgents(), defaults: { model: defaultModel, effort: defaultEffort } }
}

const PROBES: Record<string, () => Promise<KindCapabilities>> = {
  claude: claudeCapabilities,
}

const CACHE_TTL_MS = Number(process.env.CAPS_TTL_MS ?? 600_000)
const cache = new Map<string, { at: number; data: KindCapabilities }>()

/** Cached per-kind capability descriptor. The probe greps a ~245 MB binary + scans dirs, and the
 *  answer only changes on a claude upgrade, so we cache for CAPS_TTL_MS (10 min) and refresh lazily. */
export async function getCapabilities(kind: string): Promise<KindCapabilities> {
  const probe = PROBES[kind]
  if (!probe) throw new Error(`no capability probe for kind: ${kind}`)
  const hit = cache.get(kind)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data
  const data = await probe()
  cache.set(kind, { at: Date.now(), data })
  return data
}
