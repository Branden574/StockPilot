import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { MemberUnsubscribeClaim } from '@/lib/email/member-unsubscribe';
import type { NotificationPrefKey } from '@/lib/notification-prefs';

import { insertAuditRowReported } from './audit';
import {
  DIGEST_OPTIN_COLUMN,
  digestPrefsUpdate,
  writeDigestPrefs,
  writeNotificationPrefs,
} from './notification-preferences';

/**
 * The one-click unsubscribe in a member email (B15), after app/unsubscribe has
 * verified the link (lib/email/member-unsubscribe.ts). There is no session:
 * the signed link is the proof, and this runs with the service role.
 *
 * What it switches off is the switch the signed-in Notifications page shows,
 * written by the very function that page's action uses
 * (services/notification-preferences.ts), for the member the link names and
 * no one else:
 *   weekly_digest       user_profiles.email_digest_optin, the card's "Email me
 *                       a weekly inventory digest" (what the cron sends on);
 *   schedule_reminders  notification_preferences.email_schedule_reminders,
 *                       "Schedule reminders" under email. The push switch is
 *                       a separate column and is left as it is.
 * Both are the account's own switches, so they cover every workspace the
 * member belongs to, exactly as turning them off on the page does.
 *
 * The link names an organization too, and is honoured only while its member
 * is a real member of it: accepted, and not a platform admin's act-as grant
 * (the same rule as the crons that send these emails). A removed member's link
 * changes nothing; the route answers it exactly as it answers a forged link,
 * so a link says nothing about the account behind it.
 *
 * Nor is it honoured for a disabled account. The service role passes the
 * 0309 trigger that freezes a disabled profile for every request-facing role,
 * and a disabled member cannot sign in to change a setting, so the link must
 * not be the one request that still can. (Nothing is lost: the crons send a
 * disabled account neither email.)
 *
 * Idempotent: a switch already off is not written again and gets no second
 * audit row. A failed read or write throws, so the route answers 500 and a
 * mail provider retries its one-click POST instead of counting it done.
 */

export type MemberUnsubscribeOutcome =
  'unsubscribed' | 'already_unsubscribed' | 'not_member' | 'account_disabled';

/** The request, for the audit row. */
export interface UnsubscribeRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const SCHEDULE_EMAIL_COLUMN = 'email_schedule_reminders' satisfies NotificationPrefKey;

export async function unsubscribeMemberEmail(
  admin: SupabaseClient,
  claim: MemberUnsubscribeClaim,
  meta: UnsubscribeRequestMeta,
): Promise<MemberUnsubscribeOutcome> {
  const { data: membership, error: membershipError } = await admin
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', claim.organizationId)
    .eq('user_id', claim.userId)
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null)
    .maybeSingle();
  if (membershipError) {
    throw new Error(`membership read failed: ${membershipError.message}`);
  }
  if (!membership) return 'not_member';

  const { data: profileRow, error: profileError } = await admin
    .from('user_profiles')
    .select(`${DIGEST_OPTIN_COLUMN}, disabled_at`)
    .eq('id', claim.userId)
    .maybeSingle();
  if (profileError) throw new Error(`profile read failed: ${profileError.message}`);
  // The membership row cascades from the profile, so this is a race with an
  // account deletion: nothing left to switch off.
  if (!profileRow) return 'not_member';
  const profile = profileRow as {
    email_digest_optin?: boolean | null;
    disabled_at?: string | null;
  };
  if (profile.disabled_at) return 'account_disabled';

  if (claim.kind === 'weekly_digest') {
    if (profile.email_digest_optin === false) return 'already_unsubscribed';
    const { error: writeError } = await writeDigestPrefs(
      admin,
      claim.userId,
      digestPrefsUpdate({ optIn: false }),
    );
    if (writeError) throw new Error(`digest switch write failed: ${writeError.message}`);
    recordUnsubscribe(claim, meta, DIGEST_OPTIN_COLUMN, true);
    return 'unsubscribed';
  }

  const { data: prefs, error: readError } = await admin
    .from('notification_preferences')
    .select(SCHEDULE_EMAIL_COLUMN)
    .eq('user_id', claim.userId)
    .maybeSingle();
  if (readError) throw new Error(`reminder switch read failed: ${readError.message}`);
  // No row, or no value: on (the table's default, and what the cron assumes).
  const before =
    (prefs as { email_schedule_reminders?: boolean | null } | null)?.email_schedule_reminders ??
    true;
  if (before === false) return 'already_unsubscribed';
  const { error: writeError } = await writeNotificationPrefs(admin, claim.userId, {
    [SCHEDULE_EMAIL_COLUMN]: false,
  });
  if (writeError) throw new Error(`reminder switch write failed: ${writeError.message}`);
  recordUnsubscribe(claim, meta, SCHEDULE_EMAIL_COLUMN, before);
  return 'unsubscribed';
}

/**
 * The audit row the settings page's per-event action writes for the same
 * change ('notification_preference.updated', before, after, changed_keys),
 * in the link's organization and by the member, marked as made from an
 * email's unsubscribe link. Kept alive past the response; a lost row is
 * reported by the helper, never thrown.
 */
function recordUnsubscribe(
  claim: MemberUnsubscribeClaim,
  meta: UnsubscribeRequestMeta,
  column: string,
  before: boolean,
): void {
  void insertAuditRowReported({
    organization_id: claim.organizationId,
    user_id: claim.userId,
    event: 'notification_preference.updated',
    ip: meta.ip,
    user_agent: meta.userAgent,
    metadata: {
      entity_type: 'user',
      entity_id: claim.userId,
      warehouse_id: null,
      before: { [column]: before },
      after: { [column]: false },
      reason: null,
      changed_keys: [column],
      surface: 'email_unsubscribe_link',
      email_kind: claim.kind,
    },
  });
}
