import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/error-reporter';
import { listRows } from '@/server/services/lib/list-rows';

/** A service-role client (createAdminClient, or one handed in by a caller). */
type AdminClient = SupabaseClient;

/** One of the two reads behind the current-member rule, failed. */
export interface CurrentMemberReadFailure {
  read: 'membership' | 'profile';
  /** The read's error, for reportError only: it is never answered (S31). */
  error: Error;
}

export type CurrentMemberAnswer =
  /** Both reads answered. */
  | { readable: true; current: boolean }
  /** At least one read failed: never a membership, never "not disabled". */
  | { readable: false; failures: CurrentMemberReadFailure[] };

/**
 * Whether `userId` is a CURRENT member of `organizationId` (docket S36): an
 * accepted membership of that organization that is not a support Act-as seat,
 * on an account that is not disabled. The rule of the database's
 * _notify_is_current_member (0422), read here from the tables with the service
 * role, so a web deploy never depends on the migration.
 *
 * It keeps out someone removed from the organization or who left it (removing
 * a member or leaving deletes only the membership row; a stored id such as an
 * order's requester stays), an invite never accepted, a support Act-as seat (a
 * real owner row with impersonation_expires_at set) and a disabled account
 * (migs 0308-0311).
 *
 * The one rule for what the app sends a person about an organization's
 * records: every in-app notice, and through the 0028 trigger every push
 * (createNotification), and every email to a member's own address
 * (ownAddressVerdict below). The two point reads run together. A failed read
 * answers `readable: false`; every caller then fails closed (nothing written,
 * nothing sent) and reports it.
 */
export async function readCurrentMember(
  admin: AdminClient,
  organizationId: string,
  userId: string,
): Promise<CurrentMemberAnswer> {
  // Both are list reads (docket S27): an answer that is not a list (an empty
  // body) is a failed read, never "no row", so it can read neither as "not a
  // member" in silence nor as "not disabled".
  const [membership, profile] = await Promise.all([
    admin
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null)
      .limit(2),
    admin.from('user_profiles').select('disabled_at').eq('id', userId).limit(2),
  ]);
  const failures: CurrentMemberReadFailure[] = [];
  const memberRows = rowsOf<{ user_id: string }>(
    'membership',
    'organization_members',
    membership,
    failures,
  );
  const profileRows = rowsOf<{ disabled_at?: string | null }>(
    'profile',
    'user_profiles',
    profile,
    failures,
  );
  if (failures.length > 0 || !memberRows || !profileRows) {
    return { readable: false, failures };
  }
  const disabled = Boolean(profileRows[0]?.disabled_at);
  return { readable: true, current: memberRows.length === 1 && !disabled };
}

/**
 * The rows of one point read, or null with its failure recorded: an error, an
 * answer that is not a list, or more than one row for a key that names one.
 */
function rowsOf<Row>(
  read: CurrentMemberReadFailure['read'],
  table: string,
  res: { data?: unknown; error?: { message: string } | null; status?: number | null },
  failures: CurrentMemberReadFailure[],
): Row[] | null {
  if (res.error) {
    failures.push({ read, error: new Error(res.error.message) });
    return null;
  }
  let rows: Row[];
  try {
    rows = listRows<Row>(table, res);
  } catch (err) {
    failures.push({ read, error: err instanceof Error ? err : new Error(String(err)) });
    return null;
  }
  if (rows.length > 1) {
    failures.push({ read, error: new Error(`${table} answered more than one row`) });
    return null;
  }
  return rows;
}

export type OwnAddressVerdict = 'current' | 'not_current' | 'unreadable';

/**
 * Docket S36: may an email go to a member's OWN address (their profile's, or
 * a snapshot taken from it) about a record of `organizationId`? Only while they
 * are a current member of it (readCurrentMember). An address a record kept for
 * an outside person (the requester_email of an on-behalf, public-link or portal
 * order) is not a member's own and never comes here: it is sent as before.
 *
 * No person (the account was deleted since the address was taken) is never a
 * current member. 'unreadable' (a read failed or threw) is reported once under
 * `report.tag`, and the caller sends nothing, as for 'not_current'.
 */
export async function ownAddressVerdict(
  admin: AdminClient,
  person: { organizationId: string; userId: string | null | undefined },
  report: { tag: string; extra?: Record<string, unknown> },
): Promise<OwnAddressVerdict> {
  if (!person.userId) return 'not_current';
  let failure: unknown;
  try {
    const answer = await readCurrentMember(admin, person.organizationId, person.userId);
    if (answer.readable) return answer.current ? 'current' : 'not_current';
    // One report for the one or two reads that failed.
    const [first, second] = answer.failures;
    failure = new Error(
      second
        ? `${first!.read} read: ${first!.error.message}; ${second.read} read: ${second.error.message}`
        : `${first!.read} read: ${first!.error.message}`,
    );
  } catch (err) {
    failure = err;
  }
  await reportError(failure, {
    tag: report.tag,
    level: 'warning',
    extra: { ...report.extra, organizationId: person.organizationId, userId: person.userId },
  });
  return 'unreadable';
}
