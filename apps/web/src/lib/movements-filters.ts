import { movementTypeSchema, resolveOrgTimezone, type MovementType } from '@stockpilot/core';

/**
 * Shared filter helpers for the global Movements page (`/dashboard/movements`)
 * and its CSV export (`/api/movements/export.csv`). Both the server-mode
 * page (numbered pagination, ?q/?type/?from/?to → MovementsService) and the
 * instant-mode client table (whole small ledger loaded once, filtered in
 * memory) render the same MovementsFilterBar and must agree on how a raw
 * query-string value maps to a real filter — this module is the one place
 * that mapping lives, so the page, the export route, and the client-side
 * instant filter can never drift apart. Pure (no supabase, no server-only) —
 * safe to import from client components.
 *
 * DATE BOUNDS TAKE AN OPTIONAL ZONE (SP-079). `parseFromDateParam` /
 * `parseToDateParam` accept the zone the user picked the date IN; omitting it
 * keeps the historical UTC-midnight bounds. Every caller that has an org
 * timezone in hand SHOULD pass it — see the long note on those functions for
 * what the UTC bounds got wrong. Callers still to be threaded through:
 * `(dashboard)/dashboard/movements/page.tsx`,
 * `api/movements/export.csv/route.ts` (both have `ctx.organizationId`, so
 * `getCachedOrgTimezone`), and `components/movements/movements-instant-table
 * .tsx`, which repeats this UTC arithmetic inline instead of calling these
 * helpers at all (recurring pattern #26 — a second copy that will drift).
 */

/** Human labels for the movement_type enum, in the order the Select renders
 *  them. Keep in sync with movementTypeSchema (@stockpilot/core/schemas). */
const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  add: 'Add',
  remove: 'Remove',
  adjust: 'Adjust',
  transfer: 'Transfer',
  receive_po: 'Receive PO',
  return: 'Return',
  damage: 'Damage',
  loss: 'Loss',
  correction: 'Correction',
  initial: 'Initial',
};

export const MOVEMENT_TYPE_OPTIONS: Array<{ value: MovementType; label: string }> =
  movementTypeSchema.options.map((value) => ({ value, label: MOVEMENT_TYPE_LABELS[value] }));

/**
 * Validates a raw `?type=` query param against the real MovementType enum.
 * Returns undefined for anything else (missing, empty, "all", garbage) so
 * every caller treats "no filter" the same way instead of round-tripping a
 * bogus value into a query.
 */
export function parseMovementTypeParam(raw: string | undefined | null): MovementType | undefined {
  if (!raw) return undefined;
  const parsed = movementTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * THE DAY BOUNDARY IS A LOCAL ONE (SP-079, 2026-09-05).
 *
 * These bounds used to be plain UTC midnight, while every movement row on
 * screen renders through `components/ui/local-datetime.tsx` — i.e. in a
 * NON-UTC zone. For the Pacific orgs (all three in prod) that made a
 * one-day filter quietly wrong at both ends: From=To=2026-09-10 EXCLUDED
 * everything posted 17:00-23:59 PT on the 10th (a write-off at 18:30 PT is
 * 01:30Z on the 11th) and INCLUDED the previous evening, which the same
 * screen labels "Sep 9". The CSV export shares these helpers, so a day
 * reconciliation exported the wrong day too.
 *
 * So callers may now name the zone the user picked the date IN. The offset
 * is asked of `Intl` at that instant rather than stored, because it is not a
 * constant: America/Los_Angeles is UTC-7 in July and UTC-8 in January, and a
 * fixed offset is wrong for half the year.
 *
 * WHY TWO PASSES: the offset we need is the one in effect AT the local
 * midnight we are still solving for, so the first pass measures the offset
 * near the target and the second re-solves with it. That is what makes the
 * DST-transition days come out right. On the (rare) zones where local
 * midnight does not exist at all — a DST jump AT midnight, e.g. some
 * Southern-Hemisphere zones — this settles on the first instant that does
 * exist that day, which is the correct inclusive lower bound anyway.
 */
function zonedDayStartMs(dayUtcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // Offset (zone wall-clock minus UTC) at a given instant, read back out of
  // the formatter's own parts — the only source that knows this zone's DST
  // rules for this date.
  const offsetAt = (instantMs: number): number => {
    const parts = dtf.formatToParts(new Date(instantMs));
    const field = (type: Intl.DateTimeFormatPartTypes): number => {
      const found = parts.find((p) => p.type === type);
      return found ? Number(found.value) : 0;
    };
    // 'h23' can still surface hour 24 on some ICU builds at exactly midnight.
    const hour = field('hour') % 24;
    const asUtc = Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      hour,
      field('minute'),
      field('second'),
    );
    return asUtc - instantMs;
  };
  let instant = dayUtcMs - offsetAt(dayUtcMs);
  instant = dayUtcMs - offsetAt(instant);
  return instant;
}

/**
 * Resolves the `timeZone` argument these two parsers share.
 *
 * Omitted / blank means "no zone was threaded through here", and that keeps
 * the historical UTC behaviour EXACTLY — an un-migrated caller must not have
 * its bounds silently shift by 7-8 hours. A caller that DOES pass a value is
 * passing `organizations.timezone`, so it goes through core's
 * `resolveOrgTimezone`: a stored zone this runtime does not recognise
 * ('America/Fresno') would otherwise RangeError out of a page render, and
 * degrading to the documented org default keeps the filter agreeing with
 * what the screen shows instead of silently reverting to UTC.
 */
function resolveBoundTimezone(timeZone: string | undefined | null): string | null {
  const candidate = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!candidate) return null;
  return resolveOrgTimezone(candidate);
}

/**
 * Parses a `YYYY-MM-DD` `?from=` param (as produced by an `<input
 * type="date">`) into an INCLUSIVE lower bound: midnight of that day in
 * `timeZone` (UTC midnight when no zone is given — see the SP-079 note
 * above). Pairs with `since` filters (`created_at >= since`). Garbage input
 * is ignored (undefined) rather than thrown — a mistyped/mangled param must
 * not 500 the page or the export.
 */
export function parseFromDateParam(
  raw: string | undefined | null,
  timeZone?: string | null,
): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(t)) return undefined;
  const zone = resolveBoundTimezone(timeZone);
  return new Date(zone ? zonedDayStartMs(t, zone) : t).toISOString();
}

/**
 * Parses a `YYYY-MM-DD` `?to=` param into an EXCLUSIVE upper bound: the
 * start of the NEXT day in `timeZone` (UTC midnight + 24h when no zone is
 * given). Pairs with `until` filters (`created_at < until`) so filtering is
 * inclusive of the WHOLE `to` day, not just its first instant.
 *
 * The next day's start is computed as its own zoned midnight rather than
 * "+24h", because a DST day is 23 or 25 hours long — adding a flat day
 * across a transition would clip an hour off the end of the range or spill
 * an hour into the next one.
 */
export function parseToDateParam(
  raw: string | undefined | null,
  timeZone?: string | null,
): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(t)) return undefined;
  const zone = resolveBoundTimezone(timeZone);
  if (!zone) return new Date(t + DAY_MS).toISOString();
  return new Date(zonedDayStartMs(t + DAY_MS, zone)).toISOString();
}

/** The four filter dimensions the Movements page + export share, in their
 *  raw (string) query-param shape. Empty string means "unset" throughout —
 *  callers building a querystring should omit empty fields entirely. */
export interface MovementsFilterQuery {
  q: string;
  /** Raw MovementType value, or '' for "all types". */
  type: string;
  /** 'YYYY-MM-DD', or '' for unset. */
  from: string;
  /** 'YYYY-MM-DD', or '' for unset. */
  to: string;
}

/**
 * Builds the `?q=&type=&from=&to=` query string from filter values — used by
 * the server-mode pager (page links must preserve the active filters) and by
 * both filter-bar modes to build the "Export CSV" link's href. Trims `q` and
 * omits any empty field so an all-clear filter set yields an empty string.
 */
export function buildMovementsQueryString(filters: MovementsFilterQuery): string {
  const sp = new URLSearchParams();
  const q = filters.q.trim();
  if (q) sp.set('q', q);
  if (filters.type) sp.set('type', filters.type);
  if (filters.from) sp.set('from', filters.from);
  if (filters.to) sp.set('to', filters.to);
  return sp.toString();
}
