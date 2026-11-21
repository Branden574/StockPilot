'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';

import { signOutThisSession } from '@/lib/auth/mfa-code-attempts';
import { clientIpForRecord } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { actionErrorResult } from '@/server/lib/action-error-result';
import { withContext } from '@/server/services/context';
import {
  alertReportedMeanwhile,
  readSignInAlert,
  reportSignInAlertNotMe,
} from '@/server/services/sign-in-alert-report';
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
 * every session of the account is ended, so this browser is signed out here
 * too. It is NOT refused for a session that owes the authenticator step: the
 * report ends the account's own sessions and tells the owners and admins once
 * per alert, which is what the real owner wants when the password is known
 * to someone else. A report that could not finish says so, and this browser
 * stays signed in so the member can press again.
 *
 * ONE ALERT, ONE SIGN-OUT: an alert that was already reported is not reported
 * again. Nothing is ended and nobody is told; the answer says so and names
 * the control that ends the other sessions (Active sessions shows it next to
 * the reported alert). The action is counted per account, 10 an hour, failing
 * closed, before the alert is read, as the emailed link is counted. A count
 * that could not be read looks once more at the caller's own alert first
 * (two presses at the same instant can make the limiter fail for one of
 * them): reported by then, the answer is "already reported", which is true;
 * otherwise "try again in a moment". The press itself does nothing either way.
 */

const SECURITY_PAGE = '/dashboard/settings/security';
const alertSchema = z.object({ alertId: z.string().uuid() });

const NOT_FOUND = 'That sign-in alert was not found.';
const ALREADY_REPORTED =
  'You already reported this sign-in. Every session of your account was ended then. To end them again, use Sign out all other devices, then reset your password.';

/** "This was not me" presses per account per hour (the link's per-alert count is the same). */
const REPORTS_PER_ACCOUNT_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;

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
    const counted = await checkRateLimit(
      `sign-in-alert-report:user:${ctx.userId}`,
      REPORTS_PER_ACCOUNT_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    );
    // A count that could not be read is not "too many": the member did
    // nothing wrong, and nothing is done. If their own alert is reported by
    // now (the other of two presses at once), that is the true answer.
    if (counted.failed) {
      if (await alertReportedMeanwhile(parsed.data.alertId, ctx.userId)) {
        revalidatePath(SECURITY_PAGE);
        return err('conflict', ALREADY_REPORTED);
      }
      return err('internal_error', 'Please try again in a moment.');
    }
    if (!counted.allowed) {
      return err('rate_limited', 'Too many tries. Wait a few minutes, then press the button again.');
    }
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
      auditFrom: {
        ip: clientIpForRecord(requestHeaders),
        userAgent: requestHeaders.get('user-agent'),
      },
    });
    if (answer.outcome === 'already_reported') {
      // Reported from the email's link or another tab: nothing was ended or
      // told again, and the list on the page is stale.
      revalidatePath(SECURITY_PAGE);
      return err('conflict', ALREADY_REPORTED);
    }
    if (answer.outcome !== 'done') {
      return err('internal_error', 'We could not finish this just now. Press the button again in a minute.');
    }
    // Every session of the account has been ended; this browser's cookies go too
    // (scope 'local': auth-js removes them even when GoTrue does not answer,
    // and the helper never throws).
    await signOutThisSession(ctx.supabase);
    return ok({ signedOut: true });
  } catch (e) {
    return actionErrorResult(e, 'actions.sign_in_alerts.report');
  }
}
