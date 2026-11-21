import 'server-only';

import {
  SIGN_IN_ALERTS_LIST_PATH,
  sendSignedOutEverywhereEmail,
  sendSignInReportedEmail,
} from '@/lib/email/login-alert';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { recordSignInAlertEvent } from '@/server/security/sign-in-alert-events';
import { insertAuditRowReported } from '@/server/services/audit';
import { fetchAllRowsByIds } from '@/server/services/lib/fetch-by-ids';
import { createNotification } from '@/server/services/notifications';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';

/**
 * A member's "This was not me" on a sign-in alert (part 3 of the security
 * tools). One function for both ways in: the signed link in the alert email
 * (app/sign-in-alert/route.ts) and the button on Active sessions
 * (server/actions/sign-in-alerts.ts). Each caller has already decided the
 * alert is the member's own; this only acts on it.
 *
 * THE STEPS, in order:
 *   1. The alert is marked not_me, with its resolved_at, in ONE update that
 *      changes only an alert not already not_me (the table requires the two
 *      together). "This was me" earlier does not stop it.
 *   2. Every session of the account ends (revokeAllSessionsForUser), whether
 *      or not step 1 changed a row: a retry after a report that stopped half
 *      way must still sign out.
 *   3. The device row of the alert is forgotten (by its hash) only when the
 *      alert was about a new device, and the country row only when it was
 *      about a new country, so the next sign-in from either alerts again.
 *   4. Only when step 1 changed the row (the first report), so a second press
 *      tells nobody again:
 *        - the member is emailed "signed out everywhere", only when step 2
 *          worked in this same call (the email would not be true otherwise);
 *        - the owners and admins of each organization the member belongs to
 *          (an accepted membership that is not a support act-as seat, at most
 *          5 organizations) get an in-app notice in each organization and one
 *          email each, naming the device FAMILY, never the member's own label.
 *          Managers and staff are never told, and a member who is an admin is
 *          not told a second time as one; a disabled account gets no email
 *          (createNotification skips it too);
 *        - one audit row per organization (security.sign_in_reported), or one
 *          with no organization when there is none or they could not be read;
 *        - one security event (phishing / flagged / sign_in_not_me), with the
 *          sign-in's place, not the reader's.
 *
 * Steps 1 and 2 decide the answer: 'done' only when the update answered and
 * every session ended. Everything after them is best effort; a failure is
 * reported with a code or a fixed word only (never an address or a name), and
 * never changes the answer. Never throws.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most organizations a report reaches, the rule the alert's other reads follow. */
const MAX_ORGANIZATIONS = 5;

/** An alert as the server reads it, with the columns the report and the link page need. */
export interface SignInAlertRecord {
  id: string;
  userId: string;
  sessionId: string | null;
  newDevice: boolean;
  newCountry: boolean;
  client: 'web' | 'phone';
  /** What the MEMBER sees ("Avery work laptop"). */
  deviceLabel: string;
  /** What the ORGANIZATION sees ("Chrome on macOS"). */
  deviceFamily: string;
  deviceHash: string | null;
  country: string | null;
  city: string | null;
  status: 'open' | 'was_me' | 'not_me';
  createdAt: string;
}

export type SignInAlertRead =
  | { kind: 'found'; alert: SignInAlertRecord }
  | { kind: 'missing' }
  | { kind: 'failed' };

export type SignInAlertReportAnswer =
  | { outcome: 'done'; firstReport: boolean }
  | { outcome: 'failed' };

const ALERT_COLUMNS =
  'id, user_id, session_id, new_device, new_country, client, device_label, device_family, device_hash, country, city, status, created_at';

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toRecord(row: Record<string, unknown>): SignInAlertRecord | null {
  const id = text(row.id);
  const userId = text(row.user_id);
  const status = row.status;
  if (!id || !userId || (status !== 'open' && status !== 'was_me' && status !== 'not_me')) return null;
  return {
    id,
    userId,
    sessionId: text(row.session_id),
    newDevice: row.new_device === true,
    newCountry: row.new_country === true,
    client: row.client === 'phone' ? 'phone' : 'web',
    deviceLabel: text(row.device_label) ?? 'Unknown device',
    deviceFamily: text(row.device_family) ?? 'Unknown device',
    deviceHash: text(row.device_hash),
    country: text(row.country),
    city: text(row.city),
    status,
    createdAt: text(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * One alert by its id, read with the service role (the table has no policy
 * for anyone else). An id that is not a uuid is missing without a read.
 * Never throws.
 */
export async function readSignInAlert(alertId: string): Promise<SignInAlertRead> {
  if (typeof alertId !== 'string' || !UUID.test(alertId)) return { kind: 'missing' };
  try {
    const { data, error } = await createAdminClient()
      .from('sign_in_alerts')
      .select(ALERT_COLUMNS)
      .eq('id', alertId)
      .limit(2);
    if (error || !Array.isArray(data)) return { kind: 'failed' };
    if (data.length !== 1) return { kind: 'missing' };
    const alert = toRecord(data[0] as Record<string, unknown>);
    return alert ? { kind: 'found', alert } : { kind: 'missing' };
  } catch {
    return { kind: 'failed' };
  }
}

type Admin = ReturnType<typeof createAdminClient>;

function reportFailure(tag: string, extra: Record<string, string | null>): void {
  void reportError(new Error('A sign-in alert report step failed'), {
    tag,
    level: 'warning',
    extra,
  });
}

/** Step 1. Whether the update answered, and whether it changed the row. */
async function markNotMe(
  admin: Admin,
  alert: SignInAlertRecord,
): Promise<{ answered: boolean; changed: boolean }> {
  try {
    const { data, error } = await admin
      .from('sign_in_alerts')
      .update({ status: 'not_me', resolved_at: new Date().toISOString() })
      .eq('id', alert.id)
      .eq('user_id', alert.userId)
      .neq('status', 'not_me')
      .select('id');
    if (error || !Array.isArray(data)) {
      reportFailure('security.sign_in_report_update_failed', { code: codeOf(error) });
      return { answered: false, changed: false };
    }
    return { answered: true, changed: data.length > 0 };
  } catch {
    reportFailure('security.sign_in_report_update_failed', { code: null });
    return { answered: false, changed: false };
  }
}

/** Step 2. Never throws; revokeAllSessionsForUser reports its own failure. */
async function signOutEverywhere(userId: string): Promise<boolean> {
  try {
    return (await revokeAllSessionsForUser(userId)).ok;
  } catch {
    return false;
  }
}

/** Step 3: the rows that made this sign-in "known", so the next one alerts again. */
async function forgetRows(admin: Admin, alert: SignInAlertRecord): Promise<void> {
  const deletes: Array<Promise<void>> = [];
  if (alert.newDevice && alert.deviceHash) {
    deletes.push(
      forget('device', () =>
        admin
          .from('user_login_devices')
          .delete()
          .eq('user_id', alert.userId)
          .eq('device_hash', alert.deviceHash!),
      ),
    );
  }
  if (alert.newCountry && alert.country) {
    deletes.push(
      forget('country', () =>
        admin
          .from('user_sign_in_countries')
          .delete()
          .eq('user_id', alert.userId)
          .eq('country', alert.country!),
      ),
    );
  }
  await Promise.all(deletes);
}

async function forget(
  row: 'device' | 'country',
  run: () => PromiseLike<{ error: unknown }>,
): Promise<void> {
  try {
    const { error } = await run();
    if (error) reportFailure('security.sign_in_report_forget_failed', { row, code: codeOf(error) });
  } catch {
    reportFailure('security.sign_in_report_forget_failed', { row, code: null });
  }
}

interface Person {
  id: string;
  fullName: string | null;
  email: string | null;
  disabled: boolean;
}

/** The member's organizations: accepted, not act-as, at most 5. Null when unreadable (reported). */
async function organizationsOf(admin: Admin, userId: string): Promise<string[] | null> {
  try {
    const { data, error } = await admin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null)
      .order('organization_id', { ascending: true })
      .limit(MAX_ORGANIZATIONS);
    if (error || !Array.isArray(data)) {
      reportFailure('security.sign_in_report_read_failed', { read: 'organizations', code: codeOf(error) });
      return null;
    }
    return [
      ...new Set(
        (data as Array<{ organization_id?: unknown }>)
          .map((r) => text(r.organization_id))
          .filter((id): id is string => id !== null),
      ),
    ].slice(0, MAX_ORGANIZATIONS);
  } catch {
    reportFailure('security.sign_in_report_read_failed', { read: 'organizations', code: null });
    return null;
  }
}

/** The owners and admins of these organizations (accepted, not act-as), other than the member. */
async function ownersAndAdminsOf(
  admin: Admin,
  organizationIds: string[],
  memberId: string,
): Promise<Array<{ organizationId: string; userId: string }>> {
  if (organizationIds.length === 0) return [];
  try {
    const { data, error } = await admin
      .from('organization_members')
      .select('organization_id, user_id')
      // in-list-bound: the member's organizations, at most MAX_ORGANIZATIONS (5)
      .in('organization_id', organizationIds)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null);
    if (error || !Array.isArray(data)) {
      reportFailure('security.sign_in_report_read_failed', { read: 'admins', code: codeOf(error) });
      return [];
    }
    return (data as Array<{ organization_id?: unknown; user_id?: unknown }>)
      .map((r) => ({ organizationId: text(r.organization_id), userId: text(r.user_id) }))
      .filter(
        (r): r is { organizationId: string; userId: string } =>
          r.organizationId !== null && r.userId !== null && r.userId !== memberId,
      );
  } catch {
    reportFailure('security.sign_in_report_read_failed', { read: 'admins', code: null });
    return [];
  }
}

async function peopleById(admin: Admin, ids: string[]): Promise<Map<string, Person>> {
  const people = new Map<string, Person>();
  try {
    // The member and every owner and admin of up to 5 organizations: no
    // ceiling on the owners and admins, so the ids go in batches.
    const rows = await fetchAllRowsByIds<Record<string, unknown>>(ids, (batch) => (from, to) =>
      admin
        .from('user_profiles')
        .select('id, full_name, email, disabled_at')
        .in('id', batch)
        .order('id')
        .range(from, to),
    );
    for (const row of rows) {
      const id = text(row.id);
      if (!id) continue;
      people.set(id, {
        id,
        fullName: text(row.full_name)?.trim() || null,
        email: text(row.email),
        disabled: Boolean(row.disabled_at),
      });
    }
  } catch (err) {
    reportFailure('security.sign_in_report_read_failed', {
      read: 'profiles',
      code: codeOf(err) ?? null,
    });
  }
  return people;
}

async function organizationNames(admin: Admin, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  try {
    const { data, error } = await admin
      .from('organizations')
      .select('id, name')
      // in-list-bound: the member's organizations, at most MAX_ORGANIZATIONS (5)
      .in('id', ids);
    if (error || !Array.isArray(data)) {
      reportFailure('security.sign_in_report_read_failed', { read: 'organization_names', code: codeOf(error) });
      return names;
    }
    for (const row of data as Array<Record<string, unknown>>) {
      const id = text(row.id);
      const name = text(row.name);
      if (id && name) names.set(id, name);
    }
  } catch {
    reportFailure('security.sign_in_report_read_failed', { read: 'organization_names', code: null });
  }
  return names;
}

function firstNameOf(fullName: string | null): string | null {
  return fullName?.split(/\s+/)[0] || null;
}

/** Step 4: tell the member, the owners and admins, the audit log and the security events. */
async function tellEveryone(
  admin: Admin,
  alert: SignInAlertRecord,
  args: {
    signedOut: boolean;
    via: 'link' | 'signed_in';
    auditFrom: { ip: string | null; userAgent: string | null };
  },
): Promise<void> {
  const place = { country: alert.country, city: alert.city };
  const signedInAt = new Date(alert.createdAt);
  const organizations = await organizationsOf(admin, alert.userId);
  const reached = organizations ?? [];
  const told = await ownersAndAdminsOf(admin, reached, alert.userId);
  const [people, names] = await Promise.all([
    peopleById(admin, [alert.userId, ...new Set(told.map((t) => t.userId))]),
    organizationNames(admin, reached),
  ]);
  const memberPerson = people.get(alert.userId);
  const memberEmail = memberPerson?.email ?? null;
  const memberName = memberPerson?.fullName || memberEmail || 'A member';

  const work: Array<Promise<unknown>> = [];

  if (args.signedOut && memberEmail) {
    work.push(
      sendSignedOutEverywhereEmail({
        to: memberEmail,
        firstName: firstNameOf(memberPerson?.fullName ?? null),
        device: alert.deviceLabel,
        place,
        signedInAt,
      }).then((sent) => {
        if (!sent.ok) reportFailure('security.sign_in_report_email_failed', { to: 'member' });
      }),
    );
  }

  const title = `${memberName} reported a sign-in they did not make`;
  const body = `StockPilot signed them out on every device. The sign-in was from ${alert.deviceFamily}.`;
  for (const t of told) {
    work.push(
      createNotification({
        organizationId: t.organizationId,
        userId: t.userId,
        type: 'security.sign_in_reported',
        title,
        body,
        link: SIGN_IN_ALERTS_LIST_PATH,
        metadata: { alert_id: alert.id, member_id: alert.userId },
      }),
    );
  }

  // One email per person, naming the first of their organizations here.
  const emailed = new Set<string>();
  for (const t of told) {
    if (emailed.has(t.userId)) continue;
    emailed.add(t.userId);
    const person = people.get(t.userId);
    if (!person?.email || person.disabled) continue;
    work.push(
      sendSignInReportedEmail({
        to: person.email,
        adminFirstName: firstNameOf(person.fullName),
        memberName,
        memberEmail: memberEmail ?? '',
        organizationName: names.get(t.organizationId) ?? 'your organization',
        deviceFamily: alert.deviceFamily,
        place,
        signedInAt,
      }).then((sent) => {
        if (!sent.ok) reportFailure('security.sign_in_report_email_failed', { to: 'admin' });
      }),
    );
  }

  const auditTargets: Array<string | null> = reached.length > 0 ? reached : [null];
  for (const organizationId of auditTargets) {
    work.push(
      insertAuditRowReported({
        organization_id: organizationId,
        user_id: alert.userId,
        event: 'security.sign_in_reported',
        ip: args.auditFrom.ip,
        user_agent: args.auditFrom.userAgent,
        metadata: {
          entity_type: 'sign_in_alert',
          entity_id: alert.id,
          new_device: alert.newDevice,
          new_country: alert.newCountry,
          client: alert.client,
          via: args.via,
          signed_out: args.signedOut,
        },
      }),
    );
  }

  work.push(
    recordSignInAlertEvent({
      reason: 'sign_in_not_me',
      userId: alert.userId,
      source: alert.client,
      place,
    }),
  );

  await Promise.allSettled(work);
}

/**
 * The member's "This was not me" on `alert`, which the caller has already
 * checked is theirs. See the file comment for the steps. Never throws.
 */
export async function reportSignInAlertNotMe(args: {
  alert: SignInAlertRecord;
  /** Which way the member came: the emailed link, or signed in on Active sessions. */
  via: 'link' | 'signed_in';
  /**
   * Where the report came from, for the audit row only: the address as
   * clientIpForRecord read it, and the user agent.
   */
  auditFrom: { ip: string | null; userAgent: string | null };
}): Promise<SignInAlertReportAnswer> {
  const { alert } = args;
  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return { outcome: 'failed' };
  }

  const marked = await markNotMe(admin, alert);
  const signedOut = await signOutEverywhere(alert.userId);
  await forgetRows(admin, alert);

  if (marked.changed) {
    try {
      await tellEveryone(admin, alert, { signedOut, via: args.via, auditFrom: args.auditFrom });
    } catch {
      reportFailure('security.sign_in_report_tell_failed', { code: null });
    }
  }

  if (!marked.answered || !signedOut) return { outcome: 'failed' };
  return { outcome: 'done', firstReport: marked.changed };
}
