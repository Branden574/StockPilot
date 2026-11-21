import 'server-only';

import { accountIdHash } from '@/lib/auth/passkey-bridge';
import { passkeyRelyingParty } from '@/lib/auth/passkey-relying-party';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { insertAuditRowReported } from '@/server/services/audit';
import { resolveDefaultOrgAndRole } from '@/server/services/auth-audit';
import { broadcastEndedSessions } from '@/server/services/sessions';

import { recordSecurityEvent } from './events';
import { sendPasskeySignInEndedEmail } from './passkey-emails';
import { PASSKEY_RAISE_EVENT, timeNanos } from './passkey-state';

/**
 * The hourly check of sessions raised through a passkey bridge (plan 10.4,
 * the integrator's decisions of 2026-11-21), run from the audit-anomalies
 * cron.
 *
 * THE RULE. A session whose second step is held by a factor with the
 * reserved bridge name is explained only by our own `passkey.bridge_raise`
 * audit row of that session near the time of its raise. The ceremony writes
 * that row BEFORE it answers a bridge and refuses without it
 * (server/security/passkeys.ts recordRaise), so every raise of ours has one.
 * Every raise without one is unexplained, whatever else the account did: an
 * error report (the account as a hash of its id) and a security event
 * (passkey_unexplained_sign_in, outcome flagged).
 *
 * ENDING IS A SETTING: platform_settings.passkey_check_ends_sessions (0475;
 * default false). While it is true, an unexplained raise's session (that one
 * session) is ended through passkey_end_bridge_session, which ends only a
 * session whose second step is held now by the account's recorded bridge
 * (any other is refused, 22023, and the refusal is reported); the account's
 * devices learn through the sessions broadcast, and the account gets at most
 * one email a day (the security family: a sign-in was ended, reset your
 * password). Otherwise the finding is reported and recorded, and nothing is
 * ended. The report and the email say "ended" only when the database
 * answered that it ended the session. It deletes no factor and removes no
 * passkey, ever (pinned by passkey-detector.test.ts, which reads this file):
 * the bridge factor stays, so the member's own passkey keeps working.
 *
 * WHICH RAISE: passkey_bridge_sessions gives each session's raised_at, the
 * time of its TOTP method row at Auth (auth.mfa_amr_claims, upserted with
 * Auth's clock on every TOTP answer; read from the Auth source, not measured
 * for a bridge raise). The row of that raise must lie in [raised_at - 2 min,
 * raised_at + AUTH_DB_CLOCK_SKEW_MS]: a second raise of the same session
 * needs its own row. Every run logs the spread of (row time - raise time)
 * over the raises it explained, and each unexplained raise is reported with
 * its nearest raise row, so the two clocks can be compared.
 *
 * WHAT IS READ, AND WHAT CANNOT BE: the settings, the session list, the audit
 * rows and each session's raise time. One that cannot be read is reported at
 * error level and settles nothing it would have decided. A missing settings
 * row is read as the database reads it (passkeys off, ending off) and said
 * once a day. A raise of the last two minutes is examined by the next run
 * (our row may not be committed yet; the window is two hours). It reads the
 * sessions that exist at the hour: a session signed out before the hourly
 * run is never seen.
 *
 * MEMORY: each finding is remembered by an audit row of its own
 * (`passkey.raise_flagged`: the session id and the raise time), read with
 * the other passkey rows, in the same bounds. A raise already reported is
 * not reported, counted, recorded or ended again, so standing findings never
 * fill a run.
 *
 * BOUNDS (like the retention route): at most MAX_SESSIONS sessions examined
 * a run, the newest raises first; at most MAX_FINDINGS new findings (and so,
 * with ending on, at most MAX_FINDINGS sessions ended) a run, past which the
 * run stops and one error report says a person must look (the check is wrong
 * or there is a real wave); no new session started after RUN_BUDGET_MS. An
 * early stop is reported with the counts.
 *
 * And the other way round (10.4 a): a `passkey.used` row of the window whose
 * session is not listed is a warning with a count (the list is blind, the
 * session moved to another factor, or it simply ended).
 */

type Admin = ReturnType<typeof createAdminClient>;

const WINDOW_MS = 2 * 60 * 60_000;
/** Our row is written before the answer; an answer takes at most a few Auth calls of 8 s. */
const ROW_BEFORE_RAISE_MS = 2 * 60_000;
/**
 * The clock skew allowed between Auth (raised_at is Auth's clock) and the
 * database (the raise row's created_at is the database's now()). Our row is
 * committed before the answer starts, so with equal clocks it is always
 * before raised_at; it may read as later only by the skew. Beyond it (Auth's
 * clock more than this behind the database's), an honest raise's own row
 * reads as after the raise, so the raise is reported as unexplained, and with
 * ending on, that honest session would be ended. That is why ending starts
 * off: compare the reported spread first.
 */
export const AUTH_DB_CLOCK_SKEW_MS = 5_000;
/** A raise this recent waits for the next run. */
const SETTLE_MS = 2 * 60_000;
export const MAX_SESSIONS = 500;
/** Sessions flagged a run, and so sessions ended a run (decision C: at most 5). */
export const MAX_FINDINGS = 5;
export const RUN_BUDGET_MS = 30_000;
/** One email a day per account at most; a missing settings row is said once a day. */
const DAY_MS = 24 * 60 * 60_000;
const AUDIT_PAGE = 1000;
const AUDIT_MAX_PAGES = 20;

/** The detector's memory of a finding: the session id and the raise time. */
const FLAGGED_EVENT = 'passkey.raise_flagged';

const PASSKEY_EVENTS = [
  PASSKEY_RAISE_EVENT,
  FLAGGED_EVENT,
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
  /** The time of the session's TOTP method row at Auth (0475, stage 1 additions). */
  raised_at?: string | null;
}

interface AuditRow {
  user_id: string | null;
  event: string;
  metadata: { session_id?: unknown; raised_at?: unknown } | null;
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
  /** Raises already reported by an earlier run (the memory): not counted again. */
  alreadyReported: number;
  /** What could not be read (review 4 finding 2: never a raise with no row). */
  notSettled: { times: number; auditRead: number };
  /** Whether an unexplained raise is ended (platform_settings.passkey_check_ends_sessions). */
  mode: 'report_only' | 'end' | null;
  /** What became of the unexplained sessions (decision C; report only by default, A7). */
  ending: {
    ended: number;
    alreadyGone: number;
    refused: number;
    failed: number;
    reportOnly: number;
  };
  emailed: number;
  /** The two clocks compared: (raise row time - raised_at) over the explained raises. */
  rowMinusRaiseMs: { min: number | null; max: number | null };
  usedButNotListed: number;
  stop: Stop | null;
}

interface Checked {
  session: BridgeSession;
  lo: bigint;
  hi: bigint;
  raised: bigint;
}

type Ending = 'ended' | 'already_gone' | 'refused' | 'failed' | 'report_only';

const MS = 1_000_000n;
const isoOf = (nanos: bigint) => new Date(Number(nanos / MS)).toISOString();
/** Row time minus raise time, in whole milliseconds (negative: the row came first). */
const offsetMs = (at: bigint, raised: bigint) => Number((at - raised) / MS);
/** The time in `list` nearest to `to`, or null for an empty list. */
function nearest(list: bigint[], to: bigint): bigint | null {
  let best: bigint | null = null;
  for (const at of list) {
    const d = at > to ? at - to : to - at;
    if (best === null || d < (best > to ? best - to : to - best)) best = at;
  }
  return best;
}

function push(map: Map<string, bigint[]>, key: string, at: bigint) {
  const list = map.get(key);
  if (list) list.push(at);
  else map.set(key, [at]);
}

type ReportExtra = Record<string, string | number | boolean | null | undefined>;

function report(tag: string, level: 'warning' | 'error', extra: ReportExtra) {
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

/**
 * Ends ONE session raised through a recorded bridge (0475's
 * passkey_end_bridge_session refuses any other, 22023: report only) and
 * tells the account's devices. 'ended' only when the database said true.
 */
async function endBridgeSession(admin: Admin, s: BridgeSession): Promise<Ending> {
  try {
    const { data, error } = await admin.rpc('passkey_end_bridge_session', {
      p_session_id: s.session_id,
    });
    if (error) return codeOf(error) === '22023' ? 'refused' : 'failed';
    if (data !== true) return 'already_gone';
  } catch {
    return 'failed';
  }
  try {
    await broadcastEndedSessions(s.user_id, [s.session_id], '');
  } catch {
    // The refresh token is gone either way; the access token lasts until it expires.
    report('detector_broadcast_failed', 'warning', { userIdHash: accountIdHash(s.user_id) });
  }
  return 'ended';
}

/** At most one email a day per account; true when one was sent. Closed when the pace cannot be counted. */
async function emailOnceADay(admin: Admin, userId: string): Promise<boolean> {
  try {
    const paced = await checkRateLimit(
      `passkey-detector-email:${userId}`,
      1,
      DAY_MS,
      'closed',
    );
    if (!paced.allowed) return false;
    const { data, error } = await admin.auth.admin.getUserById(userId);
    const to = data?.user?.email;
    if (error || typeof to !== 'string' || !to) {
      report('detector_email_no_address', 'warning', { userIdHash: accountIdHash(userId) });
      return false;
    }
    sendPasskeySignInEndedEmail(to);
    return true;
  } catch {
    report('detector_email_failed', 'warning', { userIdHash: accountIdHash(userId) });
    return false;
  }
}

/** A warning at most once a day, for everyone (closed: a pace that cannot be counted says nothing). */
async function reportOnceADay(tag: string, extra: ReportExtra): Promise<void> {
  try {
    const paced = await checkRateLimit('passkey-detector-settings-report:all', 1, DAY_MS, 'closed');
    if (paced.allowed) report(tag, 'warning', extra);
  } catch {
    // A report never stops the run.
  }
}

/** The memory of a finding (review 4 finding 9): an audit row of its own, no organization, no address. */
async function rememberFinding(s: BridgeSession, ending: Ending): Promise<void> {
  const written = await insertAuditRowReported({
    organization_id: null,
    user_id: s.user_id,
    event: FLAGGED_EVENT,
    ip: null,
    user_agent: null,
    metadata: {
      entity_type: 'user',
      entity_id: s.user_id,
      session_id: s.session_id,
      raised_at: s.raised_at ?? null,
      ending,
    },
  });
  if (!written) report('detector_memory_unwritten', 'warning', { userIdHash: accountIdHash(s.user_id) });
}

const memoryKey = (sessionId: string, raised: bigint) => `${sessionId}|${raised}`;

/**
 * Never throws. Changes nothing but reports, security events, its own memory
 * rows, and, only with
 * ending on, the ending of an unexplained bridge-raised session (at most
 * MAX_FINDINGS a run) and its email.
 */
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
    alreadyReported: 0,
    notSettled: { times: 0, auditRead: 0 },
    mode: null,
    ending: { ended: 0, alreadyGone: 0, refused: 0, failed: 0, reportOnly: 0 },
    emailed: 0,
    rowMinusRaiseMs: { min: null, max: null },
    usedButNotListed: 0,
    stop: null,
  };
  try {
    if (!passkeyRelyingParty()) return summary;
    const admin = createAdminClient();

    // The switch and the ending setting: read, never assumed. A failed read
    // settles nothing; no row is what the database reads as off.
    const settings = await admin
      .from('platform_settings')
      .select('passkeys_on, passkey_check_ends_sessions')
      .limit(1)
      .maybeSingle();
    if (settings.error) {
      if (MISSING.has(codeOf(settings.error))) return summary;
      report('detector_settings_unreadable', 'error', { code: codeOf(settings.error) });
      return summary;
    }
    const row = settings.data as {
      passkeys_on?: unknown;
      passkey_check_ends_sessions?: unknown;
    } | null;
    // Review 4 finding 7: no row at all (stage 6 writes it) is the database's
    // own reading, coalesce(..., false): passkeys off, ending off. Said once
    // a day, never an hourly error; the run goes on.
    if (row === null) await reportOnceADay('detector_settings_missing', {});
    const on = row === null ? false : row.passkeys_on;
    if (typeof on !== 'boolean') {
      report('detector_settings_unreadable', 'error', { code: 'no_value' });
      return summary;
    }
    summary.switchOn = on;
    // Ending is on only for a stored true; anything else is report only.
    const ends = row === null ? false : row.passkey_check_ends_sessions;
    if (typeof ends !== 'boolean') {
      report('detector_end_setting_unreadable', 'warning', {
        type: ends === null ? 'null' : typeof ends,
      });
    }
    summary.mode = ends === true ? 'end' : 'report_only';

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
    // The newest raises first (review 4 finding 9), so the cap never drops a
    // fresh raise; a raise time that cannot be read sorts last.
    const raisedOf = new Map(all.map((s) => [s, timeNanos(s.raised_at)]));
    let sessions = [...all].sort((a, b) => {
      const ta = raisedOf.get(a) ?? null;
      const tb = raisedOf.get(b) ?? null;
      if (ta === tb) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta > tb ? -1 : 1;
    });
    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(0, MAX_SESSIONS);
      summary.stop = 'session_cap';
    }

    // Each session's bound, or why it is not settled.
    const checked: Checked[] = [];
    const settledBefore = nowNs - BigInt(SETTLE_MS) * MS;
    const noTimeAccounts: string[] = [];
    for (const s of sessions) {
      // The raise this check is about: its time at Auth, or not settled.
      const raised = timeNanos(s.raised_at);
      if (raised === null) {
        summary.notSettled.times += 1;
        if (noTimeAccounts.length < 10) noTimeAccounts.push(accountIdHash(s.user_id));
        continue;
      }
      if (raised > settledBefore) {
        summary.waiting += 1;
        continue;
      }
      checked.push({
        session: s,
        lo: raised - BigInt(ROW_BEFORE_RAISE_MS) * MS,
        hi: raised + BigInt(AUTH_DB_CLOCK_SKEW_MS) * MS,
        raised,
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
      const remembered = new Set<string>();
      for (const r of rows) {
        const sid = r.metadata?.session_id;
        if (typeof sid !== 'string') continue;
        if (r.event === FLAGGED_EVENT) {
          const raised = timeNanos(
            typeof r.metadata?.raised_at === 'string' ? r.metadata.raised_at : null,
          );
          if (raised !== null) remembered.add(memoryKey(sid, raised));
          continue;
        }
        const at = timeNanos(r.created_at);
        if (at !== null && r.event === PASSKEY_RAISE_EVENT) push(raisesBySession, sid, at);
      }
      for (const c of checked) {
        if (Date.now() - started >= RUN_BUDGET_MS) {
          summary.stop = 'time_limit';
          break;
        }
        summary.examined += 1;
        const raises = raisesBySession.get(c.session.session_id) ?? [];
        const inBound = raises.filter((at) => at >= c.lo && at <= c.hi);
        if (inBound.length > 0) {
          summary.explained += 1;
          const offset = offsetMs(nearest(inBound, c.raised)!, c.raised);
          const spread = summary.rowMinusRaiseMs;
          if (spread.min === null || offset < spread.min) spread.min = offset;
          if (spread.max === null || offset > spread.max) spread.max = offset;
          continue;
        }
        // The rule (review 4 finding 2): no raise row of ours near the raise
        // is unexplained, whatever else the account did. Review 4 finding 9:
        // a raise reported by an earlier run is not counted again.
        if (remembered.has(memoryKey(c.session.session_id, c.raised))) {
          summary.alreadyReported += 1;
          continue;
        }
        if (summary.unexplained >= MAX_FINDINGS) {
          summary.stop = 'finding_cap';
          break;
        }
        summary.unexplained += 1;
        const ending: Ending =
          summary.mode === 'end' ? await endBridgeSession(admin, c.session) : 'report_only';
        if (ending === 'ended') summary.ending.ended += 1;
        else if (ending === 'already_gone') summary.ending.alreadyGone += 1;
        else if (ending === 'refused') summary.ending.refused += 1;
        else if (ending === 'report_only') summary.ending.reportOnly += 1;
        else summary.ending.failed += 1;
        const near = nearest(raises, c.raised);
        report('bridge_session_unexplained', 'error', {
          userIdHash: accountIdHash(c.session.user_id),
          recorded: c.session.recorded === true,
          ending,
          ended: ending === 'ended',
          nearestRaiseRowMs: near === null ? null : offsetMs(near, c.raised),
        });
        await recordUnexplainedBridgeSession(c.session.user_id);
        await rememberFinding(c.session, ending);
        if (ending === 'ended' && (await emailOnceADay(admin, c.session.user_id))) {
          summary.emailed += 1;
        }
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
      // The list should always carry the raise time (0475): its absence is an
      // error, and such a session is never ended.
      report('detector_times_unreadable', 'error', {
        count: summary.notSettled.times,
        accounts: noTimeAccounts.join(','),
      });
    }
    if (summary.stop !== null) {
      report('detector_stopped', summary.stop === 'finding_cap' ? 'error' : 'warning', {
        stop: summary.stop,
        mode: summary.mode,
        listed: summary.listed,
        examined: summary.examined,
        unexplained: summary.unexplained,
        ended: summary.ending.ended,
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
