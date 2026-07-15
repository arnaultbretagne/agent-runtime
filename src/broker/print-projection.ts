/**
 * Emits the agora equipment projection (agora ADR 0012 §5) on stdout.
 *
 * agora must not carry a second, hand-kept catalogue: the security authority is `profiles.ts` here.
 * agora vendors the OUTPUT of this script (`shared/equipment-catalogue.json`) at build time — labels
 * and form shape only, never capabilities. Regenerate it whenever the catalogue changes (notably when
 * P5/P6 flip a profile's `visible`):
 *
 *   npm run print-projection > ../agora/shared/equipment-catalogue.json
 *
 * A stale copy is fail-closed by construction: agora can only ever offer a name the manager then
 * re-checks against the real catalogue and refuses.
 */
import { publicProjection } from './profiles.js'

export function projectionDocument(): string {
  return `${JSON.stringify(
    {
      _generated: 'agent-runtime `npm run print-projection` — do not edit by hand',
      _source: 'agent-runtime src/broker/profiles.ts (the security authority)',
      profiles: publicProjection(),
    },
    null,
    2,
  )}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(projectionDocument())
}
