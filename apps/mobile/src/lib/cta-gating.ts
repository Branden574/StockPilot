import type { Permission } from '@stockpilot/core';

/**
 * COSMETIC write-CTA gate for mobile screens, driven by the effective
 * permission set from useEffectivePermissions().
 *
 * `undefined` (perms not loaded yet — fresh install, offline before first
 * sync) falls back to SHOWING the CTA, i.e. today's behavior: like the
 * drawer's nav gating, this is cosmetic only — the API independently
 * enforces permissions server-side (assertPermission + RLS), so a briefly
 * over-shown button 403s on use rather than leaking a capability. Once the
 * set loads, the CTA follows the real grant.
 */
export function showWriteCta(
  perms: ReadonlySet<Permission> | undefined,
  permission: Permission,
): boolean {
  return perms === undefined ? true : perms.has(permission);
}
