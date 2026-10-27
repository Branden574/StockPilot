'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import { PermissionExceptionsService } from '@/server/services/platform/permission-exceptions';

import {
  err,
  ok,
  ORDER_ITEMS_ACCESS_BUSY_COPY,
  ORDER_ITEMS_ACCESS_CHANGED_COPY,
  ORDER_ITEMS_ACCESS_INVALID_COPY,
  ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY,
  ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY,
  PERMISSION_EXCEPTION_STATES,
  type ActionResult,
  type PermissionExceptionState,
  type Role,
} from '@stockpilot/core';

const schema = z.object({
  organizationId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  state: z.enum(PERMISSION_EXCEPTION_STATES),
  /** What the dialog showed: the compare-and-set. */
  expectedState: z.enum(PERMISSION_EXCEPTION_STATES),
});

export interface OrderItemsAccessSaved {
  before: PermissionExceptionState;
  after: PermissionExceptionState;
  targetRole: Role;
  /** False when it already was the chosen state (nothing written, nobody pinged). */
  changed: boolean;
}

/**
 * Platform-admin action: set one member's Order items access
 * (orders:manage_catalog_visibility, migration 0413) to Follow role default,
 * Allow or Deny, from the console's Users tab.
 *
 * All three states sit on the FRESH step-up tier: Allow and Reset can GIVE
 * access (Reset returns a manager to their default), the re-enable precedent,
 * and Deny changes access across an organization the admin does not belong
 * to. A stale step-up comes back as details.reason 'aal2_required', which is
 * what lets useStepUp() prompt for the authenticator in place and retry once.
 *
 * Only the session's user id goes down: the service re-verifies that actor's
 * email from GoTrue and re-checks the allowlist itself. A lost compare-and-set
 * is a conflict with the stale-state sentence and the current state (never
 * "not authorized", the STALE_STATUS_CODES rule of user-actions-menu.tsx).
 */
export async function setOrderItemsAccessAction(
  input: z.infer<typeof schema>,
): Promise<ActionResult<OrderItemsAccessSaved>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', ORDER_ITEMS_ACCESS_INVALID_COPY);

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return err('forbidden', 'Not authorized.', gate.reason === 'aal2_required' ? { reason: 'aal2_required' } : undefined);
  }

  const { organizationId } = parsed.data;
  const res = await PermissionExceptionsService.set({
    organizationId,
    targetUserId: parsed.data.targetUserId,
    state: parsed.data.state,
    expectedState: parsed.data.expectedState,
    actorUserId: gate.session.userId,
  });

  if (res.ok) {
    revalidatePath(`/platform/orgs/${organizationId}`);
    return ok({ before: res.before, after: res.after, targetRole: res.targetRole, changed: res.changed });
  }

  switch (res.code) {
    case 'changed':
      // The page's row is stale: refresh it so the reload the sentence asks
      // for shows what it is now.
      revalidatePath(`/platform/orgs/${organizationId}`);
      return err('conflict', ORDER_ITEMS_ACCESS_CHANGED_COPY, {
        reason: 'permission_exception_changed',
        current: res.current,
      });
    case 'member_not_found':
      return err('not_found', ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY, { reason: 'member_not_found' });
    case 'invalid':
      return err('validation_error', ORDER_ITEMS_ACCESS_INVALID_COPY, {
        reason: 'permission_exception_invalid',
        field: res.field,
      });
    case 'busy':
      return err('conflict', ORDER_ITEMS_ACCESS_BUSY_COPY, { reason: 'busy' });
    case 'not_authorized':
      return err('forbidden', 'Not authorized.');
    default:
      return err('internal_error', ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY);
  }
}
