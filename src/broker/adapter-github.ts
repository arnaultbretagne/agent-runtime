/**
 * GitHub adapter (dist/broker/adapter-github.js) — holds the GitHub App private key + installation
 * id ONLY. P6 signs a short App JWT, mints a repo-scoped installation access token for the lease's
 * target with the profile's exact permissions, and returns only that ephemeral token. `infra-k8s`
 * is hard-denied in the profile layer regardless. P2 = stub.
 */
import { startAdapter, notImplemented } from './adapter-common.js'

if (import.meta.url === `file://${process.argv[1]}`) {
  startAdapter('github', notImplemented('github', 'P6'))
}
