/**
 * Per-kind capability discovery (agora ADR 0008 selectors). The supervisor is the ONLY
 * component co-located with the runtime binary + its creds + its agent dir, so capability
 * probing lives here — but it stays PER-KIND (like the spawn recipe): each harness knows
 * how to introspect itself. Adding a runtime kind = adding its probe here.
 *
 * For `claude` nothing is hardcoded that the harness can tell us itself:
 *   - models  → GET /v1/models (the subscription OAuth token lists the account's catalogue;
 *               a new model release appears on its own — no curated list to maintain)
 *   - efforts → read PER MODEL from each model's `capabilities.effort` (the API reports
 *               exactly which levels that model supports)
 *   - agents  → scan the `.claude/agents/*.md` definitions (project + user), `name:` frontmatter
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ModelInfo {
  id: string
  name: string
  created?: string
  /** Effort levels this specific model supports (subset of low/medium/high/xhigh/max). */
  efforts: string[]
}

export interface KindCapabilities {
  models: ModelInfo[]
  agents: string[]
  defaults: { model: string; effort?: string }
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

async function claudeModels(): Promise<ModelInfo[]> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (!token) {
    console.log('[caps] no CLAUDE_CODE_OAUTH_TOKEN → empty model catalogue')
    return []
  }
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
  })
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`)
  const data = (await res.json()) as { data?: any[] }
  return (data.data ?? []).map((m) => {
    const eff = m.capabilities?.effort
    return {
      id: m.id,
      name: m.display_name ?? m.id,
      created: m.created_at,
      efforts: eff?.supported ? EFFORT_LEVELS.filter((lvl) => eff[lvl]?.supported) : [],
    }
  })
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
  let models: ModelInfo[] = []
  try {
    models = await claudeModels()
  } catch (err) {
    console.log(`[caps] model discovery failed: ${(err as Error).message}`)
  }
  return { models, agents: claudeAgents(), defaults: { model: 'default' } }
}

const PROBES: Record<string, () => Promise<KindCapabilities>> = {
  claude: claudeCapabilities,
}

const CACHE_TTL_MS = Number(process.env.CAPS_TTL_MS ?? 600_000)
const cache = new Map<string, { at: number; data: KindCapabilities }>()

/** Cached per-kind capability descriptor. Models change rarely, and the probe hits the
 *  network, so we cache for CAPS_TTL_MS (10 min default) and refresh lazily. */
export async function getCapabilities(kind: string): Promise<KindCapabilities> {
  const probe = PROBES[kind]
  if (!probe) throw new Error(`no capability probe for kind: ${kind}`)
  const hit = cache.get(kind)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data
  const data = await probe()
  cache.set(kind, { at: Date.now(), data })
  return data
}
