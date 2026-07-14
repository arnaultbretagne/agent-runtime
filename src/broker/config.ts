/**
 * Front (policy plane) configuration. Secrets belong to the adapters, never here —
 * the front holds only the lease store and routing (agent-runtime ADR 0011 §1).
 */

export interface FrontConfig {
  adminPort: number // 8789 — manager-only (CiliumNetworkPolicy), mint/revoke
  dataPort: number // 8788 — loge-facing, lease-bearing
  leaseStorePath: string // PVC file
  leaseTtlMs: number
  gcIntervalMs: number
  adapters: { claude: string; vault: string; github: string }
}

export function frontConfigFromEnv(env: NodeJS.ProcessEnv): FrontConfig {
  return {
    adminPort: Number(env.ADMIN_PORT ?? 8789),
    dataPort: Number(env.DATA_PORT ?? 8788),
    leaseStorePath: env.LEASE_STORE_PATH ?? '/var/lib/broker/leases.json',
    leaseTtlMs: Number(env.LEASE_TTL_MS ?? 90 * 60_000), // 90 min (plan §2.7)
    gcIntervalMs: Number(env.GC_INTERVAL_MS ?? 60_000),
    adapters: {
      claude: env.CLAUDE_ADAPTER_URL ?? 'http://agent-broker-claude.agent.svc.cluster.local:8790',
      vault: env.VAULT_ADAPTER_URL ?? 'http://agent-broker-vault.agent.svc.cluster.local:8790',
      github: env.GITHUB_ADAPTER_URL ?? 'http://agent-broker-github.agent.svc.cluster.local:8790',
    },
  }
}
