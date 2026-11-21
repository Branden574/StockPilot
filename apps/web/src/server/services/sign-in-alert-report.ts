import 'server-only';

import {
  NOT_ME_WORDS,
  SIGN_IN_REPORTED_TITLE,
  reportedMemberName,
} from '@/lib/auth/sign-in-alert-words';
import {
  SIGN_IN_ALERTS_LIST_PATH,
  sendSignedOutEverywhereEmail,
  sendSignInReportedEmail,
} from '@/lib/email/login-alert';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { recordSignInAlertEvent } from '@/server/security/sign-in-alert-events';
import { insertAuditRowReported } from '@/server/services/audit';
import { fetchAllRowsByIds, reportDegradedRead } from '@/server/services/lib/fetch-by-ids';
import { createNotification } from '@/server/services/notifications';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';

/**
 * A member's "This was not me" on a sign-in alert (part 3 of the security
 * tools). One function for both ways in: the signed link in the alert email
 * (app/sign-in-alert/route.ts) and the button on Active sessions
 * (server/actions/sign-in-alerts.ts). Each caller has already decided the
 * alert is the member's own; this only acts on it.
 *
 * ONE ALERT, ONE SIGN-OUT. THE STEPS, in order (review 1, finding 2):
 *   0. An alert that is ALREADY not_me when the call starts answers
 *      'already_reported' and does nothing: no session is ended again and
 *      nobody is told again. Step (a) always runs before step (b), so a
 *      marked alert means its sign-out already worked, and nothing is lost by
 *      returning here. Without this, the link in an email would let whoever
 *      holds that email end the account's sessions again and again for the
 *      link's seven days. If whoever signed in comes back, step (c) has
 *      forgotten the device and country rows, so that sign-in raises a NEW
 *      alert with a link of its own; and the pages push the password reset,
 *      which ends every session again.
 *   a. Every session of the account ends (revokeAllSessionsForUser). If it
 *      fails the answer is 'failed': nothing is marked and nobody is told,
 *      so the member's next press is a full first report and no sentence
 *      anywhere says a sign-out happened that did not.
 *   b. The alert is marked not_me, with its resolved_at, in ONE update that
 *      changes only an alert not already not_me (the table requires the two
 *      together). "This was me" earlier does not stop it. An update that
 *      fails is 'failed' (the sessions have ended; the retry runs everything
 *      again). An update that changes no row means a press at the same
 *      moment got there first: 'already_reported', and that press does the
 *      telling. (This one's sign-out ran too; two at once is the only way.)
 *   c. Only when (b) changed the row, so each of these happens once per alert:
 *        - the device row of the alert is forgotten (by its hash) only when
 *          the alert was about a new device, and the country row only when it
 *          was about a new country, so the next sign-in from either alerts
 *          again;
 *        - the owners and admins of each organization the member belongs to
 *          (an accepted membership that is not a support act-as seat, at most
 *          5 organizations) get an in-app notice in each organization and one
 *          email each, naming the device FAMILY, never the member's own label.
 *          Managers and staff are never told, and a member who is an admin is
 *          not told a second time as one; a disabled account gets no email
 *          (createNotification skips it too);
 *        - the member is emailed that every session ended, with the reset
 *          button;
 *        - one audit row per organization (security.sign_in_reported), or one
 *          with no organization when there is none or they could not be read;
 *        - one security event (phishing / flagged / sign_in_not_me), with the
 *          sign-in's place, not the reader's.
 *
 * THE EMAILS GO ONE AFTER ANOTHER (finding 3): the member's first, then each
 * owner and admin, so several recipients never meet the mail provider's
 * requests-per-second limit together (each send tries once more after a
 * refusal for rate, lib/email/login-alert.ts). Emails that were not sent are
 * reported ONCE, with how many, never an address.
 *
 * THE MEMBER'S NAME NEVER LEADS (finding 7). The member chooses it, and these
 * messages reach other people from the security sender. A notice's title (the
 * phone push's too) and the email's subject are fixed words; the name is in
 * the body only, cut and cleaned (reportedMemberName), next to the member's
 * sign-in address, which the member cannot edit.
 *
 * "THE OWNERS AND ADMINS WERE TOLD" IS SAID ONLY WHEN ONE WAS (finding 8).
 * The answer carries adminsTold: at least one in-app notice was made or one
 * email was sent. The member's email is sent before the admins' emails, so it
 * goes by the notices alone. A sole owner, an account in no organization and
 * a failed read all answer false, and the words then say nothing about it.
 *
 * (a) and (b) decide the answer. Everything in (c) is best effort; a failure
 * is reported with a code, a count or a fixed word only (never an address or
 * a name), and never changes the answer. Never throws.
 *
 * NOT COVERED: a function that stops between (b) and (c) has marked the alert
 * and told nobody, and the retry is 'already_reported'. It is rare, the
 * sessions have ended, and the member still sees the reset button.
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
  /** This press was the report. `adminsTold`: at least one owner or admin was told. */
  | { outcome: 'done'; adminsTold: boolean }
  /**
   * The alert was reported before (or by a press at the same moment). Its
   * sessions were ended when it was reported; this call ended nothing more
   * and told nobody.
   */
  | { outcome: 'already_reported' }
  /** The sessions could not be ended, or the alert could not be marked: press again. */
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

function reportFailure(tag: string, extra: Record<string, string | number | null>): void {
  void reportError(new Error('A sign-in alert report step failed'), {
    tag,
    level: 'warning',
    extra,
  });
}

/** Step (b). Whether the update answered, and whether it changed the row. */
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

/** Step (a). Never throws; revokeAllSessionsForUser reports its own failure. */
async function signOutEverywhere(userId: string): Promise<boolean> {
  try {
    return (await revokeAllSessionsForUser(userId)).ok;
  } catch {
    return false;
  }
}

/** Step (c), first: the rows that made this sign-in "known", so the next one alerts again. */
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
    // ceiling on the owners and admins, so the ids go in batches. Each id
    // names one profile, so the rows are bounded by the ids. A page that is
    // not a list is a failed read (requireList), never "no more rows": an
    // answer cut short must not tell some owners as if they were all of them.
    const rows = await fetchAllRowsByIds<Record<string, unknown>>(
      ids,
      (batch) => (from, to) =>
        admin
          .from('user_profiles')
          .select('id, full_name, email, disabled_at')
          .in('id', batch)
          .order('id')
          .range(from, to),
      { requireList: 'user_profiles' },
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
    // Nobody is emailed from a partial list: the map stays empty. The raw
    // text (a ServiceError's internal detail) goes to the server report only,
    // through the house helper for a failed id-list read.
    reportDegradedRead('security.sign_in_report_read_failed', err, { read: 'profiles' });
    return new Map<string, Person>();
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

/** One email's answer: sent or not. A send that throws was not sent. Never throws. */
async function wasSent(send: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await send()).ok === true;
  } catch {
    return false;
  }
}

/** What the owners and admins read in the app (and on a phone's lock screen) under the fixed title. */
function noticeBody(who: string, deviceFamily: string): string {
  return `${who} said a sign-in from ${deviceFamily} was not them. ${NOT_ME_WORDS.theirSessionsEnded} ${NOT_ME_WORDS.openDevice} ${NOT_ME_WORDS.askThemToReset}`;
}

/**
 * Step (c), the telling: the owners and admins, the member, the audit log and
 * the security events. Answers whether at least one owner or admin was told.
 */
async function tellEveryone(
  admin: Admin,
  alert: SignInAlertRecord,
  args: {
    via: 'link' | 'signed_in';
    auditFrom: { ip: string | null; userAgent: string | null };
  },
): Promise<boolean> {
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
  // The member's own name, for a BODY only: cut and cleaned, and always next
  // to the sign-in address when there is one.
  const memberName = reportedMemberName(memberPerson?.fullName);
  const who =
    memberName && memberEmail ? `${memberName} (${memberEmail})` : (memberName ?? memberEmail ?? 'A member');

  // The audit rows and the security event wait on nothing here; they are
  // started now and collected at the end. Each is started inside its own
  // async step, so one that throws on the spot is one that failed, and stops
  // none of the others.
  const records: Array<Promise<unknown>> = [];
  const auditTargets: Array<string | null> = reached.length > 0 ? reached : [null];
  for (const organizationId of auditTargets) {
    records.push(
      (async () =>
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
            // Always true since the sign-out comes first; kept so the rows
            // read as they did.
            signed_out: true,
          },
        }))(),
    );
  }
  records.push(
    (async () =>
      recordSignInAlertEvent({
        reason: 'sign_in_not_me',
        userId: alert.userId,
        source: alert.client,
        place,
      }))(),
  );
  const recorded = Promise.allSettled(records);

  // The in-app notices first: they are quick, and the member's email below
  // says "the owners and admins were told" only when one was made.
  const body = noticeBody(who, alert.deviceFamily);
  const notices = await Promise.allSettled(
    told.map(async (t) =>
      createNotification({
        organizationId: t.organizationId,
        userId: t.userId,
        type: 'security.sign_in_reported',
        title: SIGN_IN_REPORTED_TITLE,
        body,
        link: SIGN_IN_ALERTS_LIST_PATH,
        metadata: { alert_id: alert.id, member_id: alert.userId },
      }),
    ),
  );
  const noticed = notices.some((n) => n.status === 'fulfilled' && typeof n.value === 'string');

  // The emails, one after another: the member's, then one per owner or admin
  // (naming the first of their organizations here).
  let memberNotSent = 0;
  if (memberEmail) {
    const sent = await wasSent(() =>
      sendSignedOutEverywhereEmail({
        to: memberEmail,
        firstName: firstNameOf(memberPerson?.fullName ?? null),
        device: alert.deviceLabel,
        place,
        signedInAt,
        adminsTold: noticed,
      }),
    );
    if (!sent) memberNotSent = 1;
  }

  const recipients: Array<{ person: Person & { email: string }; organizationId: string }> = [];
  const seen = new Set<string>();
  for (const t of told) {
    if (seen.has(t.userId)) continue;
    seen.add(t.userId);
    const person = people.get(t.userId);
    if (!person?.email || person.disabled) continue;
    recipients.push({ person: { ...person, email: person.email }, organizationId: t.organizationId });
  }
  let adminsSent = 0;
  for (const { person, organizationId } of recipients) {
    const sent = await wasSent(() =>
      sendSignInReportedEmail({
        to: person.email,
        adminFirstName: firstNameOf(person.fullName),
        memberName,
        memberEmail: memberEmail ?? '',
        organizationName: names.get(organizationId) ?? 'your organization',
        deviceFamily: alert.deviceFamily,
        place,
        signedInAt,
      }),
    );
    if (sent) adminsSent += 1;
  }
  const adminsNotSent = recipients.length - adminsSent;
  if (memberNotSent + adminsNotSent > 0) {
    // Once, with how many: never an address.
    reportFailure('security.sign_in_report_email_failed', {
      member_not_sent: memberNotSent,
      admins_not_sent: adminsNotSent,
      admins: recipients.length,
    });
  }

  await recorded;
  return noticed || adminsSent > 0;
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
  // One alert, one sign-out: a reported alert ends nothing again.
  if (alert.status === 'not_me') return { outcome: 'already_reported' };

  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return { outcome: 'failed' };
  }

  // (a) The sign-out first. Nothing below runs unless it worked.
  if (!(await signOutEverywhere(alert.userId))) return { outcome: 'failed' };

  // (b) The mark. Only the press that changes the row goes on.
  const marked = await markNotMe(admin, alert);
  if (!marked.answered) return { outcome: 'failed' };
  if (!marked.changed) return { outcome: 'already_reported' };

  // (c) Once per alert.
  await forgetRows(admin, alert);
  let adminsTold = false;
  try {
    adminsTold = await tellEveryone(admin, alert, { via: args.via, auditFrom: args.auditFrom });
  } catch {
    reportFailure('security.sign_in_report_tell_failed', { code: null });
  }
  return { outcome: 'done', adminsTold };
}
