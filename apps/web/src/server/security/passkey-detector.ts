import 'server-only';

import { accountIdHash } from '@/lib/auth/passkey-bridge';
import { passkeyRelyingParty } from '@/lib/auth/passkey-relying-party';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveDefaultOrgAndRole } from '@/server/services/auth-audit';

import { recordSecurityEvent } from './events';
import { PASSKEY_RAISE_EVENT, timeNanos } from './passkey-state';

/**
 * The hourly check of sessions raised through a passkey bridge (plan 10.4,
 * integrator decision 2026-11-21), run from the audit-anomalies cron.
 *
 * The ceremony writes a `passkey.bridge_raise` audit row (session id, a raise
 * id made for that raise) BEFORE it answers a bridge, and refuses without it
 * (server/security/passkeys.ts recordRaise). So a session whose second step
 * is held by a reserved-name factor, with no raise row of that session near
 * the time of its raise, was not raised by us.
 *
 * WHAT IT DOES on such a session: an error report (the account as a hash of
 * its id) and a security event (passkey_unexplained_sign_in, outcome
 * flagged). Nothing else. There is no service-role way in this codebase to
 * end ONE session by id (revoke_my_session needs the member's own token;
 * admin_revoke_user_sessions ends every session), so no session is ended. It
 * deletes no factor and removes no passkey, ever (pinned by
 * passkey-detector.test.ts, which reads this file). No email: the security
 * family has no sentence for "found, not ended", and a message saying a
 * sign-in was ended would not be true.
 *
 * WHICH RAISE: 0475's passkey_bridge_sessions gives the session's times, not
 * the time of its raise. When a row carries `raised_at` (the time of the
 * session's TOTP claim at Auth: a proposed column, not in 0475 today) the
 * row of that raise must lie in [raised_at - 2 min, raised_at + 5 s]: a
 * second raise of the same session needs its own row. Without it, the bound
 * is the session's own life, [created_at - 2 min, updated_at + 5 s]: any
 * raise row of that session in it explains the session. That can miss a
 * second raise of a session already raised by us; it can never invent one.
 *
 * IT NEVER ACTS ON DOUBT. Each of these is "not settled", skipped and
 * reported: the passkey switch could not be read (error; never read as off);
 * the session list could not be read (error); the audit rows could not all be
 * read (error, every session of the run); a session's times cannot be read;
 * a raise in the last two minutes (our row may not be committed yet; the next
 * hourly run still sees it, the window is two hours); an account with no
 * passkey audit row at all in the two-hour window (or since its raise bound
 * began, when that is earlier): the audit stream may be unreliable for it;
 * reported with the account hashes.
 *
 * BOUNDS (like the retention route): at most MAX_SESSIONS sessions examined
 * a run, at most MAX_FINDINGS sessions flagged a run (past that the run stops
 * and one error report says a person must look: the detector is wrong or
 * there is a real wave), no new session started after RUN_BUDGET_MS. An early
 * stop is reported with the counts.
 *
 * And the other way round (10.4 a): a `passkey.used` row of the window whose
 * session is not listed is a warning with a count (the list is blind, the
 * session moved to another factor, or it simply ended).
 */

type Admin = ReturnType<typeof createAdminClient>;

const WINDOW_MS = 2 * 60 * 60_000;
/** Our row is written before the answer; an answer takes at most a few Auth calls of 8 s. */
const ROW_BEFORE_RAISE_MS = 2 * 60_000;
/** The row is committed before the answer starts: only clock jitter after. */
const ROW_AFTER_RAISE_MS = 5_000;
/** A raise this recent waits for the next run. */
const SETTLE_MS = 2 * 60_000;
export const MAX_SESSIONS = 500;
export const MAX_FINDINGS = 5;
export const RUN_BUDGET_MS = 30_000;
const AUDIT_PAGE = 1000;
const AUDIT_MAX_PAGES = 20;

const PASSKEY_EVENTS = [
  PASSKEY_RAISE_EVENT,
  'passkey.used',
  'passkey.added',
  'passkey.removed',
  'passkey.bridge_repaired',
];

const MISSING = new Set(['PGRST202', '42883', 'PGRST204', '42703']);
const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? 'none');

/** No request: the cron's own address is not the member's. */
const NO_HEADERS = { get: () => null };

interface BridgeSession {
  session_id: string;
  user_id: string;
  factor_id: string;
  recorded?: boolean | null;
  aal?: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** The time of the session's TOTP claim at Auth (proposed; absent in 0475 today). */
  raised_at?: string | null;
}

interface AuditRow {
  user_id: string | null;
  event: string;
  metadata: { session_id?: unknown } | null;
  created_at: string | null;
}

type Stop = 'session_cap' | 'finding_cap' | 'time_limit';

export interface PasskeyDetectorSummary {
  ran: boolean;
  switchOn: boolean | null;
  listed: number;
  examined: number;
  explained: number;
  unexplained: number;
  waiting: number;
  notSettled: { times: number; auditRead: number; noRows: number };
  boundBy: { raiseTime: number; sessionLife: number };
  usedButNotListed: number;
  stop: Stop | null;
}

interface Checked {
  session: BridgeSession;
  lo: bigint;
  hi: bigint;
  boundBy: 'raiseTime' | 'sessionLife';
}

const MS = 1_000_000n;
const isoOf = (nanos: bigint) => new Date(Number(nanos / MS)).toISOString();

function push(map: Map<string, bigint[]>, key: string, at: bigint) {
  const list = map.get(key);
  if (list) list.push(at);
  else map.set(key, [at]);
}

function report(tag: string, level: 'warning' | 'error', extra: Record<string, unknown>) {
  void reportError(new Error(`Passkeys: ${tag}`), { tag: `passkeys.${tag}`, level, extra });
}

/**
 * The security event of an unexplained bridge session (the part 1 recorder):
 * category password_guessing (a code answered that our server did not send),
 * outcome flagged (found after the fact; nothing was blocked).
 */
export async function recordUnexplainedBridgeSession(userId: string): Promise<void> {
  const { organizationId } = await resolveDefaultOrgAndRole(userId);
  await recordSecurityEvent(
    {
      category: 'password_guessing',
      outcome: 'flagged',
      reason: 'passkey_unexplained_sign_in',
      source: 'web',
      organizationId,
    },
    NO_HEADERS,
  );
}

/** Never throws; changes nothing but reports and security events. */
export async function runPasskeyDetector(): Promise<PasskeyDetectorSummary> {
  const started = Date.now();
  const summary: PasskeyDetectorSummary = {
    ran: false,
    switchOn: null,
    listed: 0,
    examined: 0,
    explained: 0,
    unexplained: 0,
    waiting: 0,
    notSettled: { times: 0, auditRead: 0, noRows: 0 },
    boundBy: { raiseTime: 0, sessionLife: 0 },
    usedButNotListed: 0,
    stop: null,
  };
  try {
    if (!passkeyRelyingParty()) return summary;
    const admin = createAdminClient();

    // The switch: read, never assumed. A failed read settles nothing.
    const settings = await admin
      .from('platform_settings')
      .select('passkeys_on')
      .limit(1)
      .maybeSingle();
    if (settings.error) {
      if (MISSING.has(codeOf(settings.error))) return summary;
      report('detector_settings_unreadable', 'error', { code: codeOf(settings.error) });
      return summary;
    }
    const on = (settings.data as { passkeys_on?: unknown } | null)?.passkeys_on;
    if (typeof on !== 'boolean') {
      report('detector_settings_unreadable', 'error', { code: 'no_value' });
      return summary;
    }
    summary.switchOn = on;

    const nowNs = BigInt(Date.now()) * MS;
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const listed = await admin.rpc('passkey_bridge_sessions', { p_since: since });
    if (listed.error) {
      if (MISSING.has(codeOf(listed.error))) return summary;
      report('detector_unreadable', 'error', { code: codeOf(listed.error) });
      return summary;
    }
    summary.ran = true;
    const all = (Array.isArray(listed.data) ? listed.data : []) as BridgeSession[];
    summary.listed = all.length;
    let sessions = all;
    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(0, MAX_SESSIONS);
      summary.stop = 'session_cap';
    }

    // Each session's bound, or why it is not settled.
    const checked: Checked[] = [];
    const settledBefore = nowNs - BigInt(SETTLE_MS) * MS;
    for (const s of sessions) {
      const hasRaiseTime = Object.prototype.hasOwnProperty.call(s, 'raised_at');
      const raised = hasRaiseTime ? timeNanos(s.raised_at) : null;
      const created = timeNanos(s.created_at);
      const updated = timeNanos(s.updated_at ?? s.created_at);
      if ((hasRaiseTime && raised === null) || created === null || updated === null) {
        summary.notSettled.times += 1;
        continue;
      }
      const anchor = raised ?? updated;
      if (anchor > settledBefore) {
        summary.waiting += 1;
        continue;
      }
      const boundBy = raised !== null ? 'raiseTime' : 'sessionLife';
      checked.push({
        session: s,
        lo: (raised ?? created) - BigInt(ROW_BEFORE_RAISE_MS) * MS,
        hi: (raised ?? updated) + BigInt(ROW_AFTER_RAISE_MS) * MS,
        boundBy,
      });
    }

    // Our passkey rows since the earliest bound (or the window), every page.
    const windowStart = timeNanos(since)!;
    let from = windowStart;
    for (const c of checked) if (c.lo < from) from = c.lo;
    const rows = await readPasskeyRows(admin, isoOf(from));
    if (rows === null) {
      summary.notSettled.auditRead += checked.length;
      report('detector_audit_unreadable', 'error', { sessions: checked.length });
    } else {
      const raisesBySession = new Map<string, bigint[]>();
      const rowsByAccount = new Map<string, bigint[]>();
      for (const r of rows) {
        const at = timeNanos(r.created_at);
        if (at === null) continue;
        if (r.user_id) push(rowsByAccount, r.user_id, at);
        const sid = r.metadata?.session_id;
        if (r.event === PASSKEY_RAISE_EVENT && typeof sid === 'string')
          push(raisesBySession, sid, at);
      }
      const noRowsAccounts: string[] = [];
      for (const c of checked) {
        if (Date.now() - started >= RUN_BUDGET_MS) {
          summary.stop = 'time_limit';
          break;
        }
        summary.examined += 1;
        const raises = raisesBySession.get(c.session.session_id) ?? [];
        if (raises.some((at) => at >= c.lo && at <= c.hi)) {
          summary.explained += 1;
          continue;
        }
        // The audit stream must be seen working for this account: some
        // passkey row of it in the window (or since the bound, if earlier).
        const accountRows = rowsByAccount.get(c.session.user_id) ?? [];
        const seenFrom = c.lo < windowStart ? c.lo : windowStart;
        if (!accountRows.some((at) => at >= seenFrom && at <= nowNs)) {
          summary.notSettled.noRows += 1;
          if (noRowsAccounts.length < 10) noRowsAccounts.push(accountIdHash(c.session.user_id));
          continue;
        }
        if (summary.unexplained >= MAX_FINDINGS) {
          summary.stop = 'finding_cap';
          break;
        }
        summary.unexplained += 1;
        summary.boundBy[c.boundBy] += 1;
        report('bridge_session_unexplained', 'error', {
          userIdHash: accountIdHash(c.session.user_id),
          recorded: c.session.recorded === true,
          boundBy: c.boundBy,
        });
        await recordUnexplainedBridgeSession(c.session.user_id);
      }
      if (summary.notSettled.noRows > 0) {
        report('detector_no_passkey_rows', 'warning', {
          count: summary.notSettled.noRows,
          accounts: noRowsAccounts,
        });
      }

      // The other way round: our passkey.used rows whose session is not listed.
      const listedIds = new Set(all.map((s) => s.session_id));
      summary.usedButNotListed = rows.filter((r) => {
        const at = timeNanos(r.created_at);
        const sid = r.metadata?.session_id;
        return (
          r.event === 'passkey.used' &&
          at !== null &&
          at >= windowStart &&
          at <= settledBefore &&
          typeof sid === 'string' &&
          !listedIds.has(sid)
        );
      }).length;
      if (summary.usedButNotListed > 0) {
        report('detector_used_not_listed', 'warning', { count: summary.usedButNotListed });
      }
    }

    if (summary.notSettled.times > 0) {
      report('detector_times_unreadable', 'warning', { count: summary.notSettled.times });
    }
    if (summary.stop !== null) {
      report('detector_stopped', summary.stop === 'finding_cap' ? 'error' : 'warning', {
        stop: summary.stop,
        listed: summary.listed,
        examined: summary.examined,
        unexplained: summary.unexplained,
      });
    }
  } catch (e) {
    report('detector_failed', 'error', { name: e instanceof Error ? e.name : 'unknown' });
  }
  console.info('[passkeys.detector]', JSON.stringify(summary));
  return summary;
}

/** Every passkey audit row since `fromIso`, or null when any page cannot be read (or there are too many). */
async function readPasskeyRows(admin: Admin, fromIso: string): Promise<AuditRow[] | null> {
  const out: AuditRow[] = [];
  for (let page = 0; page < AUDIT_MAX_PAGES; page += 1) {
    const { data, error } = await admin
      .from('audit_logs')
      .select('user_id, event, metadata, created_at')
      .in('event', PASSKEY_EVENTS)
      .gte('created_at', fromIso)
      .order('id', { ascending: true })
      .range(page * AUDIT_PAGE, page * AUDIT_PAGE + AUDIT_PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as AuditRow[];
    out.push(...rows);
    if (rows.length < AUDIT_PAGE) return out;
  }
  return null;
}
