import { can, type Permission, type Role } from '@stockpilot/core';

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

/**
 * The same gate for a screen that ALSO knows the member's role — ONE rule for
 * every control on that screen that the server checks with the same
 * permission. The item screen had two for 'stock:adjust': its quick adjust
 * used showWriteCta, while "Remove from rack" used "manager or above, else the
 * role's defaults with overrides". They disagreed both ways: a manager whose
 * stock:adjust an admin revoked (a 0207 override; only the owner is immune)
 * still saw "Remove from rack", and a viewer saw the quick-adjust buttons for
 * as long as the permission set took to load.
 *
 *   • Effective set loaded → it decides. It is the set the server's
 *     assertPermission checks, overrides included, whatever the role.
 *   • Not loaded, role known → the role's static defaults (core's can()
 *     without a set), so a viewer is never offered a write meanwhile.
 *   • Neither known → show, as showWriteCta does: the API is the real gate.
 *
 * Cosmetic like showWriteCta; the route refuses on its own.
 */
export function showWriteCtaForRole(
  role: Role | null,
  perms: ReadonlySet<Permission> | undefined,
  permission: Permission,
): boolean {
  if (perms !== undefined) return perms.has(permission);
  if (role !== null) return can({ role }, permission);
  return true;
}
