import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { NotificationPreferences } from '@/lib/notification-prefs';

/**
 * The two writes behind the signed-in Notifications page, shared with the
 * public one-click unsubscribe (services/member-email-unsubscribe.ts), so a
 * link in an email switches off exactly the switch that page shows and the
 * member would turn off themselves.
 *
 * The caller decides whose row it is and with which client: the session's own
 * user and client for the settings actions (RLS lets a user write only their
 * own rows), or the member a verified unsubscribe link names, with the service
 * role (there is no session behind a link in an email).
 */

/** The weekly digest card's switches, all on user_profiles (0034, 0036). */
export interface DigestPrefs {
  /** "Email me a weekly inventory digest". */
  optIn?: boolean;
  lowStock?: boolean;
  openPos?: boolean;
  cycleCounts?: boolean;
}

const DIGEST_PREF_COLUMNS = {
  optIn: 'email_digest_optin',
  lowStock: 'digest_section_low_stock',
  openPos: 'digest_section_open_pos',
  cycleCounts: 'digest_section_cycle_counts',
} as const satisfies Record<keyof DigestPrefs, string>;

/** The digest's master switch column: what the weekly-digest cron sends on. */
export const DIGEST_OPTIN_COLUMN = DIGEST_PREF_COLUMNS.optIn;

/** The user_profiles columns for the keys given; keys left out are left alone. */
export function digestPrefsUpdate(prefs: DigestPrefs): Record<string, boolean> {
  const update: Record<string, boolean> = {};
  for (const key of Object.keys(DIGEST_PREF_COLUMNS) as Array<keyof DigestPrefs>) {
    const value = prefs[key];
    if (typeof value === 'boolean') update[DIGEST_PREF_COLUMNS[key]] = value;
  }
  return update;
}

type WriteResult = { error: { message: string } | null };

/** Writes the digest switches on the user's profile row. */
export async function writeDigestPrefs(
  client: SupabaseClient,
  userId: string,
  update: Record<string, boolean>,
): Promise<WriteResult> {
  const { error } = await client.from('user_profiles').update(update).eq('id', userId);
  return { error: error ? { message: error.message } : null };
}

/**
 * Writes per-event switches on the user's notification_preferences row. An
 * upsert on user_id, so the first write for a user who somehow has no row
 * creates it (the other columns take their defaults, all on); only the keys
 * given change.
 */
export async function writeNotificationPrefs(
  client: SupabaseClient,
  userId: string,
  patch: Partial<NotificationPreferences>,
): Promise<WriteResult> {
  const { error } = await client
    .from('notification_preferences')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  return { error: error ? { message: error.message } : null };
}
