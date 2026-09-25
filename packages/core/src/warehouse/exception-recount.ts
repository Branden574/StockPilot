import { formatStockQuantity, formatHoldingLabel } from '../inventory/stock-writeoff';

import { EXCEPTION_RULES, isExceptionRule, roundQuantity, signedQuantity } from './exceptions';

/**
 * TARGETED RECOUNTS (F1-2, migration 0372) — the shared words and derivations.
 *
 * From an exception (or an item) a manager starts a recount. It is an ORDINARY
 * cycle count: start_targeted_recount creates it through start_cycle_count,
 * staff record it online or offline, a manager posts it through
 * post_cycle_count, and the after-post check decides whether the exception
 * cleared. Nothing here writes stock.
 *
 * Everything the web pages and the phone both SAY about a recount is derived
 * here, so the two never word the same count differently: what came of it
 * (recountOutcome), where a counted difference lands when the count is
 * posted (varianceDestination), the count's notes, and why an item was left
 * out.
 */

/** Most items one recount may name (start_targeted_recount's cap, 0372). */
export const RECOUNT_MAX_ITEMS = 200;

/**
 * A recount's notes are at most this long. They become the count's notes, and
 * a count's notes are the title of the assignee's lock-screen push, so they
 * say only which item (or how many), never why.
 */
export const RECOUNT_NOTES_MAX = 80;

/** A rule a recount can settle: an item-level rule, because a count records
 *  the item's total (EXCEPTION_RULES[rule].recountable). False for any rule
 *  this build does not know. */
export function isRecountableRule(rule: unknown): boolean {
  return isExceptionRule(rule) && EXCEPTION_RULES[rule].recountable;
}

/**
 * The notes a recount's count carries: "Recount: <item name>" for one item,
 * "Recount: N items" for more, null for none. Neutral on purpose (they reach a
 * lock screen), and never longer than RECOUNT_NOTES_MAX.
 */
export function recountNotes(items: ReadonlyArray<{ name: string | null | undefined }>): string | null {
  if (items.length === 0) return null;
  if (items.length > 1) return `Recount: ${items.length} items`;
  const name = (items[0]!.name ?? '').replace(/\s+/g, ' ').trim();
  if (name === '') return 'Recount: 1 item';
  const text = `Recount: ${name}`;
  const chars = Array.from(text);
  return chars.length <= RECOUNT_NOTES_MAX ? text : `${chars.slice(0, RECOUNT_NOTES_MAX - 1).join('')}…`;
}

/** The recount dialog's line about what a count covers (web and phone). */
export const RECOUNT_COUNTS_TOTAL_COPY = 'Counts record each item’s total, wherever it is stored.';

/** Why Recount is not offered to this reader. */
export const RECOUNT_MANAGER_ONLY_COPY =
  'Only a manager with permission to assign counts and adjust stock can start a recount.';

/** Why a requested item was left out of a recount (start_targeted_recount). */
export type RecountSkipReason = 'resolved' | 'not_recountable' | 'not_countable';

export const RECOUNT_SKIP_REASON_COPY: Record<RecountSkipReason, string> = {
  resolved: 'Already resolved',
  not_recountable: 'A recount cannot settle this kind of exception',
  not_countable: 'Rental equipment, kits and archived items are not counted',
};

export function isRecountSkipReason(value: unknown): value is RecountSkipReason {
  return value === 'resolved' || value === 'not_recountable' || value === 'not_countable';
}

// ── What came of a recount ──────────────────────────────────────────────────

function quantity(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function wholeCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The count a recount ran as, as far as the reader can see it. */
export interface RecountOutcomeCount {
  /** cycle_counts.status: in_progress | completed | canceled. */
  status: string | null | undefined;
  /** For a count in progress: lines counted so far, and lines in the count. */
  countedLines?: number | null;
  totalLines?: number | null;
}

/** The count's line for the exception's item: null when it could not be read. */
export interface RecountOutcomeLine {
  countedQuantity: number | string | null;
  /** The book at count time (the line's expected quantity). */
  expectedQuantity: number | string | null;
}

export type RecountOutcome =
  | { kind: 'in_progress'; counted: number | null; total: number | null }
  | { kind: 'cancelled' }
  /** Posted, but this item's line was never counted, so nothing was applied. */
  | { kind: 'not_counted' }
  | { kind: 'matched'; quantity: number }
  | { kind: 'corrected'; from: number; to: number; delta: number }
  /** The count or its line could not be read. Never read as "matched". */
  | { kind: 'unavailable' };

/**
 * What came of a recount for one item, derived at display time from the
 * count and the item's line. A closed count is final (0368), so a completed
 * or cancelled outcome never changes once shown.
 *
 * The line's numbers are what the post applied: counted - expected (0339,
 * 0369). A line whose count matched the book applied nothing.
 */
export function recountOutcome(
  count: RecountOutcomeCount | null | undefined,
  line: RecountOutcomeLine | null | undefined,
): RecountOutcome {
  if (!count) return { kind: 'unavailable' };
  switch (count.status) {
    case 'in_progress':
      return {
        kind: 'in_progress',
        counted: wholeCount(count.countedLines),
        total: wholeCount(count.totalLines),
      };
    case 'canceled':
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'completed': {
      if (!line) return { kind: 'unavailable' };
      const counted = quantity(line.countedQuantity);
      if (counted === null) {
        // A line that is present but blank was never counted (the post skips
        // it). An unreadable number is not "not counted".
        return line.countedQuantity === null ? { kind: 'not_counted' } : { kind: 'unavailable' };
      }
      const expected = quantity(line.expectedQuantity);
      if (expected === null) return { kind: 'unavailable' };
      const delta = roundQuantity(counted - expected);
      if (delta === 0) return { kind: 'matched', quantity: counted };
      return { kind: 'corrected', from: expected, to: counted, delta };
    }
    default:
      return { kind: 'unavailable' };
  }
}

/** The outcome in words, the same on the web and the phone. */
export function recountOutcomeCopy(outcome: RecountOutcome): string {
  switch (outcome.kind) {
    case 'in_progress':
      return outcome.counted !== null && outcome.total !== null
        ? `In progress: ${outcome.counted} of ${outcome.total} counted`
        : 'In progress';
    case 'cancelled':
      return 'Cancelled before it was posted';
    case 'not_counted':
      return 'Posted without counting this item';
    case 'matched':
      return `Matched the book (${formatStockQuantity(outcome.quantity)})`;
    case 'corrected':
      return `Book corrected from ${formatStockQuantity(outcome.from)} to ${formatStockQuantity(outcome.to)} (${signedQuantity(outcome.delta)})`;
    case 'unavailable':
      return 'Result not available';
  }
}

// ── Where a counted difference lands ────────────────────────────────────────

/** The counted location as the reader sees it (the line's counted_location_id). */
export interface VarianceDestinationLocation {
  name: string;
  kind?: string | null;
  /** Archived since the count: the post routes as if none were recorded. */
  archived?: boolean;
}

export type VarianceDestination =
  /** Counted equals the book: posting changes nothing. */
  | { kind: 'none' }
  | { kind: 'adds_to_location'; location: string }
  | { kind: 'adds_to_staging' }
  | { kind: 'off_location_then_staging'; location: string }
  | { kind: 'off_staging_then_shelves' };

/**
 * Where a line's difference lands when the count is posted. It mirrors
 * ledger.post_cycle_count (0342/0343, frozen): the line's counted location is
 * the target when it is recorded, not archived and not Staging;
 *   - more than the book: added to the target, else to Staging;
 *   - less than the book: taken off the target first (never below zero there),
 *     then Staging first and then the shelf locations; with no target,
 *     Staging first and then the shelf locations.
 * Null when the line is not counted or its numbers cannot be read.
 */
export function varianceDestination(input: {
  countedQuantity: number | string | null;
  expectedQuantity: number | string | null;
  countedLocation: VarianceDestinationLocation | null;
}): VarianceDestination | null {
  const counted = quantity(input.countedQuantity);
  const expected = quantity(input.expectedQuantity);
  if (counted === null || expected === null) return null;
  const variance = roundQuantity(counted - expected);
  if (variance === 0) return { kind: 'none' };
  const loc = input.countedLocation;
  const target =
    loc && !loc.archived && loc.kind !== 'staging' && loc.name.trim() !== ''
      ? formatHoldingLabel(loc.kind ?? null, loc.name.trim())
      : null;
  if (variance > 0) {
    return target ? { kind: 'adds_to_location', location: target } : { kind: 'adds_to_staging' };
  }
  return target
    ? { kind: 'off_location_then_staging', location: target }
    : { kind: 'off_staging_then_shelves' };
}

/** The destination as a lowercase phrase, to follow the numbers. */
export function varianceDestinationCopy(destination: VarianceDestination): string {
  switch (destination.kind) {
    case 'none':
      return 'no change to stock';
    case 'adds_to_location':
      return `adds to ${destination.location}`;
    case 'adds_to_staging':
      return 'adds to Staging';
    case 'off_location_then_staging':
      return `comes off ${destination.location} first, then Staging`;
    case 'off_staging_then_shelves':
      return 'comes off Staging first, then shelf locations';
  }
}

/**
 * The review line for a counted line linked to an exception: the counted and
 * book quantities at count time, the difference, and where it lands, e.g.
 * "Counted 11, book 10 (+1): adds to Rack 12-A". Null when not counted.
 */
export function varianceReviewLine(input: {
  countedQuantity: number | string | null;
  expectedQuantity: number | string | null;
  countedLocation: VarianceDestinationLocation | null;
}): string | null {
  const destination = varianceDestination(input);
  if (!destination) return null;
  const counted = quantity(input.countedQuantity)!;
  const expected = quantity(input.expectedQuantity)!;
  const delta = roundQuantity(counted - expected);
  const numbers = `Counted ${formatStockQuantity(counted)}, book ${formatStockQuantity(expected)}`;
  return delta === 0
    ? `${numbers}: ${varianceDestinationCopy(destination)}`
    : `${numbers} (${signedQuantity(delta)}): ${varianceDestinationCopy(destination)}`;
}
