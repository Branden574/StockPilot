import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { factorsOf, readMfaFactorList } from '@/lib/auth/mfa-factors';
import { carriesBridgeName } from '@/lib/auth/passkey-bridge-name';
import { isSessionEndedError } from '@/lib/auth/session-ended';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The account's passkey bridge, as the server recorded it (0475,
 * public.passkey_bridges), for the places that list, pick, check or remove an
 * authenticator app (plan section 3, stage 2).
 *
 * A passkey takes the session to aal2 through a hidden TOTP factor whose
 * secret only the server holds. Supabase Auth would treat it like any app: it
 * lists it (first, after each use: proof B7), checks a code for it, confirms
 * it while unverified (B4) and removes it (B6). So every such place leaves it
 * out, BY ITS RECORDED ID ONLY (review finding 5):
 *   - the reserved name (lib/auth/passkey-bridge-name.ts) is only the trigger
 *     to read the record: a list with no reserved-name factor reads nothing;
 *   - a reserved-name factor that is not the recorded one is treated like any
 *     authenticator app, and reported once per read (no id);
 *   - before 0475 exists (the table missing) there is no bridge: nothing is
 *     hidden and nothing is reported, as before;
 *   - a record that cannot be read for any other reason hides nothing, and is
 *     reported at error level (no id): a factor shown that should not be is a
 *     page that offers a bridge Auth would then refuse to pass for want of its
 *     code; a factor hidden that should not be would be an app taken away.
 */
export type PasskeyBridge =
  /** No reserved-name factor listed, no bridge recorded, or no records yet. */
  | { kind: 'none' }
  /** The account's recorded bridge factor. */
  | { kind: 'recorded'; factorId: string }
  /** The record could not be read: nothing is hidden. */
  | { kind: 'unreadable' };

/** Where a read is made, for the reports (never an id). */
export type PasskeyBridgeSite =
  | 'challenge'
  | 'verify_enrollment'
  | 'unenroll'
  | 'enroll_cleanup'
  | 'step_up_methods'
  | 'sign_in_page'
  | 'security_page'
  | 'password_reset';

interface ListedFactor {
  id?: string;
  friendly_name?: unknown;
}

const NONE: PasskeyBridge = { kind: 'none' };
const UNREADABLE: PasskeyBridge = { kind: 'unreadable' };

const BRIDGES_TABLE = 'passkey_bridges';
/**
 * The table does not exist yet (the web deploys before 0475 is pushed):
 * PostgREST's schema cache answers PGRST205, Postgres 42P01, each naming the
 * table (server/actions/export-presets.ts measured PGRST205). Any other error,
 * including one of these codes about another table, is a failed read.
 */
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01']);

function tableMissing(error: { code?: unknown; message?: unknown }): boolean {
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return MISSING_TABLE_CODES.has(code) && message.includes(BRIDGES_TABLE);
}

function reportUnreadable(site: PasskeyBridgeSite, detail: Record<string, string>): PasskeyBridge {
  void reportError(
    new Error('The account’s passkey bridge record could not be read; nothing was hidden'),
    {
      tag: 'passkeys.bridge_unreadable',
      level: 'error',
      extra: { site, ...detail },
    },
  );
  return UNREADABLE;
}

function reportNotOurs(site: PasskeyBridgeSite): void {
  void reportError(
    new Error(
      'A factor carries the passkey bridge name but is not the recorded bridge; it is treated as an app',
    ),
    { tag: 'passkeys.reserved_name_factor_not_ours', level: 'warning', extra: { site } },
  );
}

/**
 * The recorded bridge of `userId` (the account the request validated), read
 * only when one of `factors` carries the reserved name. Never throws.
 */
export async function readPasskeyBridge(
  userId: string,
  factors: readonly ListedFactor[],
  site: PasskeyBridgeSite,
): Promise<PasskeyBridge> {
  const named = factors.filter(carriesBridgeName);
  if (named.length === 0) return NONE;

  let answer: { data: unknown; error: { code?: unknown; message?: unknown } | null };
  try {
    // The service role: the table is readable by nothing else (0475 grants).
    answer = await createAdminClient()
      .from(BRIDGES_TABLE)
      .select('factor_id')
      .eq('user_id', userId)
      .maybeSingle();
  } catch {
    // A server without the service-role key, or a client that threw: never
    // the error's own text (it can name the setting).
    return reportUnreadable(site, { read: 'threw' });
  }
  if (answer.error) {
    if (tableMissing(answer.error)) return NONE;
    const code = typeof answer.error.code === 'string' ? answer.error.code : 'none';
    return reportUnreadable(site, { read: 'error', code });
  }
  if (answer.data === null) {
    reportNotOurs(site);
    return NONE;
  }
  const factorId =
    typeof answer.data === 'object'
      ? (answer.data as { factor_id?: unknown }).factor_id
      : undefined;
  if (typeof factorId !== 'string' || factorId.length === 0) {
    return reportUnreadable(site, { read: 'shape' });
  }
  if (named.some((f) => f.id !== factorId)) reportNotOurs(site);
  return { kind: 'recorded', factorId };
}

/** Whether `factorId` is the recorded bridge. A bridge not recorded, or unreadable, is never matched. */
export function isPasskeyBridge(bridge: PasskeyBridge, factorId: string | undefined): boolean {
  return bridge.kind === 'recorded' && factorId === bridge.factorId;
}

/** `factors` without the recorded bridge, in their order. */
export function withoutPasskeyBridge<T extends { id?: string }>(
  factors: readonly T[],
  bridge: PasskeyBridge,
): T[] {
  return factors.filter((f) => !isPasskeyBridge(bridge, f.id));
}

/**
 * Whether `factorId` is the recorded bridge of `userId`, for an action handed
 * a factor id with no factor list of its own (unenrollFactorAction). The
 * account's list (readMfaFactorList) supplies the trigger. A list that cannot
 * be read, or that is another account's, hides nothing: false, reported
 * (a session that has ended is not reported: the action's own call fails).
 * Never throws.
 */
export async function isRecordedPasskeyBridgeOf(
  supabase: Pick<SupabaseClient, 'auth'>,
  userId: string,
  factorId: string,
  site: PasskeyBridgeSite,
): Promise<boolean> {
  let factors;
  try {
    factors = factorsOf(await readMfaFactorList(supabase), userId);
  } catch (e) {
    if (!isSessionEndedError(e)) reportUnreadable(site, { read: 'factors' });
    return false;
  }
  if (!factors) return false;
  return isPasskeyBridge(await readPasskeyBridge(userId, factors, site), factorId);
}
