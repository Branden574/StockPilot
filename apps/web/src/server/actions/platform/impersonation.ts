'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPlatformAdmin, currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';
import { requireSession } from '@/lib/auth/session';
import { startActingAs, stopActingAs } from '@/server/services/platform/impersonation';

import { err, ok, type ActionResult } from '@stockpilot/core';

const startSchema = z.object({ organizationId: z.string().uuid() });

/**
 * Start "Act as this org". DANGEROUS (grants a live owner membership) →
 * platform-admin + fresh AAL2 step-up. On success the caller redirects to
 * /dashboard, now scoped to the target org.
 */
export async function startActingAsAction(
  input: z.infer<typeof startSchema>,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid organization id');

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return gate.reason === 'aal2_required'
      ? err('forbidden', 'Re-authenticate with MFA to act as an organization.', {
          reason: 'aal2_required',
        })
      : err('forbidden', 'Not authorized.');
  }

  try {
    const res = await startActingAs({
      adminUserId: gate.session.userId,
      adminEmail: gate.session.email,
      organizationId: parsed.data.organizationId,
    });
    if (!res.ok) return err('not_found', 'Organization not found.');
  } catch (e) {
    return err('internal_error', e instanceof Error ? e.message : 'Could not start impersonation');
  }

  revalidatePath('/dashboard', 'layout');
  return ok({ ok: true });
}

/**
 * Stop impersonating. NOT step-up gated — stopping is always safe (it removes
 * access). Still platform-admin gated so a non-admin can't poke the endpoint.
 * Reads the session directly (no input) so it always targets the caller's own
 * active grant.
 */
export async function stopActingAsAction(): Promise<ActionResult<{ ok: true }>> {
  const session = await requireSession();
  if (!(await currentUserIsPlatformAdmin())) {
    // A non-admin has no impersonation grant anyway; respond generically.
    return err('forbidden', 'Not authorized.');
  }
  try {
    await stopActingAs({ adminUserId: session.userId, adminEmail: session.email });
  } catch (e) {
    return err('internal_error', e instanceof Error ? e.message : 'Could not stop impersonation');
  }
  revalidatePath('/dashboard', 'layout');
  return ok({ ok: true });
}
