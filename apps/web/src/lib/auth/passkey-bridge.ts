import 'server-only';

import { createHash } from 'node:crypto';

import { carriesBridgeName } from '@/lib/auth/passkey-bridge-name';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * The account's passkey bridge, as the server recorded it (0475,
 * public.passkey_bridges), for the places that list, pick, check or remove an
 * authenticator app (plan section 3, stage 2).
 *
 * A passkey takes the session to aal2 through a hidden TOTP factor whose
 * secret only the server holds. Supabase Auth would treat it like any app: it
 * lists it (the factor used last goes to the END of the list, so the bridge
 * is listed first after the member's app is used: proof B7), checks a code
 * for it, confirms it while unverified (B4) and removes it (B6). So every
 * such place leaves it out, BY ITS RECORDED ID ONLY (plan review finding 5):
 *   - the reserved name (lib/auth/passkey-bridge-name.ts) is only the trigger
 *     to read the record: a list with no reserved-name factor reads nothing,
 *     counts nothing and reports nothing;
 *   - a reserved-name factor that is not the recorded one is treated like any
 *     authenticator app, and reported at warning level at most once per
 *     account per hour (a closed limiter; review 2-3 finding 8);
 *   - the table missing (before 0475 is live, or a schema cache that lost it
 *     after a restore) means no bridge can be known: nothing is hidden, and
 *     it is reported at error level at most once per hour for every account
 *     together (review 2-3 finding 3);
 *   - a record that cannot be read for any other reason hides nothing from a
 *     LIST, and is reported at error level: a factor shown that should not be
 *     is a page that offers a bridge Auth would then refuse to pass for want
 *     of its code; a factor hidden that should not be would be an app taken
 *     away. An action that CHANGES a factor holds back, while the record
 *     cannot be read, every factor that carries the reserved name
 *     (factorChangeRefusal, review 2-3 finding 2).
 * Reports carry no factor id and no account id; the ones about one account
 * carry a hash of its id (accountIdHash).
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
  | 'password_reset'
  | 'recovery_code';

interface ListedFactor {
  id?: string;
  friendly_name?: unknown;
}

const NONE: PasskeyBridge = { kind: 'none' };
const UNREADABLE: PasskeyBridge = { kind: 'unreadable' };

/**
 * The answer of an action that changes a factor while the record cannot be
 * read and the factor carries the reserved name (factorChangeRefusal).
 */
export const FACTOR_CHECK_RETRY = 'Could not check this authenticator just now. Try again in a moment.';

/** One report of each limited kind per this long (a closed limiter decides). */
const REPORT_WINDOW_MS = 60 * 60_000;

/**
 * The account id in a report: the house hash (sha-256, the first 16 hex
 * characters, as lib/auth/login-device.ts reports an account). Never the id.
 */
export function accountIdHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

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

/**
 * A reserved-name factor that is not the recorded bridge: one warning per
 * account per window. The limiter is closed, so one that cannot answer
 * reports nothing (lib/rate-limit logs the failure). Reached only on the
 * reserved-name path: an ordinary account never counts here.
 */
async function reportNotOurs(site: PasskeyBridgeSite, userId: string): Promise<void> {
  const first = await checkRateLimit(
    `passkeys-not-ours-report:${userId}`,
    1,
    REPORT_WINDOW_MS,
    'closed',
  );
  if (!first.allowed) return;
  void reportError(
    new Error(
      'A factor carries the passkey bridge name but is not the recorded bridge; it is treated as an app',
    ),
    {
      tag: 'passkeys.reserved_name_factor_not_ours',
      level: 'warning',
      userIdHash: accountIdHash(userId),
      extra: { site },
    },
  );
}

/**
 * A reserved-name factor was seen while the passkey records were missing:
 * the bridges table (any site), or the recovery code's function
 * consume_recovery_code_with_passkeys (site 'recovery_code'). Before 0475 is
 * live that is a factor nobody made through our server; after it, something
 * broke (a schema cache that lost the objects after a restore, a changed
 * signature, a dropped grant), and bridges are then shown, offered and
 * removable like apps. One error report per window for every account
 * together (the state is the database's, not the account's), with the hash
 * of the account that met it first. Closed limiter. Never throws.
 */
export async function reportPasskeyRecordsMissing(
  missing: 'table' | 'function',
  site: PasskeyBridgeSite,
  userId: string,
): Promise<void> {
  const first = await checkRateLimit(
    `passkeys-records-missing-report:${missing}`,
    1,
    REPORT_WINDOW_MS,
    'closed',
  );
  if (!first.allowed) return;
  void reportError(
    new Error(
      'A factor carries the passkey bridge name while the passkey records are missing; bridges cannot be known',
    ),
    {
      tag: 'passkeys.records_missing',
      level: 'error',
      userIdHash: accountIdHash(userId),
      extra: { missing, site },
    },
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
    if (tableMissing(answer.error)) {
      await reportPasskeyRecordsMissing('table', site, userId);
      return NONE;
    }
    const code = typeof answer.error.code === 'string' ? answer.error.code : 'none';
    return reportUnreadable(site, { read: 'error', code });
  }
  if (answer.data === null) {
    await reportNotOurs(site, userId);
    return NONE;
  }
  const factorId =
    typeof answer.data === 'object'
      ? (answer.data as { factor_id?: unknown }).factor_id
      : undefined;
  if (typeof factorId !== 'string' || factorId.length === 0) {
    return reportUnreadable(site, { read: 'shape' });
  }
  if (named.some((f) => f.id !== factorId)) await reportNotOurs(site, userId);
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
 * Why an action that CHANGES a factor (unenrollFactorAction,
 * verifyEnrollmentAction, the set-up clean-up in enrollFactorAction) must
 * leave `factor` alone, or null when it may go on:
 *   - 'passkey_bridge': it is the account's recorded bridge;
 *   - 'bridge_unreadable': the record could not be read and the factor carries
 *     the reserved name (review 2-3 finding 2). Listing hides nothing on a
 *     failed read; changing is different: removing or confirming the bridge
 *     by accident (it is listed as an app while the record cannot be read)
 *     would end the member's passkey with no word to them. The name is used
 *     here only while the record cannot be read; the answer is "try again in
 *     a moment" (FACTOR_CHECK_RETRY), and the failed read was reported.
 * A factor without the reserved name is never held back, and the table
 * missing ('none') holds back nothing.
 */
export function factorChangeRefusal(
  bridge: PasskeyBridge,
  factor: ListedFactor,
): 'passkey_bridge' | 'bridge_unreadable' | null {
  if (isPasskeyBridge(bridge, factor.id)) return 'passkey_bridge';
  if (bridge.kind === 'unreadable' && carriesBridgeName(factor)) return 'bridge_unreadable';
  return null;
}
