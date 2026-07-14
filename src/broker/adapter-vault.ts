/**
 * Vault adapter (dist/broker/adapter-vault.js) — holds the Pocket-ID broker client secret ONLY.
 * P5 builds the in-memory TokenProvider (client_credentials, resource=vault, cache + single-flight
 * renewal) and injects the machine bearer server-side into the Vault MCP; the loge never sees it
 * (vault-mcp-machine-token-findings.md). P2 = stub.
 */
import { startAdapter, notImplemented } from './adapter-common.js'

if (import.meta.url === `file://${process.argv[1]}`) {
  startAdapter('vault', notImplemented('vault', 'P5'))
}
