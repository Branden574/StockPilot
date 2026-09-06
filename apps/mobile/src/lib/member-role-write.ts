import { hasPermission, type Permission, type Role } from '@stockpilot/core';

/**
 * The two rules the mobile admin role change was missing.
 *
 * The screen wrote `organization_members.role` directly with a bare
 * `const { error } = await supabase...update(...)` and painted the new role
 * into the list BEFORE awaiting it. Two independent defects:
 *
 *  1. FAIL-OPEN (recurring pattern #2). PostgREST answers a row-count-0 UPDATE
 *     with HTTP 204 and `error === null`. An update RLS refused, or one whose
 *     member row had been removed a moment earlier, therefore read as SUCCESS —
 *     the phone showed the promotion, the database still held the old role, and
 *     only a pull-to-refresh revealed it. The row-proof is to ask the write for
 *     the row back and treat "no row" as a failure.
 *
 *  2. NO PERMISSION PARITY. The web service asserts
 *     `assertPermission(ctx, 'members:update_role')`; the table's RLS
 *     (0140) only requires has_org_role(org,'admin'), with no has_permission
 *     term. So an admin whose members:update_role was revoked by a 0207
 *     override is refused on web and succeeded from the phone.
 *     canChangeMemberRoles restores that gate at the app layer — which is
 *     PARITY, not enforcement: the server still allows it. Closing it properly
 *     needs the write to go through TeamService (which also writes the
 *     `user.role.changed` audit row and the `security.member_role_changed`
 *     feed event that the phone still does not produce) via an
 *     /api/v1 team route, or a migration adding has_permission to the
 *     organization_members UPDATE policy. See the note in
 *     app/(drawer)/admin/users.tsx changeRole().
 */

export type MemberRoleWriteResult = { ok: true } | { ok: false; message: string };

export interface MemberRoleWriteResponse {
  data: { user_id?: string | null } | null;
  error: { message: string } | null;
}

/**
 * Row-proof for the role UPDATE: only a RETURNED ROW proves it landed.
 * `error` is checked first so a real database message always wins over the
 * generic "no row" sentence.
 */
export function interpretMemberRoleWrite(res: MemberRoleWriteResponse): MemberRoleWriteResult {
  if (res.error) return { ok: false, message: res.error.message };
  if (!res.data) {
    return {
      ok: false,
      message:
        'The change was not applied — this member may have been removed, or your account may no longer be allowed to change roles. Pull to refresh and try again.',
    };
  }
  return { ok: true };
}

/**
 * App-layer mirror of the web service's `members:update_role` assertion.
 *
 * `permissions` is the EFFECTIVE set from useEffectivePermissions(), which is
 * `undefined` until the persisted set loads (and maps an empty persisted set
 * back to undefined, since no real member holds zero permissions). Falling back
 * to the STATIC role permissions in that window is what keeps every admin from
 * losing the affordance on a cold launch; an empty set here means "unknown",
 * never "revoked".
 */
export function canChangeMemberRoles(
  role: Role | null,
  permissions: ReadonlySet<Permission> | undefined,
): boolean {
  if (!role) return false;
  if (permissions && permissions.size > 0) return permissions.has('members:update_role');
  return hasPermission(role, 'members:update_role');
}
