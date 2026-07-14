/**
 * Claude adapter (dist/broker/adapter-claude.js) — holds the real Claude token ONLY.
 * P3 migrates the inference-proxy logic here: swap the placeholder Bearer for the real token,
 * fill the empty account_uuid, forward to Anthropic, stream SSE. P2 = stub (chain wired, no
 * provider call yet).
 */
import { startAdapter, notImplemented } from './adapter-common.js'

if (import.meta.url === `file://${process.argv[1]}`) {
  startAdapter('claude', notImplemented('claude', 'P3'))
}
