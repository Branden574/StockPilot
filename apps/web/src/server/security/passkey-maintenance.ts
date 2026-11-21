import 'server-only';

import { accountIdHash } from '@/lib/auth/passkey-bridge';
import { passkeyRelyingParty } from '@/lib/auth/passkey-relying-party';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';

import { compareTimes } from './passkey-state';

/**
 * The scheduled passkey work (plan 10.3 and 10.4), run from two crons that
 * already exist (no new Vercel setting): the daily security-events retention
 * job runs runPasskeyMaintenance (the purge, the sweep, the counts, the Auth
 * version check), the hourly audit-anomalies job runs runPasskeyDetector.
 * Each never throws and never changes its cron's own answer: a failure is
 * reported (counts and codes only, an account as a hash of its id).
 *
 * Neither is gated by the switches: they find and close what is unsafe,
 * and the S7/S13 repairs (finishing a removal the member started) run while
 * the kill switch is off (answer B). Without a site (a preview) they do
 * nothing. Before 0475 exists every call answers "missing" and is skipped.
 */

type Admin = ReturnType<typeof createAdminClient>;

const MISSING = new Set(['PGRST202', '42883', 'PGRST205', '42P01']);
const missing = (error: unknown) =>
  MISSING.has(String((error as { code?: unknown } | null)?.code ?? ''));

/** Auth versions the spike/v2 proofs passed on (plan 2.9): one joins only after a re-run on that exact image. */
export const PROVEN_AUTH_VERSIONS: readonly string[] = ['v2.198.0'];

/** An unverified reserved-name factor older than this is swept; never one younger than two minutes. */
const SWEEP_UNVERIFIED_AFTER_MS = 10 * 60_000;

/** The states that fail closed and wait for the member or the operator (10.1). */
const CLOSED_STATES = new Set([
  'bridge_without_passkey',
  'reserved_factor_without_row',
  'bridge_newer_than_removal',
]);
/** The open states (an active passkey with no verified bridge): counted every day. */
const OPEN_STATES = new Set(['no_bridge', 'bridge_factor_missing', 'bridge_factor_unverified']);

interface StateRow {
  user_id: string;
  state: string;
  bridge_factor_id: string | null;
  bridge_factor_status: string | null;
  bridge_factor_created_at: string | null;
  reserved_factors: Array<{
    factor_id: string;
    status: string | null;
    created_at: string | null;
  }> | null;
}

async function deleteFactor(admin: Admin, userId: string, factorId: string): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: factorId, userId });
    return !error;
  } catch {
    return false;
  }
}

const olderThan = (time: string | null, ms: number) => {
  const cutoff = new Date(Date.now() - ms).toISOString();
  // compareTimes keeps microseconds; an unreadable time is never "old".
  return compareTimes(time, cutoff) === -1;
};

export interface PasskeyMaintenanceSummary {
  ran: boolean;
  purged: { challenges: number; removedPasskeys: number } | null;
  swept: number;
  removalsFinished: number;
  counts: Record<string, number>;
  authVersion: 'proven' | 'unproven' | 'not_checked';
}

/** The daily work (10.3). Never throws. */
export async function runPasskeyMaintenance(): Promise<PasskeyMaintenanceSummary> {
  const summary: PasskeyMaintenanceSummary = {
    ran: false,
    purged: null,
    swept: 0,
    removalsFinished: 0,
    counts: {},
    authVersion: 'not_checked',
  };
  try {
    const rp = passkeyRelyingParty();
    if (!rp) return summary;
    const admin = createAdminClient();

    const purge = await admin.rpc('purge_passkey_records');
    if (purge.error) {
      if (missing(purge.error)) return summary;
      report('purge_failed', 'warning', {
        code: String((purge.error as { code?: unknown }).code ?? 'none'),
      });
    } else {
      const row = (Array.isArray(purge.data) ? purge.data[0] : purge.data) as {
        challenges_deleted?: number;
        removed_passkeys_deleted?: number;
      } | null;
      summary.purged = {
        challenges: Number(row?.challenges_deleted ?? 0),
        removedPasskeys: Number(row?.removed_passkeys_deleted ?? 0),
      };
    }
    summary.ran = true;

    const states = await admin.rpc('passkey_account_states', { p_rp_id: rp.rpId });
    if (states.error) {
      report('states_unreadable', 'error', {
        code: String((states.error as { code?: unknown }).code ?? 'none'),
      });
    } else {
      for (const row of (states.data ?? []) as StateRow[]) {
        summary.counts[row.state] = (summary.counts[row.state] ?? 0) + 1;
        await sweepOne(admin, row, summary);
      }
      const closed = Object.entries(summary.counts).filter(([s]) => CLOSED_STATES.has(s));
      const open = Object.entries(summary.counts).filter(([s]) => OPEN_STATES.has(s));
      if (closed.length > 0) report('accounts_fail_closed', 'error', Object.fromEntries(closed));
      if (open.length > 0)
        report('accounts_without_verified_bridge', 'warning', Object.fromEntries(open));
    }

    summary.authVersion = await checkAuthVersion(admin);
  } catch (e) {
    report('maintenance_failed', 'warning', { name: e instanceof Error ? e.name : 'unknown' });
  }
  console.info('[passkeys.maintenance]', JSON.stringify(summary));
  return summary;
}

/**
 * One account of the list: unverified reserved-name factors older than ten
 * minutes are deleted (never younger than two); S7 and S13 removals the
 * member started are finished. Never a verified bridge of a fail-closed
 * state (S8, S12, S14, S17).
 */
async function sweepOne(
  admin: Admin,
  row: StateRow,
  summary: PasskeyMaintenanceSummary,
): Promise<void> {
  const others = row.reserved_factors ?? [];
  for (const f of others) {
    if (f.status !== 'verified' && olderThan(f.created_at, SWEEP_UNVERIFIED_AFTER_MS)) {
      if (await deleteFactor(admin, row.user_id, f.factor_id)) summary.swept += 1;
    }
  }
  if (
    row.state === 'bridge_factor_unverified' &&
    row.bridge_factor_id &&
    olderThan(row.bridge_factor_created_at, SWEEP_UNVERIFIED_AFTER_MS)
  ) {
    if (await deleteFactor(admin, row.user_id, row.bridge_factor_id)) summary.swept += 1;
  }
  // S13: no bridge row, removed rows only, verified reserved factors no newer
  // than the removal (a newer one is bridge_newer_than_removal, never here).
  // Only the verified ones are the removal's leftovers; an unverified one may
  // be a new Add in flight and goes only by the age rule above.
  if (row.state === 'removal_unfinished') {
    let all = true;
    for (const f of others) {
      if (f.status === 'verified')
        all = (await deleteFactor(admin, row.user_id, f.factor_id)) && all;
    }
    if (all) summary.removalsFinished += 1;
    return;
  }
  if (row.state !== 'bridge_row_without_passkey' || !row.bridge_factor_id) return;
  // S7: a bridge row with its verified factor no newer than the removal.
  if (row.bridge_factor_status === 'verified') {
    if (!(await deleteFactor(admin, row.user_id, row.bridge_factor_id))) return;
    const { error } = await admin.rpc('passkey_drop_bridge', {
      p_user_id: row.user_id,
      p_factor_id: row.bridge_factor_id,
    });
    if (!error) summary.removalsFinished += 1;
    return;
  }
  // S5: a row whose factor is gone, or unverified and old: the row goes.
  if (row.bridge_factor_status === null) {
    await admin.rpc('passkey_drop_bridge', {
      p_user_id: row.user_id,
      p_factor_id: row.bridge_factor_id,
    });
    return;
  }
  if (olderThan(row.bridge_factor_created_at, SWEEP_UNVERIFIED_AFTER_MS)) {
    if (!(await deleteFactor(admin, row.user_id, row.bridge_factor_id))) return;
    await admin.rpc('passkey_drop_bridge', {
      p_user_id: row.user_id,
      p_factor_id: row.bridge_factor_id,
    });
  }
}

/** The daily version check (2.9), only while passkeys are on. Reports; never turns anything off. */
async function checkAuthVersion(admin: Admin): Promise<PasskeyMaintenanceSummary['authVersion']> {
  const settings = await admin
    .from('platform_settings')
    .select('passkeys_on')
    .limit(1)
    .maybeSingle();
  if (settings.error || (settings.data as { passkeys_on?: unknown } | null)?.passkeys_on !== true) {
    return 'not_checked';
  }
  let version: string | null = null;
  try {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
    });
    const body = (await res.json()) as { version?: unknown };
    version = typeof body.version === 'string' ? body.version : null;
  } catch {
    version = null;
  }
  if (version && PROVEN_AUTH_VERSIONS.includes(version)) return 'proven';
  report('auth_version_unproven', 'warning', { version: version ?? 'unread' });
  return 'unproven';
}

function report(tag: string, level: 'warning' | 'error', extra: Record<string, unknown>) {
  void reportError(new Error(`Passkeys: ${tag}`), { tag: `passkeys.${tag}`, level, extra });
}

// ── The detector (10.4) ────────────────────────────────────────────────

const HONEST_EVENTS = ['passkey.used', 'passkey.added', 'passkey.bridge_repaired'];
/** A session raised this recently may not have its audit row yet: the next run (two-hour window) checks it. */
const DETECTOR_GRACE_MS = 2 * 60_000;
const DETECTOR_CHUNK = 50;

interface BridgeSession {
  session_id: string;
  user_id: string;
  factor_id: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface PasskeyDetectorSummary {
  ran: boolean;
  sessions: number;
  unexplained: number;
  usedButNotListed: number;
}

type MetadataRow = { metadata: { session_id?: unknown } | null };

/**
 * Sessions raised by a reserved-name factor (made or refreshed in the last
 * two hours), each matched to an audit row of ours carrying its session id
 * (passkey.used, passkey.added, passkey.bridge_repaired: the three places
 * the server answers a bridge). One with no such row was raised by someone
 * else's code: every session of the account ends, any verified factor made
 * after the session began (not the bridge) is removed, and an error is
 * reported with the account as a hash. A session is acted on only after a
 * read of its own says no row exists; a failed read acts on nothing and is
 * reported. A session changed in the last two minutes waits for the next run
 * (our row is written just after the raise). The other way round (a
 * passkey.used row whose session is not listed: the list is blind, or the
 * session moved) is a warning with a count. An empty list is never read as
 * "all clear" on its own.
 */
export async function runPasskeyDetector(): Promise<PasskeyDetectorSummary> {
  const summary: PasskeyDetectorSummary = {
    ran: false,
    sessions: 0,
    unexplained: 0,
    usedButNotListed: 0,
  };
  try {
    if (!passkeyRelyingParty()) return summary;
    const admin = createAdminClient();
    const since = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const listed = await admin.rpc('passkey_bridge_sessions', { p_since: since });
    if (listed.error) {
      if (missing(listed.error)) return summary;
      report('detector_unreadable', 'error', {
        code: String((listed.error as { code?: unknown }).code ?? 'none'),
      });
      return summary;
    }
    summary.ran = true;
    const all = (listed.data ?? []) as BridgeSession[];
    summary.sessions = all.length;
    const settled = new Date(Date.now() - DETECTOR_GRACE_MS).toISOString();
    const sessions = all.filter((s) => compareTimes(s.updated_at ?? s.created_at, settled) !== 1);

    // First pass: our rows for the listed sessions, a chunk at a time.
    const explained = new Set<string>();
    for (let i = 0; i < sessions.length; i += DETECTOR_CHUNK) {
      const chunk = sessions.slice(i, i + DETECTOR_CHUNK).map((s) => s.session_id);
      const rows = await admin
        .from('audit_logs')
        .select('metadata')
        .in('event', HONEST_EVENTS)
        .in('metadata->>session_id', chunk)
        .limit(1000);
      if (rows.error) continue; // the second pass reads each one again
      for (const r of (rows.data ?? []) as MetadataRow[]) {
        if (typeof r.metadata?.session_id === 'string') explained.add(r.metadata.session_id);
      }
    }
    // Second pass: each session still unmatched, read on its own before anything is done.
    for (const s of sessions) {
      if (explained.has(s.session_id)) continue;
      const own = await admin
        .from('audit_logs')
        .select('id')
        .in('event', HONEST_EVENTS)
        .eq('metadata->>session_id', s.session_id)
        .limit(1);
      if (own.error) {
        report('detector_audit_unreadable', 'error', {});
        continue;
      }
      if (((own.data ?? []) as unknown[]).length > 0) continue;
      summary.unexplained += 1;
      await closeUnexplained(admin, s);
    }

    // The other way round: our own rows whose session the list does not show.
    const used = await admin
      .from('audit_logs')
      .select('metadata')
      .eq('event', 'passkey.used')
      .gte('created_at', since)
      .lte('created_at', settled)
      .limit(1000);
    if (!used.error) {
      const listedIds = new Set(all.map((s) => s.session_id));
      summary.usedButNotListed = ((used.data ?? []) as MetadataRow[]).filter(
        (r) => typeof r.metadata?.session_id === 'string' && !listedIds.has(r.metadata.session_id),
      ).length;
      if (summary.usedButNotListed > 0) {
        report('detector_used_not_listed', 'warning', { count: summary.usedButNotListed });
      }
    }
  } catch (e) {
    report('detector_failed', 'warning', { name: e instanceof Error ? e.name : 'unknown' });
  }
  console.info('[passkeys.detector]', JSON.stringify(summary));
  return summary;
}

async function closeUnexplained(admin: Admin, s: BridgeSession): Promise<void> {
  const userIdHash = accountIdHash(s.user_id);
  void reportError(new Error('Passkeys: a bridge session with no passkey answer of ours'), {
    tag: 'passkeys.bridge_session_unexplained',
    level: 'error',
    extra: { userIdHash },
  });
  await revokeAllSessionsForUser(s.user_id);
  try {
    const { data } = await admin.auth.admin.mfa.listFactors({ userId: s.user_id });
    const factors = ((data as { factors?: unknown[] } | null)?.factors ?? []) as Array<{
      id: string;
      status?: string;
      created_at?: string;
    }>;
    for (const f of factors) {
      if (f.id === s.factor_id || f.status !== 'verified') continue;
      if (s.created_at && compareTimes(f.created_at ?? null, s.created_at) === 1) {
        await deleteFactor(admin, s.user_id, f.id);
      }
    }
  } catch {
    void reportError(new Error('Passkeys: factors after an unexplained bridge session not read'), {
      tag: 'passkeys.bridge_session_factors_unread',
      level: 'error',
      extra: { userIdHash },
    });
  }
}
