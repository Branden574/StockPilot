/**
 * "Last active" for the platform console's Users tab: the pure half.
 *
 * Migration 0351 returns THREE timestamps per member and each one is a floor
 * with a different blind spot:
 *
 *   lastSessionAt  the newest sign-in renewal on any device. Moves about once
 *                  an hour while the app is open, so it is the best signal,
 *                  but the row is deleted on sign-out and on revocation and
 *                  the timestamp goes with it. A tab left open on an
 *                  unattended screen keeps it moving.
 *   lastActionAt   the newest audit row this person wrote IN THIS organization
 *                  (automation excluded). Survives sign-out. Blind to
 *                  read-only use.
 *   lastSignInAt   when the current login STARTED. With sessions that live for
 *                  months it understates badly, so it is the fallback only.
 *
 * Nothing here touches the database or the clock: `now` is a parameter, so the
 * wording is testable to the second and identical on every server.
 */

export interface LastActiveSignals {
  lastSignInAt?: string | null;
  lastSessionAt?: string | null;
  lastActionAt?: string | null;
}

export type LastActiveSource = 'session' | 'action' | 'sign_in' | 'never';

export interface ResolvedLastActive {
  /** Normalised ISO instant, or null when nothing is known. */
  at: string | null;
  source: LastActiveSource;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** From here on a relative age stops being useful and a date reads better. */
const RELATIVE_DAYS = 30;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Epoch millis for an ISO instant, or null for anything that is not one. */
function toMillis(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The latest of the three, and which one it was.
 *
 * Compared as INSTANTS: the values come from Postgres with whatever offset and
 * fractional precision each column carries, and ISO strings with different
 * offsets do not sort chronologically.
 *
 * Tie order is action, then session, then sign-in. A sign-in creates its
 * session in the same instant, and 'sign_in' is rendered as the hedged
 * fallback, so it must not win a tie it does not need to win.
 */
export function resolveLastActive(signals: LastActiveSignals): ResolvedLastActive {
  const candidates: Array<{ source: LastActiveSource; ms: number | null }> = [
    { source: 'action', ms: toMillis(signals.lastActionAt) },
    { source: 'session', ms: toMillis(signals.lastSessionAt) },
    { source: 'sign_in', ms: toMillis(signals.lastSignInAt) },
  ];

  let best: { source: LastActiveSource; ms: number } | null = null;
  for (const c of candidates) {
    if (c.ms === null) continue;
    if (best === null || c.ms > best.ms) best = { source: c.source, ms: c.ms };
  }

  if (best === null) return { at: null, source: 'never' };
  return { at: new Date(best.ms).toISOString(), source: best.source };
}

function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * COARSE on purpose. The underlying signal has about an hour of resolution,
 * so "4 minutes ago" would claim accuracy the data does not have. Ages are
 * whole elapsed hours and days, which need no time zone; from thirty days on
 * it is a UTC calendar date. Never throws: this renders on the only surface
 * that can disable an account, which has no error boundary.
 */
export function formatLastActive(iso: string | null | undefined, now: Date): string {
  const ms = toMillis(iso);
  if (ms === null) return 'Never';

  // A small negative age is clock skew between Postgres and this server.
  const age = Math.max(0, now.getTime() - ms);
  if (age < HOUR_MS) return 'Within the last hour';
  if (age < DAY_MS) {
    const hours = Math.floor(age / HOUR_MS);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(age / DAY_MS);
  if (days < RELATIVE_DAYS) return days === 1 ? '1 day ago' : `${days} days ago`;
  return utcDate(ms);
}

/**
 * The exact instant, in UTC and LABELLED as UTC. This page is a server
 * component, so an unlabelled toLocaleString() would print the server's wall
 * clock and show a 6:30 PM Pacific session as 1:30 AM the next day.
 */
export function formatExactUtc(iso: string | null | undefined): string | null {
  const ms = toMillis(iso);
  if (ms === null) return null;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${utcDate(ms)}, ${hh}:${mm} UTC`;
}

/**
 * The cell's tooltip: every known signal with its exact instant, so the value
 * on screen can be checked against its parts. The sign-in-only case gets its
 * own wording because that is when the number is most likely to be badly
 * stale, and an operator may be reading it to decide an account is dormant.
 */
export function describeLastActive(signals: LastActiveSignals): string {
  const { source } = resolveLastActive(signals);
  if (source === 'never') {
    return 'This person has never signed in and has no recorded activity in this organization.';
  }

  const session = formatExactUtc(signals.lastSessionAt);
  const action = formatExactUtc(signals.lastActionAt);
  const signIn = formatExactUtc(signals.lastSignInAt);

  const parts: string[] = [];
  if (session) {
    parts.push(`Sign-in last renewed ${session} (any device, accurate to about an hour).`);
  } else {
    parts.push('No open sign-ins on any device.');
  }
  if (action) parts.push(`Last recorded action in this organization ${action}.`);
  if (signIn) parts.push(`Last signed in ${signIn}.`);
  if (source === 'sign_in') {
    parts.push('They may have kept working after this and then signed out.');
  }
  return parts.join(' ');
}
