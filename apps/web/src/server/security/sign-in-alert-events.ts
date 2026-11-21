import 'server-only';

import { placeOnlyHeaders } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { cityForRecord } from '@/lib/place-name';
import { createAdminClient } from '@/lib/supabase/admin';

import { recordSecurityEvent, type SecurityEventHeaders } from './events';

/**
 * The security events of a sign-in alert (part 3 of the security tools), for
 * the organization's Blocked activity page and the platform console:
 *   - sign_in_new_country: a sign-in from a country the account had not
 *     signed in from before (lib/auth/login-device.ts);
 *   - sign_in_not_me: the member said a sign-in was not them
 *     (server/services/sign-in-alert-report.ts).
 * Both are phishing / flagged: the sign-in happened; the alert is a question.
 *   - sign_in_alerts_held: a sign-in that owed an alert was turned away by
 *     the account's daily ceiling on alert rows, so nothing was written for
 *     it (lib/auth/login-device.ts). password_guessing / flagged: that many
 *     sign-ins from new devices or countries in a day reads as someone
 *     working with the password. One event per sign-in turned away; the
 *     recorder adds them up by minute, so they cannot flood.
 *
 * THE ORGANIZATIONS COME FROM THE SERVER: the account's own memberships, read
 * here with the service role from the account id (an accepted membership that
 * is not a support act-as seat, at most 5, the rule the new-device webhook
 * event follows). One event in each. An account in none, or whose memberships
 * could not be read, gets one event with no organization, so the platform
 * console still counts it; a failed read is reported with its code only.
 *
 * THE PLACE IS THE SIGN-IN'S, never the reader's: a "not me" can be pressed
 * from anywhere, and what matters is where the sign-in came from. It is handed
 * to the recorder as Vercel's two place headers and nothing else, so the
 * recorder reads the place by its usual rule (only on Vercel) and finds no
 * address to hash (lib/client-ip.ts placeOnlyHeaders). A city the tables would refuse is left out
 * (lib/place-name.ts).
 *
 * Runs after the response (its callers do). Never throws.
 */

export type SignInAlertEventReason = 'sign_in_new_country' | 'sign_in_not_me';

/** The most organizations one account's event is recorded in. */
const MAX_ORGANIZATIONS = 5;

/** The sign-in's place as headers (lib/client-ip.ts), with a city the tables would refuse left out. */
function placeHeaders(place: { country: string | null; city: string | null }): SecurityEventHeaders {
  return placeOnlyHeaders({
    country: typeof place.country === 'string' ? place.country : null,
    city: cityForRecord(place.city),
  });
}

/** The account's real organizations, or null when they could not be read (reported). */
async function organizationsOf(userId: string): Promise<string[] | null> {
  try {
    const { data, error } = await createAdminClient()
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null)
      .limit(MAX_ORGANIZATIONS);
    if (error || !Array.isArray(data)) {
      const code = (error as { code?: unknown } | null)?.code;
      void reportError(new Error('Sign-in alert event organizations could not be read'), {
        tag: 'security.sign_in_alert_event_organizations',
        level: 'warning',
        extra: { code: typeof code === 'string' ? code : null },
      });
      return null;
    }
    return (data as Array<{ organization_id?: unknown }>)
      .map((row) => row.organization_id)
      .filter((id): id is string => typeof id === 'string')
      .slice(0, MAX_ORGANIZATIONS);
  } catch {
    return null;
  }
}

/** One flagged event in each organization of the account, or one with none. Never throws. */
async function recordInOrganizations(
  event: {
    category: 'phishing' | 'password_guessing';
    reason: SignInAlertEventReason | 'sign_in_alerts_held';
    source: 'web' | 'phone';
  },
  userId: string,
  place: { country: string | null; city: string | null },
): Promise<void> {
  try {
    const headers = placeHeaders(place);
    const organizations = await organizationsOf(userId);
    const targets: Array<string | null> =
      organizations && organizations.length > 0 ? organizations : [null];
    for (const organizationId of targets) {
      await recordSecurityEvent(
        {
          category: event.category,
          outcome: 'flagged',
          reason: event.reason,
          source: event.source,
          organizationId,
        },
        headers,
      );
    }
  } catch {
    // Never the caller's problem: these are counts for admins to read.
  }
}

/** Records the event in each organization of the account. Never throws. */
export async function recordSignInAlertEvent(args: {
  reason: SignInAlertEventReason;
  userId: string;
  source: 'web' | 'phone';
  place: { country: string | null; city: string | null };
}): Promise<void> {
  await recordInOrganizations(
    { category: 'phishing', reason: args.reason, source: args.source },
    args.userId,
    args.place,
  );
}

/**
 * A sign-in that owed an alert was turned away by the account's daily ceiling
 * on alert rows: password_guessing / flagged / sign_in_alerts_held, in each
 * organization of the account (the same read and the same rule as above).
 * Never throws.
 */
export async function recordSignInAlertsHeldEvent(args: {
  userId: string;
  source: 'web' | 'phone';
  place: { country: string | null; city: string | null };
}): Promise<void> {
  await recordInOrganizations(
    { category: 'password_guessing', reason: 'sign_in_alerts_held', source: args.source },
    args.userId,
    args.place,
  );
}
