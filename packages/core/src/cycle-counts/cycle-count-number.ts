/**
 * Cycle-count references: `cycle_counts.count_number` 42 -> "CC-000042".
 *
 * The number is a per-organization bigint the DATABASE assigns when a count is
 * created (a persistent per-org counter, migration 0358). The display string
 * never exists in the database; this module is the one place that renders it
 * and the one place that parses a typed handle back to the number, so web and
 * mobile can never disagree about either. Same shape as formatOrderNumber and
 * formatMaintenanceRequestNumber beside it.
 *
 * The uuid stays the count's identity everywhere (routes, API ids, deep
 * links, foreign keys). The reference is a display and search handle only.
 */

/** Shown where a count has no number yet: an old offline cache, or a server
 *  that has not run 0358. A client never invents a number to fill the gap. */
export const CYCLE_COUNT_REFERENCE_UNAVAILABLE = 'Reference unavailable';

/** Longest search input the list accepts, in characters, after trimming. */
export const CYCLE_COUNT_SEARCH_MAX_LENGTH = 100;

/**
 * 42 -> "CC-000042". At least six digits, zero-padded; larger numbers print in
 * full ("CC-1234567"), never truncated. Anything that is not a positive safe
 * integer -> null, so a caller shows the unavailable label instead of a
 * made-up reference.
 */
export function formatCycleCountNumber(n: number | string | null | undefined): string | null {
  const value = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return `CC-${String(value).padStart(6, '0')}`;
}

/** The reference, or the truthful fallback when there is none. */
export function cycleCountReferenceLabel(n: number | string | null | undefined): string {
  return formatCycleCountNumber(n) ?? CYCLE_COUNT_REFERENCE_UNAVAILABLE;
}

/** What a list search asks the server for. */
export type CycleCountSearch =
  | { kind: 'all' }
  /** Exact reference lookup. `number` 0 is a reference-shaped query that can
   *  never match (all zeros, or more digits than any count could have). */
  | { kind: 'number'; number: number; text: string }
  /** Literal text match against the fields the list advertises. */
  | { kind: 'text'; text: string };

/**
 * Trim, fold compatibility forms (full-width digits and letters, the
 * full-width hyphen), drop invisible format characters and control
 * characters, collapse runs of whitespace and cap the length. Counted in code points so a cap never splits an emoji or
 * other surrogate pair.
 */
export function normalizeCycleCountSearch(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const folded = raw
    .normalize('NFKC')
    // Invisible format characters a paste carries along (zero-width space,
    // direction marks, soft hyphen, word joiner) would turn "CC-000042" into
    // text that matches nothing.
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = Array.from(folded).slice(0, CYCLE_COUNT_SEARCH_MAX_LENGTH).join('');
  return capped.trim();
}

/**
 * A reference-shaped query: an optional "CC" prefix, an optional dash (any of
 * the dash characters people paste), an optional "#", then digits.
 * "CC-000042", "cc-000042", "CC-42", "CC 42", "#42", "000042" and "42" all
 * qualify.
 */
const REFERENCE_SHAPE = /^(?:cc\s*[-‐-―−]?\s*)?#?\s*(\d+)$/i;

/** More digits than this cannot be a count number (the column is a bigint and
 *  JavaScript numbers stay exact to 15 digits). */
const MAX_REFERENCE_DIGITS = 15;

/**
 * Turns what someone typed into the search the server runs. Reference-shaped
 * or all-numeric input is an EXACT number lookup (so "42" finds CC-000042 and
 * not CC-000420); anything else is a literal text search. The server applies
 * either one inside the caller's organization and warehouse scope; nothing
 * typed here can widen that.
 */
export function parseCycleCountSearch(raw: string | null | undefined): CycleCountSearch {
  const text = normalizeCycleCountSearch(raw);
  if (!text) return { kind: 'all' };
  const m = REFERENCE_SHAPE.exec(text);
  if (m && m[1] !== undefined) {
    const digits = m[1].replace(/^0+/, '');
    const number =
      digits.length === 0 || digits.length > MAX_REFERENCE_DIGITS ? 0 : Number(digits);
    return { kind: 'number', number: Number.isSafeInteger(number) ? number : 0, text };
  }
  return { kind: 'text', text };
}
