'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ServiceError } from '@/server/services/context';
import { actionErrorResult } from '@/server/lib/action-error-result';

import { err, ok, type ActionResult } from '@stockpilot/core';

const schema = z.object({ organizationId: z.string().uuid() });

/**
 * Switches the active organization for the current user. Validates that
 * the user actually has an accepted membership in the target org (so a
 * malicious orgId in a request body can't escalate them anywhere they
 * haven't been invited), then updates user_profiles.default_organization_id.
 *
 * The session loader reads default_organization_id on every render, so
 * a layout-level revalidate is enough to swap context across the app.
 */
export async function switchOrganizationAction(input: {
  organizationId: string;
}): Promise<ActionResult<void>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid organization id');
  try {
    // The member's current context, not only a session: the switcher lives in
    // the dashboard, and a session that still owes its authenticator code is
    // sent to enter it before the active organization changes.
    const session = await requireOrgContext();
    const supabase = await createClient();

    // Membership check before we touch the profile row. A read that fails is
    // not "no membership": it answers internal_error (try again), never the
    // forbidden sentence below, and switches nothing. The code only: the
    // message can quote request details.
    const { data: member, error: memberError } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', session.userId)
      .eq('organization_id', parsed.data.organizationId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (memberError) {
      throw new ServiceError(
        'internal_error',
        `membership read failed: ${memberError.code || 'unknown'}`,
      );
    }
    if (!member) {
      return err('forbidden', "You don't have an accepted membership in that organization.");
    }

    const { error } = await supabase
      .from('user_profiles')
      .update({ default_organization_id: parsed.data.organizationId })
      .eq('id', session.userId);
    if (error) throw new ServiceError('internal_error', error.message);

    revalidatePath('/dashboard', 'layout');
    return ok(undefined);
  } catch (e) {
    return actionErrorResult(e, 'actions.org_switcher.switch_organization');
  }
}
