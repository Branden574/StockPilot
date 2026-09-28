import { offlineCaptureAt } from '../cycle-counts/capture-label';
import { formatCycleCountNumber } from '../cycle-counts/cycle-count-number';
import { isRackShelfLocation } from '../inventory/location-groups';
import { formatHoldingLabel, formatStockQuantity } from '../inventory/stock-writeoff';
import { formatOrgDateTime, resolveOrgTimezone } from '../time/org-timezone';

import { escalationBadgeCopy } from './exception-escalation';
import { recountOutcomeCopy, RECOUNT_MAX_ITEMS } from './exception-recount';
import {
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_RULES,
  formatOccurrenceNumber,
  isExceptionRule,
  roundQuantity,
} from './exceptions';

/**
 * VERIFICATION SUMMARIES (F1-3, migration 0374) — "last physical count" for an
 * item, and for every item held at a location, in words both surfaces share.
 *
 * The facts come from item_verification_summaries: the item's latest physical
 * count (the same source the count_variance rule reads), how many recorded
 * stock movements came after it, how many rows were written outside the stock
 * ledger in that time, and whether an open count holds the item now. The web
 * card, the location page and the phone all word them through this module, so
 * the same item never reads two ways.
 *
 * WHAT THE WORDS NEVER SAY. A count is an observation at a moment, not a
 * guarantee about the shelf now, so nothing here says "verified", "accurate"
 * or "confirmed", and nothing is a percentage or a score. The words state
 * what was recorded and what has happened since, and leave the judgement to
 * the reader. A read that failed says "Couldn't load verification", never
 * "No physical count on record": an error must not read as a fact.
 *
 * WHERE A COUNT WAS TAKEN. The rebase trigger (0342, v2 in 0369) records a
 * counted location only when exactly ONE location outside Staging held the
 * item, and it leaves Staging out of the candidates: stock waiting in Staging
 * does not stop a location being recorded. So the words never say "all of
 * it" was anywhere. A rack, crate, area, shelf or bin reads "was its only
 * shelf location" (Staging is not a shelf, so that is exact); anything else
 * (Unplaced, a Site, a job site) reads "was its only place outside Staging".
 * The split is core's location classifier (isRackShelfLocation, the web's
 * pickers' rule). Staging itself is never recorded (pgTAP 0374 S29), but a
 * line written before 0368 made counted_location_id server-only could name
 * it, so it keeps words of its own that never contradict themselves: "it had
 * stock in Staging", never "Staging was its only place outside Staging".
 */

// ── The shape both surfaces receive ─────────────────────────────────────────

/** A person as the reader can see them. `label` null: not named in this
 *  answer (the words then leave the person out rather than guess). */
export interface VerificationPerson {
  id: string | null;
  label: string | null;
}

/** The item's facts the words depend on, as they are NOW. */
export interface VerificationItemFacts {
  /** inventory_items.status: active | archived | discontinued. */
  status: string | null;
  isRental: boolean;
  isBundle: boolean;
  /** Soft-deleted. */
  deleted: boolean;
  /** start_cycle_count's own predicate: active, not deleted, not rental
   *  equipment, not a kit. */
  countable: boolean;
  quantityOnHand: number | null;
}

/** The item's latest physical count (_latest_count_lines, 0372). */
export interface VerificationLastCount {
  cycleCountId: string;
  countNumber: number | null;
  /** When the count was posted. */
  completedAt: string | null;
  /** When the line was recorded on the server (an offline count: its sync). */
  countedAt: string | null;
  /** When the phone took it, for a count recorded offline. */
  capturedAt: string | null;
  /** The moment the line's book quantity is true for (0369). */
  baselineAt: string | null;
  /** The book when counted. */
  expectedQuantity: number | null;
  /** The book when the count started; null for a line from before 0339. */
  expectedAtStart: number | null;
  countedQuantity: number | null;
  /** The location the count was attributed to: the item's only holding
   *  OUTSIDE Staging when it was counted (0342, 0369; Staging may also have
   *  held some). Null: not recorded. */
  countedLocationId: string | null;
  /** Its name, kind and type now (type: a Site's "jobsite", a rack's
   *  "shelf"; null from a server that does not send it). */
  countedLocation: {
    name: string | null;
    kind: string | null;
    type: string | null;
    archived: boolean;
  } | null;
  aiAssisted: boolean;
  countedBy: VerificationPerson | null;
  postedBy: VerificationPerson | null;
}

export interface ItemVerificationSummary {
  itemId: string;
  item: VerificationItemFacts;
  /** Null: never counted (a stated answer, not a failed read). */
  lastCount: VerificationLastCount | null;
  /** Recorded stock movements after the count's moment, its own correction
   *  excluded. Null when never counted, or when the count has no moment. */
  movementsSince: number | null;
  /** Rows written outside the stock ledger in the same window. */
  outsideLedgerSince: number | null;
  /** The newest in-progress count holding the item. */
  openCount: { cycleCountId: string; countNumber: number | null } | null;
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** A failed read. Never "never counted". */
export const VERIFICATION_UNAVAILABLE_COPY = "Couldn't load verification";
export const VERIFICATION_NEVER_COUNTED_COPY = 'No physical count on record.';
export const VERIFICATION_ITEM_TOTAL_SCOPE_COPY =
  'Item total counted. Which locations were checked was not recorded.';
export const VERIFICATION_AI_ASSISTED_COPY = 'Recorded with AI shelf-scan assistance';
export const VERIFICATION_MOVEMENTS_UNKNOWN_COPY = 'Stock movements since this count are not known';
export const VERIFICATION_COUNT_ACTION_LABEL = 'Count this item';

/** Why an item is not cycle counted (start_cycle_count skips it). */
export type VerificationNotCountableReason =
  'deleted' | 'rental_or_kit' | 'archived' | 'discontinued';

export const VERIFICATION_NOT_COUNTABLE_COPY: Record<VerificationNotCountableReason, string> = {
  deleted: 'Deleted',
  rental_or_kit: 'Rental equipment and kits are not cycle counted',
  archived: 'Archived',
  discontinued: 'Discontinued',
};

/** Why this item cannot be counted, or null when it can. */
export function verificationNotCountableReason(
  item: Pick<VerificationItemFacts, 'status' | 'isRental' | 'isBundle' | 'deleted' | 'countable'>,
): VerificationNotCountableReason | null {
  if (item.deleted) return 'deleted';
  if (item.isRental || item.isBundle) return 'rental_or_kit';
  if (item.status === 'archived') return 'archived';
  if (item.status === 'discontinued') return 'discontinued';
  // Any other reason the server gave (a newer status): not countable, said as
  // archived rather than offering a count the server would skip.
  return item.countable ? null : 'archived';
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const DAY_TIME_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

function validIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** The moment the count is true for: its baseline, else when it was recorded,
 *  else when it was posted. */
function countMoment(count: VerificationLastCount): string | null {
  return validIso(count.baselineAt) ?? validIso(count.countedAt) ?? validIso(count.completedAt);
}

/** "Sep 12, 2026" in the org's zone. */
function countDate(count: VerificationLastCount, timeZone: string): string | null {
  const at = countMoment(count);
  return at ? formatOrgDateTime(at, DATE_OPTS, timeZone) : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Two ids as uuids: a link or a typed URL may carry upper case, and the
 *  database answers in lower case. */
function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** "Matched the stock on record (10)", "Stock on record corrected from 8 to 10
 *  (+2)", or, for a line from before 0339 (no book at count time was kept),
 *  "Counted 10". */
export function verificationResultCopy(count: VerificationLastCount): string | null {
  const counted = finite(count.countedQuantity);
  if (counted === null) return null;
  const expected = finite(count.expectedQuantity);
  if (count.expectedAtStart === null || expected === null) {
    return `Counted ${formatStockQuantity(counted)}`;
  }
  const delta = roundQuantity(counted - expected);
  return delta === 0
    ? recountOutcomeCopy({ kind: 'matched', quantity: counted })
    : recountOutcomeCopy({ kind: 'corrected', from: expected, to: counted, delta });
}

/** The counted location as a label ("17-B"; "Staging"), or null. */
function countedLocationLabel(count: VerificationLastCount): string | null {
  const name = count.countedLocation?.name?.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return formatHoldingLabel(count.countedLocation?.kind ?? null, name);
}

/** Whether a location reads as a "shelf location": a rack, crate, area,
 *  shelf or bin (core isRackShelfLocation). Unplaced, a Site and anything
 *  unknown are not. */
function isShelfLocation(
  kind: string | null | undefined,
  type: string | null | undefined,
): boolean {
  return isRackShelfLocation({ kind: kind ?? null, type: type ?? null });
}

/**
 * The counted location as a clause, true to what the trigger recorded (the
 * item's only holding outside Staging; Staging may also have held some):
 *   - a rack, crate, area, shelf or bin: "17-B was its only shelf location";
 *   - Unplaced: "Unplaced was its only place outside Staging, on no rack";
 *   - a Site, a job site, anything else: "Job site was its only place outside
 *     Staging" (a Site is not a shelf).
 * Never "all of it": part of the stock may have been in Staging. Staging is
 * never recorded (the trigger leaves it out of the candidates, and
 * counted_location_id is not client-writable, 0368; pgTAP 0374 pins both).
 * A line from before 0368 that names Staging anyway says only what it can
 * mean: "it had stock in Staging".
 */
function countedWhereClause(count: VerificationLastCount): string {
  const loc = count.countedLocation;
  if (loc?.kind === 'staging') return 'it had stock in Staging';
  if (loc?.kind === 'unplaced') return 'Unplaced was its only place outside Staging, on no rack';
  const label = countedLocationLabel(count);
  if (!label) return 'a location, since removed, was its only place outside Staging';
  return isShelfLocation(loc?.kind, loc?.type)
    ? `${label} was its only shelf location`
    : `${label} was its only place outside Staging`;
}

/** What the count covered: the item's only location outside Staging when one
 *  was recorded (countedWhereClause), else the item's total with the
 *  locations unrecorded. */
export function verificationScopeCopy(count: VerificationLastCount): string {
  if (!count.countedLocationId) return VERIFICATION_ITEM_TOTAL_SCOPE_COPY;
  return `Counted while ${countedWhereClause(count)}`;
}

/** "Counted by A, posted by B." A person not named in the answer is left out. */
export function verificationWhoCopy(count: VerificationLastCount): string | null {
  const counter = count.countedBy?.label?.trim() || null;
  const poster = count.postedBy?.label?.trim() || null;
  const same =
    counter !== null &&
    poster !== null &&
    count.countedBy?.id != null &&
    count.countedBy.id === count.postedBy?.id;
  if (same) return `Counted and posted by ${counter}.`;
  if (counter && poster) return `Counted by ${counter}, posted by ${poster}.`;
  if (counter) return `Counted by ${counter}.`;
  if (poster) return `Posted by ${poster}.`;
  return null;
}

/**
 * "Taken 10:02 AM on the device, synced 10:40 AM" for a count recorded
 * offline and synced later (the same rule as the review row's "Counted
 * offline": a capture within two minutes of the record is an online count and
 * says nothing). Dates are added when the two moments fall on different days.
 */
export function verificationCaptureCopy(
  count: VerificationLastCount,
  timeZone: string,
): string | null {
  const captured = offlineCaptureAt({ captured_at: count.capturedAt, counted_at: count.countedAt });
  if (!captured) return null;
  const synced = validIso(count.countedAt);
  if (!synced) return `Taken ${formatOrgDateTime(captured, DAY_TIME_OPTS, timeZone)} on the device`;
  const sameDay =
    formatOrgDateTime(captured, DATE_OPTS, timeZone) ===
    formatOrgDateTime(synced, DATE_OPTS, timeZone);
  const opts = sameDay ? TIME_OPTS : DAY_TIME_OPTS;
  return `Taken ${formatOrgDateTime(captured, opts, timeZone)} on the device, synced ${formatOrgDateTime(synced, opts, timeZone)}`;
}

/** "3 recorded stock movements since" (the Movements tab lists them). */
export function verificationMovementsCopy(n: number | null): string | null {
  if (n === null || !Number.isSafeInteger(n) || n < 0) return null;
  return `${n} recorded stock movement${n === 1 ? '' : 's'} since`;
}

/** "2 recorded outside the stock ledger", only when there are any. */
export function verificationOutsideLedgerCopy(n: number | null): string | null {
  if (n === null || !Number.isSafeInteger(n) || n <= 0) return null;
  return `${n} recorded outside the stock ledger`;
}

/** "Being counted in CC-000045". */
export function verificationBeingCountedCopy(countNumber: number | null): string {
  const ref = formatCycleCountNumber(countNumber);
  return ref ? `Being counted in ${ref}` : 'Being counted in an open count';
}

export type VerificationSummaryState = 'unavailable' | 'never_counted' | 'counted';

export interface VerificationSummaryCopy {
  state: VerificationSummaryState;
  /** "Couldn't load verification" / "No physical count on record." /
   *  "Last physical count: Sep 12, 2026 · CC-000031". */
  headline: string;
  /** The count the headline names (a link to it), when there is one. */
  countId: string | null;
  result: string | null;
  scope: string | null;
  who: string | null;
  capture: string | null;
  aiAssisted: string | null;
  /** Links to the item's Movements tab. */
  movementsSince: string | null;
  outsideLedger: string | null;
  /** "On record now: 12". */
  onRecordNow: string | null;
  beingCounted: { text: string; cycleCountId: string } | null;
  notCountable: string | null;
  /** "Count this item", for a reader who may start a count of a countable item. */
  countAction: string | null;
  /** Every line above, in display order (the headline first). */
  lines: string[];
}

function assemble(copy: Omit<VerificationSummaryCopy, 'lines'>): VerificationSummaryCopy {
  const lines = [
    copy.headline,
    copy.result,
    copy.scope,
    copy.who,
    copy.capture,
    copy.aiAssisted,
    copy.movementsSince,
    copy.outsideLedger,
    copy.onRecordNow,
    copy.beingCounted?.text ?? null,
    copy.notCountable,
    copy.countAction,
  ].filter((l): l is string => typeof l === 'string' && l !== '');
  return { ...copy, lines };
}

/**
 * The whole summary in words, for the item card (web and phone) and the
 * occurrence detail. `summary` null or undefined is a failed read.
 *
 * `canCount`: the reader may start a count (core countStartAllowed, or the
 * server's canCount). "Count this item" is offered only then, and only for an
 * item that can be counted.
 */
export function verificationSummaryCopy(
  summary: ItemVerificationSummary | null | undefined,
  opts: { timeZone?: string | null; canCount?: boolean } = {},
): VerificationSummaryCopy {
  const empty = {
    countId: null,
    result: null,
    scope: null,
    who: null,
    capture: null,
    aiAssisted: null,
    movementsSince: null,
    outsideLedger: null,
    onRecordNow: null,
    beingCounted: null,
    notCountable: null,
    countAction: null,
  };
  if (!summary) {
    return assemble({ state: 'unavailable', headline: VERIFICATION_UNAVAILABLE_COPY, ...empty });
  }
  const timeZone = resolveOrgTimezone(opts.timeZone);
  const reason = verificationNotCountableReason(summary.item);
  const notCountable = reason ? VERIFICATION_NOT_COUNTABLE_COPY[reason] : null;
  const countAction =
    opts.canCount === true && reason === null ? VERIFICATION_COUNT_ACTION_LABEL : null;
  const beingCounted = summary.openCount
    ? {
        text: verificationBeingCountedCopy(summary.openCount.countNumber),
        cycleCountId: summary.openCount.cycleCountId,
      }
    : null;

  const count = summary.lastCount;
  if (!count) {
    return assemble({
      ...empty,
      state: 'never_counted',
      headline: VERIFICATION_NEVER_COUNTED_COPY,
      beingCounted,
      notCountable,
      countAction,
    });
  }

  const date = countDate(count, timeZone);
  const ref = formatCycleCountNumber(count.countNumber);
  const headline = `Last physical count${date || ref ? ': ' : ''}${[date, ref].filter(Boolean).join(' · ')}`;
  const onHand = finite(summary.item.quantityOnHand);
  return assemble({
    state: 'counted',
    headline,
    countId: count.cycleCountId,
    result: verificationResultCopy(count),
    scope: verificationScopeCopy(count),
    who: verificationWhoCopy(count),
    capture: verificationCaptureCopy(count, timeZone),
    aiAssisted: count.aiAssisted ? VERIFICATION_AI_ASSISTED_COPY : null,
    movementsSince:
      summary.movementsSince === null
        ? VERIFICATION_MOVEMENTS_UNKNOWN_COPY
        : verificationMovementsCopy(summary.movementsSince),
    outsideLedger: verificationOutsideLedgerCopy(summary.outsideLedgerSince),
    onRecordNow: onHand === null ? null : `On record now: ${formatStockQuantity(onHand)}`,
    beingCounted,
    notCountable,
    countAction,
  });
}

// ── Open issues ─────────────────────────────────────────────────────────────

/** An open exception about the item (or at the location) as a chip. */
export interface VerificationIssue {
  id: string;
  number: number | null;
  rule: string;
  locationId: string | null;
  /** The maintenance request it was escalated to (F1-5): its handle, and
   *  whether it was cancelled (null: not known). Absent or null when it was
   *  never escalated. */
  escalation?: { reference: string | null; cancelled: boolean | null } | null;
}

/** "EX-000042 · Count did not match the stock on record", and, for an
 *  escalated exception, " · Escalated: MR-2026-000014" in the words every
 *  other surface uses (core escalationBadgeCopy). A rule this build does not
 *  know reads as its reference alone. */
export function verificationIssueChipCopy(
  issue: Pick<VerificationIssue, 'number' | 'rule' | 'escalation'>,
): string {
  const ref = formatOccurrenceNumber(issue.number) ?? 'Open exception';
  const base = isExceptionRule(issue.rule) ? `${ref} · ${EXCEPTION_RULES[issue.rule].label}` : ref;
  return issue.escalation
    ? `${base} · ${escalationBadgeCopy(issue.escalation.reference, issue.escalation.cancelled)}`
    : base;
}

// ── The location page ───────────────────────────────────────────────────────

/** Shown instead of the holdings when the reader's warehouses do not cover
 *  the location (item_stock_levels RLS hides every holding there). Never
 *  "nothing here". */
export const LOCATION_HOLDINGS_OUT_OF_SCOPE_COPY =
  'Stock at this location is in a warehouse you are not assigned to, so it is not listed here.';

/** A location page row: what the item's latest count says about THIS place. */
export interface LocationRowVerificationCopy {
  /** "Counted Sep 12, 2026, while this was its only shelf location" (a Site
   *  or Unplaced: "...its only place outside Staging") / "Item total counted
   *  Sep 12, 2026, location not recorded" / "Not counted" / "Couldn't load
   *  verification". */
  count: string;
  movementsSince: string | null;
  beingCounted: { text: string; cycleCountId: string } | null;
  notCountable: string | null;
}

export function locationRowVerificationCopy(
  summary: ItemVerificationSummary | null | undefined,
  locationId: string,
  opts: {
    timeZone?: string | null;
    /** The page's location kind and type: only a rack, crate, area, shelf or
     *  bin is a "shelf location"; a count recorded at Unplaced or a Site reads
     *  "while this was its only place outside Staging". */
    locationKind?: string | null;
    locationType?: string | null;
  } = {},
): LocationRowVerificationCopy {
  if (!summary) {
    return {
      count: VERIFICATION_UNAVAILABLE_COPY,
      movementsSince: null,
      beingCounted: null,
      notCountable: null,
    };
  }
  const timeZone = resolveOrgTimezone(opts.timeZone);
  const reason = verificationNotCountableReason(summary.item);
  const notCountable = reason ? VERIFICATION_NOT_COUNTABLE_COPY[reason] : null;
  const beingCounted = summary.openCount
    ? {
        text: verificationBeingCountedCopy(summary.openCount.countNumber),
        cycleCountId: summary.openCount.cycleCountId,
      }
    : null;
  const count = summary.lastCount;
  if (!count) return { count: 'Not counted', movementsSince: null, beingCounted, notCountable };

  const date = countDate(count, timeZone);
  const when = date ? ` ${date},` : '';
  let text: string;
  if (count.countedLocationId && sameId(count.countedLocationId, locationId)) {
    // The Staging page: never recorded by the trigger (see countedWhereClause).
    text =
      opts.locationKind === 'staging'
        ? `Counted${when} while it had stock here`
        : isShelfLocation(opts.locationKind, opts.locationType)
          ? `Counted${when} while this was its only shelf location`
          : `Counted${when} while this was its only place outside Staging`;
  } else if (count.countedLocationId) {
    text = `Item total counted${when} while ${countedWhereClause(count)}`;
  } else {
    text = `Item total counted${when} location not recorded`;
  }
  return {
    count: text,
    movementsSince:
      summary.movementsSince === null
        ? VERIFICATION_MOVEMENTS_UNKNOWN_COPY
        : verificationMovementsCopy(summary.movementsSince),
    beingCounted,
    notCountable,
  };
}

/** The totals across EVERY row of a location (never just the page shown). */
export interface LocationVerificationTotals {
  /** Rows the reader can open. */
  items: number;
  /** Units here across those rows. */
  quantity: number;
  /** Latest count recorded this location as the item's only location
   *  outside Staging. */
  countedHere: number;
  /** Counted, with the location unrecorded or another one. */
  countedItemTotal: number;
  notCounted: number;
  /** Rows whose summary could not be read. */
  unavailable: number;
  /** Holdings here of items the reader cannot open. */
  hiddenItems: number;
  hiddenQuantity: number;
  /** Rows whose item can be counted ("Recount items here" counts these). */
  countable: number;
}

/** Totals from every row: what the page's totals line reads. */
export function locationVerificationTotals(
  rows: ReadonlyArray<{ quantity: number; summary: ItemVerificationSummary | null }>,
  locationId: string,
  hidden: { items: number; quantity: number } = { items: 0, quantity: 0 },
): LocationVerificationTotals {
  const t: LocationVerificationTotals = {
    items: 0,
    quantity: 0,
    countedHere: 0,
    countedItemTotal: 0,
    notCounted: 0,
    unavailable: 0,
    hiddenItems: hidden.items,
    hiddenQuantity: roundQuantity(hidden.quantity),
    countable: 0,
  };
  for (const row of rows) {
    t.items += 1;
    t.quantity = roundQuantity(t.quantity + (finite(row.quantity) ?? 0));
    const s = row.summary;
    if (!s) {
      t.unavailable += 1;
      continue;
    }
    if (s.item.countable) t.countable += 1;
    if (!s.lastCount) t.notCounted += 1;
    else if (sameId(s.lastCount.countedLocationId, locationId)) t.countedHere += 1;
    else t.countedItemTotal += 1;
  }
  return t;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function units(q: number): string {
  return `${formatStockQuantity(q)} ${q === 1 ? 'unit' : 'units'}`;
}

/** "12 items, 340 units here. 5 counted while this was their only shelf
 *  location, 4 item totals counted, 3 not counted."
 *
 *  `locationKind` / `locationType`: the page's location. Only a rack, crate,
 *  area, shelf or bin is a shelf location (the same rule as
 *  locationRowVerificationCopy); at Unplaced or a Site the count reads
 *  "counted while this was its (their) only place outside Staging", and on
 *  the Staging page (never recorded by the trigger) "while it (they) had
 *  stock here". */
export function locationVerificationTotalsCopy(
  t: LocationVerificationTotals,
  opts: { locationKind?: string | null; locationType?: string | null } = {},
): string {
  const head = `${plural(t.items, 'item', 'items')}, ${units(t.quantity)} here.`;
  const parts: string[] = [];
  if (t.countedHere > 0) {
    const one = t.countedHere === 1;
    const whose = one ? 'its' : 'their';
    parts.push(
      // The Staging page: never recorded by the trigger (see countedWhereClause).
      opts.locationKind === 'staging'
        ? `${t.countedHere} counted while ${one ? 'it' : 'they'} had stock here`
        : isShelfLocation(opts.locationKind, opts.locationType)
          ? `${t.countedHere} counted while this was ${whose} only shelf location`
          : `${t.countedHere} counted while this was ${whose} only place outside Staging`,
    );
  }
  if (t.countedItemTotal > 0)
    parts.push(`${plural(t.countedItemTotal, 'item total', 'item totals')} counted`);
  if (t.notCounted > 0) parts.push(`${t.notCounted} not counted`);
  if (t.unavailable > 0) parts.push(`${t.unavailable} could not be loaded`);
  let text = parts.length > 0 ? `${head} ${parts.join(', ')}.` : head;
  if (t.hiddenItems > 0) {
    const one = t.hiddenItems === 1;
    text += ` ${plural(t.hiddenItems, 'more item', 'more items')} here (${units(t.hiddenQuantity)}) ${one ? 'is' : 'are'} not listed because you cannot open ${one ? 'it' : 'them'}.`;
  }
  return text;
}

/** Holdings read for one location page. Far above any real location;
 *  reaching it is disclosed (LOCATION_HOLDINGS_TRUNCATED_COPY), never silent. */
export const LOCATION_HOLDINGS_CAP = 20_000;

/** "20,000" without depending on the runtime's Intl data. */
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The holdings read stopped at LOCATION_HOLDINGS_CAP: the totals are partial. */
export const LOCATION_HOLDINGS_TRUNCATED_COPY = `Only the first ${withThousands(LOCATION_HOLDINGS_CAP)} holdings here were read, so these totals are partial.`;

/** Why "Recount items here" cannot be pressed, or null. Permission first
 *  (core recountDisabledReason words that), then a partial read (`truncated`:
 *  the items past the cap were never read, so no recount can claim to cover
 *  the location), then the item count. */
export function locationRecountProblem(
  countable: number,
  opts: { truncated?: boolean } = {},
): string | null {
  if (opts.truncated === true) return LOCATION_HOLDINGS_TRUNCATED_COPY;
  if (countable <= 0) return 'Nothing here can be counted.';
  if (countable > RECOUNT_MAX_ITEMS) {
    return `A recount can include at most ${RECOUNT_MAX_ITEMS} items, and ${countable} items here can be counted. Count this location from Cycle Counts instead.`;
  }
  return null;
}

/**
 * Why "Recount items here" cannot be pressed on a location page the server
 * answered, on the web and the phone alike: the server's recountProblem when
 * it sent one, else the same rule applied to the page (a partial holdings
 * read, then the item count). Permission is the caller's (canRecount).
 */
export function locationRecountProblemOf(v: {
  recountProblem: string | null;
  truncated: boolean;
  totals: Pick<LocationVerificationTotals, 'countable'> | null;
}): string | null {
  return (
    v.recountProblem ?? locationRecountProblem(v.totals?.countable ?? 0, { truncated: v.truncated })
  );
}

export const LOCATION_RECOUNT_LABEL = 'Recount items here';

// ── "Open issues here" with no chips ────────────────────────────────────────

/** None recorded, after a check has run, for a reader who sees everything
 *  here. */
export const LOCATION_NO_OPEN_ISSUES_COPY = 'No open exceptions are recorded at this location.';

/** None the reader can see, while items here are hidden from them
 *  (totals.hiddenItems > 0): exceptions about those items are hidden too. */
export const LOCATION_NO_VISIBLE_OPEN_ISSUES_COPY =
  'No open exceptions you can see are recorded here.';

/** The reader's warehouses do not cover the location: exception_occurrences
 *  RLS hides every exception here (0370 _exc_occurrence_visible, the same
 *  location clause as location_holdings_visible). Never "none recorded". */
export const LOCATION_OPEN_ISSUES_OUT_OF_SCOPE_COPY =
  'This location is in a warehouse you are not assigned to, so its open exceptions are not listed here.';

export type LocationOpenIssuesEmpty =
  /** The reader cannot see exceptions here at all. */
  | { kind: 'out_of_scope'; text: string }
  /** The org's first check has not run: nothing is known yet. */
  | { kind: 'first_check_pending'; text: string }
  /** A check has run and nothing the reader can see is open here. */
  | { kind: 'none'; text: string };

/**
 * What "Open issues here" says when there are no chips to show, on the web
 * and the phone alike. The exceptions are read under the reader's RLS, so an
 * empty list is only "none recorded" when nothing here is hidden from them:
 *   - out of the reader's warehouses (holdingsVisible false): says so;
 *   - before the org's first check: that it has not run;
 *   - items here the reader cannot open (hiddenItems > 0): "none you can see";
 *   - otherwise: none recorded at this location.
 */
export function locationOpenIssuesEmptyCopy(v: {
  holdingsVisible: boolean;
  /** totals.hiddenItems (0 when there are no totals). */
  hiddenItems: number;
  checkedAt: string | null;
}): LocationOpenIssuesEmpty {
  if (!v.holdingsVisible)
    return { kind: 'out_of_scope', text: LOCATION_OPEN_ISSUES_OUT_OF_SCOPE_COPY };
  if (v.checkedAt === null) {
    return { kind: 'first_check_pending', text: EXCEPTION_FIRST_CHECK_PENDING_COPY };
  }
  return v.hiddenItems > 0
    ? { kind: 'none', text: LOCATION_NO_VISIBLE_OPEN_ISSUES_COPY }
    : { kind: 'none', text: LOCATION_NO_OPEN_ISSUES_COPY };
}

// ── A refused read (the same words on the web and the phone) ────────────────

export type VerificationSubject = 'item' | 'location';

/** Why the server refused a verification read (never a failed read: that is
 *  VERIFICATION_UNAVAILABLE_COPY with "try again"). */
export type VerificationRefusal =
  'not_found' | 'forbidden' | 'aal2_required' | 'mfa_required' | 'invalid_id';

/** The refusal an app-authored error names (its code and details.reason), or
 *  null for anything else (a failed read). */
export function verificationRefusalOf(code: unknown, reason: unknown): VerificationRefusal | null {
  if (code === 'not_found') return 'not_found';
  if (code === 'validation_error') return 'invalid_id';
  if (code === 'forbidden') {
    if (reason === 'aal2_required') return 'aal2_required';
    if (reason === 'mfa_required') return 'mfa_required';
    return 'forbidden';
  }
  return null;
}

/** The sentence under "Couldn't load verification" for a refusal. */
export function verificationRefusalCopy(
  refusal: VerificationRefusal,
  subject: VerificationSubject,
): string {
  switch (refusal) {
    case 'not_found':
      return subject === 'item'
        ? 'This item is not available to you, or it no longer exists.'
        : 'This location is not available to you, or it no longer exists.';
    case 'forbidden':
      return 'You do not have permission to see this.';
    case 'aal2_required':
      return 'Your account uses an authenticator app, and this session did not sign in with it. Sign out and sign back in with your code to see this.';
    case 'mfa_required':
      return 'Your organization requires two-factor authentication. Set it up on the web, then sign in again.';
    case 'invalid_id':
      return 'This link is not valid.';
  }
}

/** A verification route's 401 `message`, and what the phone says for it. */
export const VERIFICATION_SESSION_ENDED_COPY = 'Your session has ended. Sign in again.';

// ── Reading a summary sent as JSON (the phone) ──────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}
function person(v: unknown): VerificationPerson | null {
  if (!isObj(v)) return null;
  return { id: str(v.id), label: str(v.label) };
}

/**
 * An ItemVerificationSummary as the server sent it, checked. Anything this
 * build cannot read is null, which the words render as "Couldn't load
 * verification", never as "never counted": a malformed count must not read as
 * no count.
 */
export function parseItemVerificationSummary(value: unknown): ItemVerificationSummary | null {
  if (!isObj(value) || typeof value.itemId !== 'string' || !isObj(value.item)) return null;
  const it = value.item;
  if (
    typeof it.isRental !== 'boolean' ||
    typeof it.isBundle !== 'boolean' ||
    typeof it.deleted !== 'boolean' ||
    typeof it.countable !== 'boolean'
  ) {
    return null;
  }
  const item: VerificationItemFacts = {
    status: str(it.status),
    isRental: it.isRental,
    isBundle: it.isBundle,
    deleted: it.deleted,
    countable: it.countable,
    quantityOnHand: num(it.quantityOnHand),
  };

  let lastCount: VerificationLastCount | null = null;
  if (value.lastCount !== null) {
    const c = value.lastCount;
    if (!isObj(c) || typeof c.cycleCountId !== 'string' || typeof c.aiAssisted !== 'boolean')
      return null;
    const loc = c.countedLocation;
    lastCount = {
      cycleCountId: c.cycleCountId,
      countNumber: int(c.countNumber),
      completedAt: str(c.completedAt),
      countedAt: str(c.countedAt),
      capturedAt: str(c.capturedAt),
      baselineAt: str(c.baselineAt),
      expectedQuantity: num(c.expectedQuantity),
      expectedAtStart: num(c.expectedAtStart),
      countedQuantity: num(c.countedQuantity),
      countedLocationId: str(c.countedLocationId),
      countedLocation: isObj(loc)
        ? {
            name: str(loc.name),
            kind: str(loc.kind),
            type: str(loc.type),
            archived: loc.archived === true,
          }
        : null,
      aiAssisted: c.aiAssisted,
      countedBy: person(c.countedBy),
      postedBy: person(c.postedBy),
    };
    // A counted line without a counted number is not one this build can word.
    if (lastCount.countedQuantity === null) return null;
  }

  const oc = value.openCount;
  const openCount =
    isObj(oc) && typeof oc.cycleCountId === 'string'
      ? { cycleCountId: oc.cycleCountId, countNumber: int(oc.countNumber) }
      : null;
  const movementsSince = value.movementsSince === null ? null : int(value.movementsSince);
  const outsideLedgerSince =
    value.outsideLedgerSince === null ? null : int(value.outsideLedgerSince);
  // A count with an unreadable movements number is unknown, which the words
  // say; a present-but-garbled number is not read as 0.
  return {
    itemId: value.itemId,
    item,
    lastCount,
    movementsSince: movementsSince !== null && movementsSince >= 0 ? movementsSince : null,
    outsideLedgerSince:
      outsideLedgerSince !== null && outsideLedgerSince >= 0 ? outsideLedgerSince : null,
    openCount,
  };
}
