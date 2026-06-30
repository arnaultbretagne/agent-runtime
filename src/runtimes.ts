/**
 * Baked runtime registry (ADR 0002).
 *
 * The supervisor resolves a CLOSED `kind` to a base command + args, then appends
 * the caller's forwarded argv. It NEVER runs an arbitrary command string — `kind`
 * is a whitelist and the binary is fixed, so there is no arbitrary-exec vector
 * from the product into the infra pod (ADR 0003).
 *
 * Adding a runtime (e.g. codex) = bake its binary into the image (ADR 0004) +
 * add an entry here. That is the ONLY supervisor-side change.
 */
export interface RuntimeSpec {
  /** Executable to spawn (must be on PATH inside the image). */
  command: string
  /** Base args always prepended, before the caller's forwarded args. */
  baseArgs: string[]
}

export const RUNTIMES: Record<string, RuntimeSpec> = {
  // The channel ref (`--channels …`), `--allowedTools …`, model, etc. are
  // forwarded by the caller as `args` — the supervisor does not interpret them.
  claude: { command: 'claude', baseArgs: [] },
}

export const KNOWN_KINDS = Object.keys(RUNTIMES)

export function isKnownKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUNTIMES, kind)
}
