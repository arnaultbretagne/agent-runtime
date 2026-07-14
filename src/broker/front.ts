/**
 * Broker front entrypoint (dist/broker/front.js) — the policy plane. Opens the lease store
 * (fail-fast on a missing PVC), serves the admin plane (:8789, manager-only) and the data plane
 * (:8788, loge-facing), and sweeps expired leases on a timer. Holds no provider secret.
 */
import { frontConfigFromEnv, type FrontConfig } from './config.js'
import { LeaseStore } from './lease-store.js'
import { makeAuditor } from './audit.js'
import { createAdminServer } from './admin-server.js'
import { createDataServer } from './data-server.js'

export function startFront(cfg: FrontConfig = frontConfigFromEnv(process.env)) {
  const audit = makeAuditor()
  const store = new LeaseStore({ path: cfg.leaseStorePath, ttlMs: cfg.leaseTtlMs })
  store.load() // throws (refuses to run) if the PVC is missing or the file is corrupt

  const admin = createAdminServer(store, audit)
  const data = createDataServer(store, cfg, audit)
  admin.listen(cfg.adminPort, '0.0.0.0', () => console.log(`[broker] admin plane on :${cfg.adminPort} (manager-only)`))
  data.listen(cfg.dataPort, '0.0.0.0', () => console.log(`[broker] data plane on :${cfg.dataPort} (loge-facing)`))

  const gc = setInterval(() => {
    const n = store.gc()
    if (n) audit('lease.expired', { result: String(n) })
  }, cfg.gcIntervalMs)
  gc.unref()

  return { admin, data, store }
}

if (import.meta.url === `file://${process.argv[1]}`) startFront()
