'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
import { AUDITOR_PRESET_PERMISSIONS } from '@/lib/auditor-preset';
import { broadcastPermissionsChanged } from '@/lib/realtime/broadcast';
import { ServiceError, withContext } from '@/server/services/context';

import {
  PERMISSIONS,
  can,
  err,
  isAdminRole,
  ok,
  type ActionResult,
  type Permission,
} from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Configurable permissions — admin/owner write the override tables (mig 0207).
// granted: true = grant a permission the role/user lacks; false = revoke one it
// has; null = clear the override (revert to the static role default).
// Owner role is NOT editable (immutable, the org's lockout escape hatch).
// ---------------------------------------------------------------------------

const permissionEnum = z.enum([...PERMISSIONS] as [Permission, ...Permission[]]);

const roleSchema = z.object({
  role: z.enum(['admin', 'manager', 'staff', 'viewer']),
  permission: permissionEnum,
  granted: z.boolean().nullable(),
});

const userSchema = z.object({
  userId: z.string().uuid(),
  permission: permissionEnum,
  granted: z.boolean().nullable(),
});

/**
 * Resolves the context and asserts the actor is an owner/admin — matching the
 * RLS write policy on the override tables (has_org_role admin) exactly, so the
 * app gate and the DB gate agree. Honors the org MFA policy (fail closed).
 */
async function requireConfigurer() {
  const ctx = await withContext();
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw new ServiceError(
      'forbidden',
      'Multi-factor authentication required. Enroll in MFA before performing this action.',
    );
  }
  if (!isAdminRole(ctx.role)) {
    throw new ServiceError('forbidden', 'Only owners and admins can configure permissions.');
  }
  return ctx;
}

/**
 * Anti-escalation guard: you can only GRANT — or CLEAR — a permission you hold
 * yourself. This stops an admin from handing (to a role, a user, or their own
 * account) a permission they lack — most importantly billing:manage, which is
 * owner-only.
 *
 * MED-14: `null` (clear) is gated by the SAME rule as `true`, not exempt from
 * it. Clearing is a DELETE of the override row, and deleting a `granted=false`
 * row removes a RESTRICTION — the subject reverts to their role default, which
 * is an escalation. Treating clears as harmless let an admin delete an
 * owner-applied restriction off their own account. Only `false` (writing a
 * restriction) is unconditionally safe, because it can only ever take
 * permissions away.
 *
 * The owner-lockout escape hatch is preserved, but note WHERE it lives: NOT in
 * `can()`, which simply reads ctx.permissions when present. It is
 * effectivePermissions() / loadEffectivePermissions() that short-circuit role
 * 'owner' to the FULL permission set (with no DB round-trip), so an owner's
 * effective set always contains every permission and this guard always passes
 * for them. Anything that ever lets an owner context carry a narrowed
 * permission set would silently close the escape hatch here.
 *
 * The database enforces the same invariant independently — see the
 * *_overrides_delete policies in migration 0322, which allow deleting a
 * `granted=true` row freely but require has_permission() to delete a
 * `granted=false` one.
 */
function assertCanGrant(
  ctx: Awaited<ReturnType<typeof requireConfigurer>>,
  permission: Permission,
  granted: boolean | null,
): void {
  if (granted !== false && !can(ctx, permission)) {
    throw new ServiceError(
      'forbidden',
      'You can only grant or clear permissions you have yourself.',
    );
  }
}

export async function setRolePermissionOverrideAction(input: {
  role: 'admin' | 'manager' | 'staff' | 'viewer';
  permission: Permission;
  granted: boolean | null;
}): Promise<ActionResult<null>> {
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  const { role, permission, granted } = parsed.data;

  try {
    const ctx = await requireConfigurer();
    assertCanGrant(ctx, permission, granted);
    const supabase = ctx.supabase;

    if (granted === null) {
      const { error } = await supabase
        .from('role_permission_overrides')
        .delete()
        .eq('organization_id', ctx.organizationId)
        .eq('role', role)
        .eq('permission', permission);
      if (error) throw new ServiceError('internal_error', error.message);
    } else {
      const { error } = await supabase.from('role_permission_overrides').upsert(
        {
          organization_id: ctx.organizationId,
          role,
          permission,
          granted,
          updated_by: ctx.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,role,permission' },
      );
      if (error) throw new ServiceError('internal_error', error.message);
    }

    await audit(
      {
        event: 'permissions.role_override',
        entityType: 'role_permission_override',
        entityId: role,
        extra: { role, permission, granted },
      },
      ctx,
    );
    await broadcastPermissionsChanged(ctx.organizationId, { role, permission, granted });
    revalidatePath('/dashboard/settings/roles');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to update permission');
  }
}

/**
 * Bulk-grants the Auditor preset to the viewer role: role-level GRANT
 * overrides for every read/reporting surface in AUDITOR_PRESET_PERMISSIONS.
 * Same gates as the single-toggle siblings (admin/owner + org MFA policy +
 * the anti-escalation guard per permission), and the same persistence shape —
 * an upsert on (organization_id, role, permission) with granted=true, so
 * applying it twice is a no-op and individual toggles can still flip any of
 * the granted permissions afterward.
 */
export async function applyAuditorPresetAction(): Promise<ActionResult<null>> {
  try {
    const ctx = await requireConfigurer();
    // Anti-escalation: every grant in the preset must be one the actor holds
    // themselves (matches assertCanGrant on the single-toggle path). Checked
    // for the WHOLE set before any write so a partial apply can't happen.
    for (const permission of AUDITOR_PRESET_PERMISSIONS) {
      assertCanGrant(ctx, permission, true);
    }

    const updatedAt = new Date().toISOString();
    const { error } = await ctx.supabase.from('role_permission_overrides').upsert(
      AUDITOR_PRESET_PERMISSIONS.map((permission) => ({
        organization_id: ctx.organizationId,
        role: 'viewer',
        permission,
        granted: true,
        updated_by: ctx.userId,
        updated_at: updatedAt,
      })),
      { onConflict: 'organization_id,role,permission' },
    );
    if (error) throw new ServiceError('internal_error', error.message);

    await audit(
      {
        event: 'permissions.auditor_preset',
        entityType: 'role_permission_override',
        entityId: 'viewer',
        extra: { role: 'viewer', granted: true, permissions: [...AUDITOR_PRESET_PERMISSIONS] },
      },
      ctx,
    );
    // One generic ping (no single permission key) — affected viewers get the
    // generic "your permissions changed" toast + a nav refresh.
    await broadcastPermissionsChanged(ctx.organizationId, { role: 'viewer', granted: true });
    revalidatePath('/dashboard/settings/roles');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to apply preset');
  }
}

export async function setUserPermissionOverrideAction(input: {
  userId: string;
  permission: Permission;
  granted: boolean | null;
}): Promise<ActionResult<null>> {
  const parsed = userSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  const { userId, permission, granted } = parsed.data;

  try {
    const ctx = await requireConfigurer();
    assertCanGrant(ctx, permission, granted);
    const supabase = ctx.supabase;

    // The target must be an active member of THIS org, and not the owner
    // (owner permissions are immutable). This is org-verified (the select is
    // RLS-scoped) so an admin can't author overrides for a foreign user.
    const { data: member, error: memberErr } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', ctx.organizationId)
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (memberErr) throw new ServiceError('internal_error', memberErr.message);
    if (!member) return err('not_found', 'That member is not in this organization.');
    if ((member as { role: string }).role === 'owner')
      return err('forbidden', 'Owner permissions cannot be overridden.');

    if (granted === null) {
      const { error } = await supabase
        .from('user_permission_overrides')
        .delete()
        .eq('organization_id', ctx.organizationId)
        .eq('user_id', userId)
        .eq('permission', permission);
      if (error) throw new ServiceError('internal_error', error.message);
    } else {
      const { error } = await supabase.from('user_permission_overrides').upsert(
        {
          organization_id: ctx.organizationId,
          user_id: userId,
          permission,
          granted,
          updated_by: ctx.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,user_id,permission' },
      );
      if (error) throw new ServiceError('internal_error', error.message);
    }

    await audit(
      {
        event: 'permissions.user_override',
        entityType: 'user_permission_override',
        entityId: userId,
        extra: { userId, permission, granted },
      },
      ctx,
    );
    await broadcastPermissionsChanged(ctx.organizationId, { userId, permission, granted });
    revalidatePath('/dashboard/settings/roles');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to update permission');
  }
}
