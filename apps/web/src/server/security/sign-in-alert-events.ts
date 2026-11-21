import 'server-only';

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
 * address to hash. A city the tables would refuse is left out
 * (lib/place-name.ts).
 *
 * Runs after the response (its callers do). Never throws.
 */

export type SignInAlertEventReason = 'sign_in_new_country' | 'sign_in_not_me';

/** The most organizations one account's event is recorded in. */
const MAX_ORGANIZATIONS = 5;

/** A header reader that names only the place, as Vercel's edge would send it. */
function placeHeaders(place: { country: string | null; city: string | null }): SecurityEventHeaders {
  const country = typeof place.country === 'string' ? place.country : null;
  const city = cityForRecord(place.city);
  return {
    get(name: string): string | null {
      const key = name.toLowerCase();
      if (key === 'x-vercel-ip-country') return country;
      if (key === 'x-vercel-ip-city') return city === null ? null : encodeURIComponent(city);
      return null;
    },
  };
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

/** Records the event in each organization of the account. Never throws. */
export async function recordSignInAlertEvent(args: {
  reason: SignInAlertEventReason;
  userId: string;
  source: 'web' | 'phone';
  place: { country: string | null; city: string | null };
}): Promise<void> {
  try {
    const headers = placeHeaders(args.place);
    const organizations = await organizationsOf(args.userId);
    const targets: Array<string | null> =
      organizations && organizations.length > 0 ? organizations : [null];
    for (const organizationId of targets) {
      await recordSecurityEvent(
        {
          category: 'phishing',
          outcome: 'flagged',
          reason: args.reason,
          source: args.source,
          organizationId,
        },
        headers,
      );
    }
  } catch {
    // Never the caller's problem: these are counts for admins to read.
  }
}
