import { PASSKEY_BRIDGE_NAME_PREFIX } from '@/lib/auth/passkey-bridge-name';

/**
 * One account's passkey state, judged by the SAME rule, in the same order,
 * as the database's list `passkey_account_states(rp_id)` (migration 0475;
 * plan 2.1 rule 23, stage 1 review 2 N6). There is no single-account
 * function, so the server reads the facts for one account (its passkey rows,
 * its bridge row and its factors at Auth) and judges them here.
 *
 * WHAT MUST MATCH THE DATABASE EXACTLY
 *   - "reserved-name factor": a TOTP factor whose name starts with
 *     `sp-passkey-bridge-` (the first 18 characters).
 *   - The bridge factor's status and time are read only from a reserved-name
 *     TOTP factor whose id is the row's factor id; any other factor named by
 *     the row is "missing".
 *   - "Other" factors are reserved-name TOTP factors whose id is not the
 *     row's factor id.
 *   - Times compare at the database's precision (microseconds), never at a
 *     JavaScript Date's milliseconds: a factor made one microsecond after the
 *     newest removal is newer (0475/166, account ec). compareTimes() below.
 *   - N5: "a verified other factor exists" is its own fact, never "the newest
 *     time is not null"; a verified factor (or the row's verified factor)
 *     with no time reads as made AFTER the removal (closed).
 *   - A time this code cannot read is treated like no time (closed): the
 *     database always has one, so this only ever makes the answer stricter.
 *
 * Pure: no server import, no read. passkey-state.test.ts runs the accounts
 * of pgTAP 0475/164 and 0475/166 through it and expects the same answers.
 */

export type PasskeyAccountState =
  | 'reserved_factor_without_row'
  | 'bridge_newer_than_removal'
  | 'removal_unfinished'
  | 'bridge_without_passkey'
  | 'bridge_row_without_passkey'
  | 'other_site_only'
  | 'no_bridge'
  | 'bridge_factor_missing'
  | 'bridge_factor_unverified'
  | 'unverified_reserved_factor'
  | 'healthy'
  | 'nothing';

/** A passkey row as the server reads it (service role). */
export interface PasskeyRowFact {
  rp_id: string;
  removed_at: string | null;
}

/** A factor as Auth lists it (GET /user, or the admin list). */
export interface AuthFactorFact {
  id: string;
  factor_type?: string | null;
  status?: string | null;
  friendly_name?: string | null;
  created_at?: string | null;
}

export interface PasskeyAccountFacts {
  active: number;
  otherSite: number;
  removed: number;
  /** The newest removed_at of any row of the account (any site). */
  lastRemoved: string | null;
  bridgeFactorId: string | null;
  bridgeStatus: string | null;
  bridgeCreated: string | null;
  hasOtherVerified: boolean;
  newestOtherVerified: string | null;
  otherVerifiedUntimed: boolean;
  /** Every other reserved-name factor (id, status, time), in time then id order. */
  others: Array<{ factor_id: string; status: string | null; created_at: string | null }>;
}

/** The database's test: `left(coalesce(friendly_name, ''), 18) = 'sp-passkey-bridge-'`. */
export function isReservedTotp(f: AuthFactorFact): boolean {
  return (
    f.factor_type === 'totp' &&
    (f.friendly_name ?? '').slice(0, PASSKEY_BRIDGE_NAME_PREFIX.length) === PASSKEY_BRIDGE_NAME_PREFIX
  );
}

const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A timestamp as nanoseconds since 1970 (a bigint), or null when it cannot
 * be read. Reads what PostgREST (`2026-11-21T09:00:00.123456+00:00`) and Auth
 * (`2026-11-21T09:00:00.123456Z`) send, keeping every fractional digit.
 */
export function timeNanos(text: string | null | undefined): bigint | null {
  if (typeof text !== 'string') return null;
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(ms)) return null;
  let offsetMinutes = 0;
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const nanosOfSecond = BigInt((frac ?? '').padEnd(9, '0'));
  return (BigInt(ms) - BigInt(offsetMinutes) * 60_000n) * 1_000_000n + nanosOfSecond;
}

/** -1, 0 or 1 as `a` is before, at or after `b`; null when either cannot be read. */
export function compareTimes(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  const x = timeNanos(a);
  const y = timeNanos(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The newest of several times (null when none can be read). */
function newestOf(times: ReadonlyArray<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestN: bigint | null = null;
  for (const t of times) {
    const n = timeNanos(t);
    if (n === null) continue;
    if (bestN === null || n > bestN) {
      best = t as string;
      bestN = n;
    }
  }
  return best;
}

/**
 * The facts of one account, as the database's `facts` step computes them.
 * `rows` are the account's passkey rows (every site), `bridgeFactorId` its
 * bridge row's factor id (or null), `factors` its factors at Auth.
 */
export function passkeyFactsOf(
  rows: readonly PasskeyRowFact[],
  bridgeFactorId: string | null,
  factors: readonly AuthFactorFact[],
  rpId: string,
): PasskeyAccountFacts {
  const active = rows.filter((r) => r.removed_at === null && r.rp_id === rpId).length;
  const otherSite = rows.filter((r) => r.removed_at === null && r.rp_id !== rpId).length;
  const removedRows = rows.filter((r) => r.removed_at !== null);
  const reserved = factors.filter(isReservedTotp);
  const bridgeFactor =
    bridgeFactorId === null ? undefined : reserved.find((f) => f.id === bridgeFactorId);
  const others = reserved.filter((f) => f.id !== bridgeFactorId);
  const otherVerified = others.filter((f) => f.status === 'verified');
  // "Untimed": no time the database could have, or one this code cannot read
  // (stricter, never looser).
  const untimed = (f: AuthFactorFact) => timeNanos(f.created_at) === null;
  const ordered = [...others].sort((a, b) => {
    const ta = timeNanos(a.created_at);
    const tb = timeNanos(b.created_at);
    // Postgres orders nulls last in ascending order.
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta < tb ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    active,
    otherSite,
    removed: removedRows.length,
    lastRemoved: newestOf(removedRows.map((r) => r.removed_at)),
    bridgeFactorId,
    bridgeStatus: bridgeFactor ? (bridgeFactor.status ?? null) : null,
    bridgeCreated: bridgeFactor ? (bridgeFactor.created_at ?? null) : null,
    hasOtherVerified: otherVerified.length > 0,
    newestOtherVerified: newestOf(otherVerified.map((f) => f.created_at)),
    otherVerifiedUntimed: otherVerified.some(untimed),
    others: ordered.map((f) => ({
      factor_id: f.id,
      status: f.status ?? null,
      created_at: f.created_at ?? null,
    })),
  };
}

/**
 * Whether a factor time is after the newest removal, as the database's
 * `time > last_removed`. No time at all (null) is SQL's unknown: false. A
 * time, or a last removal, this code cannot read is closed: true (the
 * database always has both, so this is only ever stricter).
 */
function newerThanRemoval(t: string | null, lastRemoved: string | null): boolean {
  if (t === null) return false;
  const tn = timeNanos(t);
  const ln = timeNanos(lastRemoved);
  if (tn === null || ln === null) return true;
  return tn > ln;
}

/**
 * The state word, by the database's `judged` step, branch for branch.
 * Where SQL would compare with a null (unknown), the branch is not taken,
 * exactly as SQL's `case when` does not take it; the two places where the
 * database is CLOSED on a missing time (an untimed verified other factor, a
 * verified bridge with no time) are written out as the database writes them.
 * A time this code cannot read is closed (newerThanRemoval).
 */
export function judgePasskeyAccount(x: PasskeyAccountFacts): PasskeyAccountState {
  const bridgeRow = x.bridgeFactorId !== null;
  if ((x.active > 0 || bridgeRow) && x.hasOtherVerified) return 'reserved_factor_without_row';
  if (
    x.active === 0 &&
    x.otherSite === 0 &&
    x.removed > 0 &&
    (newerThanRemoval(x.newestOtherVerified, x.lastRemoved) ||
      x.otherVerifiedUntimed ||
      (x.bridgeStatus === 'verified' &&
        (timeNanos(x.bridgeCreated) === null || newerThanRemoval(x.bridgeCreated, x.lastRemoved))))
  ) {
    return 'bridge_newer_than_removal';
  }
  if (!bridgeRow && x.active === 0 && x.otherSite === 0 && x.removed > 0 && x.hasOtherVerified) {
    return 'removal_unfinished';
  }
  if (x.active === 0 && x.otherSite === 0 && x.removed === 0 && (bridgeRow || x.hasOtherVerified)) {
    return 'bridge_without_passkey';
  }
  if (bridgeRow && x.active === 0 && x.otherSite === 0) return 'bridge_row_without_passkey';
  if (x.active === 0 && x.otherSite > 0) return 'other_site_only';
  if (x.active > 0 && !bridgeRow) return 'no_bridge';
  if (x.active > 0 && x.bridgeStatus === null) return 'bridge_factor_missing';
  if (x.active > 0 && x.bridgeStatus !== 'verified') return 'bridge_factor_unverified';
  if (x.others.length > 0) return 'unverified_reserved_factor';
  if (x.active > 0) return 'healthy';
  return 'nothing';
}
