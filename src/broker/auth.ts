/**
 * Data-plane authorization (plan §2.5). A loge presents `Authorization: Bearer <lease>`; every
 * data call revalidates the lease (401), the capability the route needs (403), and — for repo
 * routes — that the operated target matches the lease's frozen target (409). The lease itself is
 * never forwarded to a provider; only the validated claims are.
 */
import type { LeaseStore, LeaseClaims } from './lease-store.js'
import { getProfile } from './profiles.js'

export function bearerOf(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const t = authHeader.slice(7).trim()
  return t === '' ? null : t
}

export type AuthResult =
  | { ok: true; claims: LeaseClaims }
  | { ok: false; status: 401 | 403; error: string }

export function authenticate(store: LeaseStore, authHeader: string | undefined): AuthResult {
  const token = bearerOf(authHeader)
  if (!token) return { ok: false, status: 401, error: 'lease_missing' }
  const v = store.validate(token)
  if (!v.ok) return { ok: false, status: 401, error: v.error } // lease_invalid | lease_expired
  return { ok: true, claims: v.claims }
}

export function hasCapability(claims: LeaseClaims, capability: string): boolean {
  const p = getProfile(claims.profile)
  return p !== undefined && p.capabilities.includes(capability)
}

/** Authenticate the lease and require a capability. 401 = bad/expired lease; 403 = valid lease
 *  whose profile lacks the capability. */
export function authorize(store: LeaseStore, authHeader: string | undefined, capability: string): AuthResult {
  const a = authenticate(store, authHeader)
  if (!a.ok) return a
  if (!hasCapability(a.claims, capability)) return { ok: false, status: 403, error: 'capability_denied' }
  return a
}

