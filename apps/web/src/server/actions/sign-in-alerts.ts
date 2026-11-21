'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';

import { clientIpForRecord } from '@/lib/client-ip';
import { actionErrorResult } from '@/server/lib/action-error-result';
import { withContext } from '@/server/services/context';
import { readSignInAlert, reportSignInAlertNotMe } from '@/server/services/sign-in-alert-report';
import { SignInAlertsService } from '@/server/services/sign-in-alerts';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * The two answers a signed-in member gives to one of their own sign-in alerts
 * on Settings > Security (part 3 of the security tools).
 *
 * "This was me" (confirmSignInAlertAction): SignInAlertsService.confirm holds
 * the rule. It is refused while the session still owes the authenticator
 * step, and only an alert still open changes.
 *
 * "This was not me" (reportSignInAlertAction): the alert is read on the server
 * and must be the member's own; another account's alert, a made-up id and an
 * alert that could not be read are all refused, and the first two alike. Then
 * the same report the emailed link runs (server/services/sign-in-alert-report.ts):
 * every session of the account ends, so this browser is signed out here too.
 * It is NOT refused for a session that owes the authenticator step: the
 * report can only sign the account out, which is what the real owner wants
 * when the password is known to someone else. A report that could not finish
 * says so, and this browser stays signed in so the member can press again.
 */

const SECURITY_PAGE = '/dashboard/settings/security';
const alertSchema = z.object({ alertId: z.string().uuid() });

const NOT_FOUND = 'That sign-in alert was not found.';

export async function confirmSignInAlertAction(input: {
  alertId: string;
}): Promise<ActionResult<{ answer: 'confirmed' | 'unchanged' }>> {
  const parsed = alertSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid sign-in alert');
  try {
    const ctx = await withContext();
    const answer = await new SignInAlertsService(ctx).confirm(parsed.data.alertId);
    revalidatePath(SECURITY_PAGE);
    return ok({ answer });
  } catch (e) {
    return actionErrorResult(e, 'actions.sign_in_alerts.confirm');
  }
}

export async function reportSignInAlertAction(input: {
  alertId: string;
}): Promise<ActionResult<{ signedOut: true }>> {
  const parsed = alertSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid sign-in alert');
  try {
    const ctx = await withContext();
    const read = await readSignInAlert(parsed.data.alertId);
    if (read.kind === 'failed') {
      return err('internal_error', 'Your sign-in alert could not be read. Try again in a minute.');
    }
    if (read.kind === 'missing' || read.alert.userId !== ctx.userId) {
      return err('not_found', NOT_FOUND);
    }
    const requestHeaders = await headers();
    const answer = await reportSignInAlertNotMe({
      alert: read.alert,
      via: 'signed_in',
      request: {
        ip: clientIpForRecord(requestHeaders),
        userAgent: requestHeaders.get('user-agent'),
      },
    });
    if (answer.outcome !== 'done') {
      return err(
        'internal_error',
        'We could not sign you out everywhere just now. Press the button again in a minute.',
      );
    }
    // Every session of the account has ended; this browser's cookies go too.
    try {
      await ctx.supabase.auth.signOut({ scope: 'local' });
    } catch {
      // The session is already ended; the next page asks this browser to sign in.
    }
    return ok({ signedOut: true });
  } catch (e) {
    return actionErrorResult(e, 'actions.sign_in_alerts.report');
  }
}
