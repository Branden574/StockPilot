'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ServiceError } from '@/server/services/context';

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
    const session = await requireSession();
    const supabase = await createClient();

    // Membership check before we touch the profile row.
    const { data: member } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', session.userId)
      .eq('organization_id', parsed.data.organizationId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
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
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
