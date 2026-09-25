import { can, type Permission } from '../constants/permissions';
import type { Role } from '../constants/roles';
import { isManagerOrAbove } from '../constants/terminology';
import { formatCycleCountNumber } from '../cycle-counts/cycle-count-number';
import { formatStockQuantity, formatHoldingLabel } from '../inventory/stock-writeoff';
import { formatOrgDateTime } from '../time/org-timezone';

import {
  describeOccurrenceEvent,
  EXCEPTION_RULES,
  isExceptionRule,
  roundQuantity,
  signedQuantity,
  type OccurrenceEventKind,
  type OccurrenceResolvedReason,
} from './exceptions';

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

/**
 * Why this reader cannot start a recount (the server's assertCountStartFloors
 * as a reason, checked in its order):
 *   - module_disabled: the organization has Cycle Counts turned off (the
 *     exceptions stay, so a manager must not read "only a manager");
 *   - not_permitted: not a manager with cycle_counts:assign and stock:adjust.
 * (A session that has not passed a required MFA check never gets this far:
 * reading exceptions is refused first.)
 */
export type RecountUnavailableReason = 'module_disabled' | 'not_permitted';

export const RECOUNT_UNAVAILABLE_COPY: Record<RecountUnavailableReason, string> = {
  module_disabled: 'Cycle Counts is turned off for this organization, so a recount cannot be started.',
  not_permitted: RECOUNT_MANAGER_ONLY_COPY,
};

export function isRecountUnavailableReason(value: unknown): value is RecountUnavailableReason {
  return value === 'module_disabled' || value === 'not_permitted';
}

/** The words for why Recount is withheld. A reason this build does not know
 *  (or none) reads as the permission rule, the answer that was always shown. */
export function recountUnavailableCopy(reason: unknown): string {
  return isRecountUnavailableReason(reason) ? RECOUNT_UNAVAILABLE_COPY[reason] : RECOUNT_MANAGER_ONLY_COPY;
}

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
  /**
   * Whether this line re-checks the item (cycle_count_line_rechecks, 0372):
   * once its count is posted it is, or was, the item's latest physical count.
   * False when it was counted before a later count of the item was posted:
   * posting it changes nothing for the exception. Null or absent: unknown
   * (the outcome is then worked out from the numbers alone).
   */
  rechecks?: boolean | null;
}

export type RecountOutcome =
  | { kind: 'in_progress'; counted: number | null; total: number | null }
  | { kind: 'cancelled' }
  /** Posted, but this item's line was never counted, so nothing was applied. */
  | { kind: 'not_counted' }
  | { kind: 'matched'; quantity: number }
  | { kind: 'corrected'; from: number; to: number; delta: number }
  /**
   * The line was counted before a later count of the item was posted, so it
   * does not re-check the item: it is never read as "matched the book".
   */
  | { kind: 'superseded' }
  /** The count or its line could not be read. Never read as "matched". */
  | { kind: 'unavailable' };

/** Why a counted line says nothing new about its item (outcome `superseded`). */
export const RECOUNT_SUPERSEDED_COPY = 'Counted before a later count of this item, so it does not re-check it';

/**
 * What came of a recount for one item, derived at display time from the
 * count and the item's line. A closed count is final (0368), so a completed
 * or cancelled outcome never changes once shown.
 *
 * The line's numbers are what the post applied: counted - expected (0339,
 * 0369). A line whose count matched the book applied nothing.
 *
 * A line that does not re-check the item (`rechecks === false`: counted
 * before a later count of it was posted) is `superseded` while its count is
 * open, and once posted when it applied nothing: "matched the book" would
 * tell the manager the book was confirmed when nobody counted the item after
 * the difference was found. A superseded line that still applied a correction
 * (the ledger allows it when the later count changed nothing) reads as the
 * correction, which is what happened to the stock.
 */
export function recountOutcome(
  count: RecountOutcomeCount | null | undefined,
  line: RecountOutcomeLine | null | undefined,
): RecountOutcome {
  if (!count) return { kind: 'unavailable' };
  switch (count.status) {
    case 'in_progress':
      if (line && line.rechecks === false && quantity(line.countedQuantity) !== null) {
        return { kind: 'superseded' };
      }
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
      if (delta === 0) {
        return line.rechecks === false ? { kind: 'superseded' } : { kind: 'matched', quantity: counted };
      }
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
    case 'superseded':
      return RECOUNT_SUPERSEDED_COPY;
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
 *   - less than the book: taken off the target first (never below zero there,
 *     apply_cycle_count_location_delta), then the rest through
 *     apply_level_delta 'staging_first': Staging first, then the other shelf
 *     locations (racks, areas and crates, Unplaced last); with no target,
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
      return `comes off ${destination.location} first, then Staging, then other shelf locations`;
    case 'off_staging_then_shelves':
      return 'comes off Staging first, then shelf locations';
  }
}

/**
 * The review line for a counted line linked to an exception: the counted and
 * book quantities at count time, the difference, and where it lands, e.g.
 * "Counted 11, book 10 (+1): adds to Rack 12-A". Null when not counted.
 *
 * A line that cannot re-check its item (`rechecks === false`: counted before
 * a later count of it was posted) says so instead of where its difference
 * lands: posting it applies nothing, or is refused as superseded (0369).
 */
export function varianceReviewLine(input: {
  countedQuantity: number | string | null;
  expectedQuantity: number | string | null;
  countedLocation: VarianceDestinationLocation | null;
  rechecks?: boolean | null;
}): string | null {
  const destination = varianceDestination(input);
  if (!destination) return null;
  const counted = quantity(input.countedQuantity)!;
  const expected = quantity(input.expectedQuantity)!;
  const delta = roundQuantity(counted - expected);
  const numbers =
    delta === 0
      ? `Counted ${formatStockQuantity(counted)}, book ${formatStockQuantity(expected)}`
      : `Counted ${formatStockQuantity(counted)}, book ${formatStockQuantity(expected)} (${signedQuantity(delta)})`;
  if (input.rechecks === false) {
    return `${numbers}: ${RECOUNT_SUPERSEDED_COPY.charAt(0).toLowerCase()}${RECOUNT_SUPERSEDED_COPY.slice(1)}`;
  }
  return `${numbers}: ${varianceDestinationCopy(destination)}`;
}

// ── Reading an outcome sent as JSON (the phone) ─────────────────────────────

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A RecountOutcome as the server sent it, checked. Anything this build cannot
 * read (a missing field, a newer kind) is `unavailable`, never "matched": an
 * outcome that cannot be read must not say the book was right.
 */
export function parseRecountOutcome(value: unknown): RecountOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unavailable' };
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case 'in_progress':
      return {
        kind: 'in_progress',
        counted: wholeCount(finiteOrNull(v.counted)),
        total: wholeCount(finiteOrNull(v.total)),
      };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'not_counted':
      return { kind: 'not_counted' };
    case 'matched': {
      const q = finiteOrNull(v.quantity);
      return q === null ? { kind: 'unavailable' } : { kind: 'matched', quantity: q };
    }
    case 'corrected': {
      const from = finiteOrNull(v.from);
      const to = finiteOrNull(v.to);
      const delta = finiteOrNull(v.delta);
      return from === null || to === null || delta === null
        ? { kind: 'unavailable' }
        : { kind: 'corrected', from, to, delta };
    }
    case 'superseded':
      return { kind: 'superseded' };
    default:
      return { kind: 'unavailable' };
  }
}

// ── The words around an occurrence's recount ────────────────────────────────

/** "Recount CC-000031: In progress: 1 of 3 counted" (the active recount). */
export function activeRecountCopy(recount: { countNumber: number | null; outcome: RecountOutcome }): string {
  const ref = formatCycleCountNumber(recount.countNumber);
  return `${ref ? `Recount ${ref}` : 'Recount'}: ${recountOutcomeCopy(recount.outcome)}`;
}

/**
 * One timeline event's headline, with what a closed recount came to:
 * "Recount CC-000031 closed: Matched the book (21)". Every other event reads
 * exactly as core describeOccurrenceEvent words it. The web page and the
 * phone both call this, so a closed recount never reads differently on the two.
 */
export function describeTimelineEvent(event: {
  kind: OccurrenceEventKind;
  actorLabel: string | null;
  cycleCountNumber?: number | null;
  resolvedReason?: OccurrenceResolvedReason | null;
  /** For recount_closed: what that count came to for the item. */
  recountOutcome?: RecountOutcome | null;
}): string {
  const base = describeOccurrenceEvent(event);
  return event.kind === 'recount_closed' && event.recountOutcome
    ? `${base}: ${recountOutcomeCopy(event.recountOutcome)}`
    : base;
}

// ── Who may start one, and when ─────────────────────────────────────────────

/** Why Recount and Count this item are disabled while the phone is offline. */
export const RECOUNT_OFFLINE_COPY = 'You are offline. Starting a recount needs a connection.';

/** The item page's button (web and phone). */
export const COUNT_THIS_ITEM_LABEL = 'Count this item';

/**
 * Whether this reader could start a count at all, as a DISPLAY hint for the
 * phone: the cycle_counts module, cycle_counts:assign and stock:adjust (the
 * effective permissions; the static role defaults while they load), and the
 * manager role. It is the server's assertCountStartFloors as a yes/no (a web
 * test pins the two together); the server and the database re-check every
 * start.
 */
export function countStartAllowed(input: {
  role: Role | null | undefined;
  permissions?: ReadonlySet<Permission>;
  cycleCountsEnabled: boolean;
}): boolean {
  if (!input.role || !input.cycleCountsEnabled) return false;
  const ctx = { role: input.role, permissions: input.permissions };
  return isManagerOrAbove(input.role) && can(ctx, 'cycle_counts:assign') && can(ctx, 'stock:adjust');
}

/**
 * Why a recount cannot be started right now, or null. Permission first: a
 * reader who may not start one is told so even offline, because reconnecting
 * would not change that answer. `unavailableReason` is the server's reason
 * when it withheld Recount (recountUnavailableCopy).
 */
export function recountDisabledReason(input: {
  canRecount: boolean;
  online: boolean;
  unavailableReason?: RecountUnavailableReason | null;
}): string | null {
  if (!input.canRecount) return recountUnavailableCopy(input.unavailableReason);
  if (!input.online) return RECOUNT_OFFLINE_COPY;
  return null;
}

/** The Exceptions list's multi-select button. */
export function recountSelectedLabel(selected: number): string {
  return `Recount selected (${selected})`;
}

/** Why "Recount selected" cannot be pressed for this selection, or null. */
export function recountSelectionProblem(selected: number): string | null {
  if (selected <= 0) return 'Select the exceptions to recount.';
  if (selected > RECOUNT_MAX_ITEMS) {
    return `A recount can include at most ${RECOUNT_MAX_ITEMS} exceptions. Select fewer.`;
  }
  return null;
}

/** The item fields that decide whether it can be counted at all. */
export interface CountableItemFields {
  status?: string | null;
  deleted_at?: string | null;
  is_rental?: boolean | null;
  is_bundle?: boolean | null;
}

/**
 * start_cycle_count's own predicate (0369, D8): an active item that is not
 * deleted, not rental equipment and not a kit. "Count this item" is offered
 * only for such an item; the database skips any other (not_countable).
 */
export function isCountableItem(item: CountableItemFields | null | undefined): boolean {
  return (
    !!item &&
    item.status === 'active' &&
    !item.deleted_at &&
    item.is_rental !== true &&
    item.is_bundle !== true
  );
}

// ── The result panel (web dialog and phone sheet) ───────────────────────────

/** What both surfaces get back from a recount start (the service's result). */
export interface RecountResultInput {
  cycleCountId: string | null;
  countNumber: number | null;
  lineCount: number | null;
  created: boolean;
  replay: boolean;
  assignedTo: string | null;
  assignmentFailed: boolean;
  linkedExisting: ReadonlyArray<{
    cycleCountId: string;
    countNumber: number | null;
    assignedTo: { id: string; label: string | null } | null;
    startedAt: string | null;
    itemIds: readonly string[];
    occurrenceIds: readonly string[];
  }>;
  skipped: ReadonlyArray<{
    itemId: string;
    itemName: string | null;
    reason: RecountSkipReason;
    /** Set when an EXCEPTION was left out (not an item asked for directly). */
    occurrenceId?: string | null;
    /** "EX-000012", when the server could read it. */
    occurrenceReference?: string | null;
  }>;
}

export interface RecountResultSummary {
  /** The count this request started (on a replay: started by its first send). */
  started: { cycleCountId: string; text: string } | null;
  /** Who the started count is assigned to, or that assigning failed. */
  assignment: string | null;
  /** Counts that already held some of the items; they were linked to them. */
  alreadyCounting: Array<{ cycleCountId: string; text: string }>;
  /**
   * "Skipped: Atlas: Rental equipment, kits and archived items are not
   * counted" for an item left out; "Not linked: EX-000012 (Atlas): Already
   * resolved" for an exception left out (its item may still be counted).
   */
  skipped: string[];
  /** Nothing was started and nothing was already being counted. */
  nothing: string | null;
}

/** A replay whose answer names nothing (a server that did not keep the
 *  first answer): never "No count was started". */
export const RECOUNT_REPLAY_UNKNOWN_COPY =
  'This request had already been received. Refresh to see which counts the exceptions were linked to.';

/** The result panel's three groups, worded once for the web and the phone. */
export function recountResultSummary(
  result: RecountResultInput,
  opts: {
    /** The org's time zone, for "open since". */
    timeZone?: string | null;
    /** The chosen assignee's name, when the caller knows it. */
    assigneeLabel?: string | null;
  } = {},
): RecountResultSummary {
  let started: RecountResultSummary['started'] = null;
  if (result.cycleCountId && (result.created || result.replay)) {
    const ref = formatCycleCountNumber(result.countNumber) ?? 'a count';
    const items =
      result.lineCount !== null && Number.isSafeInteger(result.lineCount)
        ? ` (${result.lineCount} item${result.lineCount === 1 ? '' : 's'})`
        : '';
    started = {
      cycleCountId: result.cycleCountId,
      text: result.replay
        ? `Started ${ref}. This request had already been received, so no second count was made.`
        : `Started ${ref}${items}`,
    };
  }

  let assignment: string | null = null;
  if (started) {
    if (result.assignmentFailed) {
      assignment = 'It was started unassigned and nobody was notified. Assign it from the count.';
    } else if (result.assignedTo) {
      const who = opts.assigneeLabel?.trim();
      assignment = who ? `Assigned to ${who}, who gets a notification.` : 'Assigned.';
    } else {
      assignment = 'Not assigned to anyone yet. Assign it from the count.';
    }
  }

  const alreadyCounting = result.linkedExisting.map((e) => {
    const ref = formatCycleCountNumber(e.countNumber) ?? 'another count';
    const who = e.assignedTo ? `assigned to ${e.assignedTo.label?.trim() || 'a team member'}` : 'unassigned';
    const since = e.startedAt
      ? `, open since ${formatOrgDateTime(e.startedAt, { month: 'short', day: 'numeric' }, opts.timeZone ?? undefined)}`
      : '';
    const lead = e.itemIds.length > 1 ? `${e.itemIds.length} items already being counted` : 'Already being counted';
    const linked = e.occurrenceIds.length > 0 ? ', linked' : '';
    return { cycleCountId: e.cycleCountId, text: `${lead} in ${ref} (${who}${since})${linked}` };
  });

  // An exception left out because it is resolved or not recountable says so
  // as the EXCEPTION: its item may still be in the count (asked for directly,
  // or through another exception), so "Skipped: <item>" would contradict
  // "Started CC-..." for the same item. An item that cannot be counted at all
  // is worded as the item, however it was asked for.
  const seen = new Set<string>();
  const skipped: string[] = [];
  for (const s of result.skipped) {
    const name = s.itemName?.trim() || null;
    const exceptionLevel = !!s.occurrenceId && s.reason !== 'not_countable';
    const key = exceptionLevel ? `occ:${s.occurrenceId}` : `${s.itemId}:${s.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (exceptionLevel) {
      const ref = s.occurrenceReference?.trim() || 'An exception';
      skipped.push(`Not linked: ${ref}${name ? ` (${name})` : ''}: ${RECOUNT_SKIP_REASON_COPY[s.reason]}`);
    } else {
      skipped.push(`Skipped: ${name ?? 'An item'}: ${RECOUNT_SKIP_REASON_COPY[s.reason]}`);
    }
  }

  let nothing: string | null = null;
  if (!started && alreadyCounting.length === 0) {
    // A replay answers with the first send's result (0372); one that names
    // nothing at all cannot say what the first send did, so it says that.
    nothing = result.replay && skipped.length === 0 ? RECOUNT_REPLAY_UNKNOWN_COPY : 'No count was started.';
  }

  return { started, assignment, alreadyCounting, skipped, nothing };
}

// ── A count's linked exceptions (the count screens) ─────────────────────────

/** Shown when a count's linked exceptions could not be read. Never "none". */
export const COUNT_LINKED_EXCEPTIONS_UNAVAILABLE_COPY = 'Linked exceptions are unavailable right now.';

/**
 * Shown on the phone for a linked line whose count has not reached the server
 * yet (or changed since the server worked out where it lands): the server
 * decides the counted location when it records the count, so the phone does
 * not guess.
 */
export const VARIANCE_DESTINATION_PENDING_COPY = 'Where the difference lands shows once this count syncs.';
