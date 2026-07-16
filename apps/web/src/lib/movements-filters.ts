import { movementTypeSchema, type MovementType } from '@stockpilot/core';

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

/**
 * Parses a `YYYY-MM-DD` `?from=` param (as produced by an `<input
 * type="date">`) into an INCLUSIVE lower bound: UTC midnight of that day.
 * Pairs with `since` filters (`created_at >= since`). Garbage input is
 * ignored (undefined) rather than thrown — a mistyped/mangled param must not
 * 500 the page or the export.
 */
export function parseFromDateParam(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Parses a `YYYY-MM-DD` `?to=` param into an EXCLUSIVE upper bound: one full
 * day past UTC midnight of that day. Pairs with `until` filters (`created_at
 * < until`) so filtering is inclusive of the WHOLE `to` day, not just its
 * first instant.
 */
export function parseToDateParam(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(t)) return undefined;
  return new Date(t + 24 * 60 * 60 * 1000).toISOString();
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
