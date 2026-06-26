'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { audit } from '@/server/services/audit';
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
 * Anti-escalation guard: you can only GRANT a permission you hold yourself.
 * This stops an admin from granting (to a role, a user, or their own account) a
 * permission they lack — most importantly billing:manage, which is owner-only.
 * Revokes (false) and clears (null) are always allowed; they can't escalate.
 */
function assertCanGrant(
  ctx: Awaited<ReturnType<typeof requireConfigurer>>,
  permission: Permission,
  granted: boolean | null,
): void {
  if (granted === true && !can(ctx, permission)) {
    throw new ServiceError(
      'forbidden',
      'You can only grant permissions you have yourself.',
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
    revalidatePath('/dashboard/settings/roles');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to update permission');
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
    revalidatePath('/dashboard/settings/roles');
    return ok(null);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Failed to update permission');
  }
}
