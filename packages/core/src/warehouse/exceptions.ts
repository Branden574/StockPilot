import { formatStockQuantity } from '../inventory/stock-writeoff';

/**
 * WAREHOUSE EXCEPTIONS — the shared vocabulary for "something is quietly wrong".
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT A TASK QUEUE ═══
 *
 * Measured 2026-08-20: this warehouse has no backlog. One order in flight, five
 * hours old; nothing sitting in a non-terminal status; staging cleared inside
 * two days. Work arrives and gets done.
 *
 * What it has instead is undetected wrongness. On the same day, hand-written
 * SQL found 49 units unplaced for 55 days, two items whose printed label names
 * a rack holding none of their stock, and — for four weeks before anyone
 * noticed — 22 units sitting on a rack number the floor does not have.
 *
 * None of that was ever assigned to somebody and forgotten. A work queue
 * answers "who does what next", which is not the question. These are conditions
 * that are simply WRONG and that nothing surfaces. This module is the
 * vocabulary for surfacing them.
 *
 * EVERY RULE MUST BE ACTIONABLE. A rule that a reader cannot act on is a metric,
 * and metrics belong in reports. If the honest response to a row is "noted",
 * it does not go here — that is how an exception screen becomes a wall of noise
 * people stop opening, at which point it is worse than not existing.
 */

/**
 * Two levels, deliberately. A third ("info", "review") is where un-actionable
 * rows get filed to avoid deleting them, and the pile then trains people to
 * skim the whole screen.
 */
export type ExceptionSeverity = 'critical' | 'warning';

export type ExceptionRule =
  /** Positive stock on a location that has been archived. Counted, unreachable. */
  | 'orphaned_stock'
  /** More units promised to open orders than exist. A promise that cannot be kept. */
  | 'over_reserved'
  /** Received stock still in Staging well past a normal put-away. */
  | 'stale_staging'
  /** On hand, on no rack, for long enough that nobody is coming back for it. */
  | 'long_unplaced'
  /**
   * The item's printed label names somewhere its stock is not.
   *
   * Covers two shapes that production actually holds and that hurt identically:
   * a label naming the WRONG bay ("40-C" while the stock sits on 39-C), and a
   * label naming NO bay at all ("Bin"). A pick slip reading "Bin" routes a
   * picker exactly as well as one reading the wrong number — which is to say,
   * not at all — so both belong under one heading.
   */
  | 'label_mismatch';

/**
 * What a reader can do about a row, as a kind the web page and the phone each
 * turn into their own link or button. Nothing here writes stock: every
 * correction is an ordinary put-away, label edit or count.
 *
 *   open_item  — the item page (move, restore, write off, see reservations);
 *   put_away   — the Staging put-away worklist;
 *   edit_label — the item's label field.
 */
export type ExceptionActionKind = 'open_item' | 'put_away' | 'edit_label';

export interface ExceptionRuleMeta {
  rule: ExceptionRule;
  severity: ExceptionSeverity;
  /** Group heading. Plural, because a group with one row still reads correctly. */
  label: string;
  /** What a reader should DO. Shown once per group, not per row. */
  action: string;
  /**
   * Neutral possibilities for how a row like this comes about, so a reader
   * knows where to look first. Process and record-keeping causes only: an
   * explanation never names or implies a person (the test suite refuses
   * wording about employees, staff or theft).
   */
  explanations: readonly string[];
  /** "What clears this": the condition that resolves the row on the next check. */
  clearedBy: string;
  /** The actions offered for a row, most useful first. */
  actions: readonly ExceptionActionKind[];
  /**
   * Whether an item-level recount is the right tool (F1-2 offers it). Holding
   * rules are never recountable: a count records the item's total, and a
   * negative difference comes off the counted rack first, so recounting a
   * Staging or archived-location holding can correct the wrong place.
   */
  recountable: boolean;
}

export const EXCEPTION_RULES: Record<ExceptionRule, ExceptionRuleMeta> = {
  orphaned_stock: {
    rule: 'orphaned_stock',
    severity: 'critical',
    label: 'Stock in an archived location',
    action:
      'These units still count toward on hand but the place they name is hidden from every picker, transfer and export. Move them to a live location.',
    explanations: [
      'The location was archived before its stock was moved out.',
      'The stock was moved elsewhere without a transfer being recorded, so the archived location still carries it.',
    ],
    clearedBy:
      'Clears when the archived location holds none of this item: move the units to a live location, restore the location, or record a count.',
    actions: ['open_item'],
    recountable: false,
  },
  over_reserved: {
    rule: 'over_reserved',
    severity: 'critical',
    label: 'Promised more than is owned',
    action:
      'Open orders reserve more units than exist. At least one cannot be filled from stock — release a reservation or receive more.',
    explanations: [
      'Stock was written off, counted down or transferred after the orders reserved it.',
      'Orders were approved against stock that had not been received yet.',
      'A reservation was not released when its order finished or was cancelled.',
    ],
    clearedBy:
      'Clears when open reservations no longer exceed the quantity on hand: more stock is received, a reservation is released, or a count corrects the on-hand quantity.',
    actions: ['open_item'],
    recountable: true,
  },
  stale_staging: {
    rule: 'stale_staging',
    severity: 'warning',
    label: 'Sitting in Staging',
    action: 'Received but never put away. Place it on a rack so pickers can find it.',
    explanations: [
      'The stock was received but the put-away was not recorded.',
      'It was shelved without a put-away or transfer being recorded, so Staging still carries it.',
      'It is waiting on something before it can be shelved, such as a label or a decision about where it goes.',
    ],
    clearedBy:
      'Clears when this Staging holding is empty: put the stock away onto a rack. A holding that empties and fills again starts a new clock.',
    actions: ['put_away', 'open_item'],
    recountable: false,
  },
  long_unplaced: {
    rule: 'long_unplaced',
    severity: 'warning',
    label: 'On hand but on no rack',
    action:
      'Counted in stock with no location, long enough that nobody is coming back for it. Place it or write it off deliberately.',
    explanations: [
      'The stock was added without a location, for example as an opening balance, an import or an adjustment.',
      'It sits in a part of the warehouse that has no rack record.',
      'The units are no longer there and the record was not corrected.',
    ],
    clearedBy:
      'Clears when this Unplaced holding is empty: place the stock on a rack, or write it off if it is not there.',
    actions: ['put_away', 'open_item'],
    recountable: false,
  },
  label_mismatch: {
    rule: 'label_mismatch',
    severity: 'warning',
    label: 'Label will not lead to the stock',
    action:
      'The item’s printed label names somewhere its stock is not, so pick slips, shelf labels and the mobile lookup send people to the wrong place — or to nowhere at all.',
    explanations: [
      'The stock was moved to another rack and the label was not updated.',
      'The label holds a typing error or an old rack number.',
      'The label names a general area (such as "Bin") rather than a rack.',
    ],
    clearedBy:
      'Clears when the label names a rack that holds this item’s stock: edit the label, or move the stock to the rack it names.',
    actions: ['edit_label', 'open_item'],
    recountable: false,
  },
};

/** One detected instance. Built by the service; rendered as-is. */
export interface WarehouseException {
  rule: ExceptionRule;
  /** Stable across reloads so React keys and future dismissals have an anchor. */
  key: string;
  /** The subject, in the warehouse's own words. */
  title: string;
  /** The specific numbers. Never a restatement of the rule. */
  detail: string;
  /** Where to go and fix it. Null only when no single page owns the fix. */
  href: string | null;
  units?: number;
  ageDays?: number;
}

const SEVERITY_ORDER: Record<ExceptionSeverity, number> = { critical: 0, warning: 1 };

/**
 * Order for display: severity first, then size, then age.
 *
 * SIZE BEFORE AGE IS DELIBERATE. Age is the more emotive number and the wrong
 * one to lead with — a single unit misplaced for 90 days sorts above 200 units
 * misplaced yesterday, and the reader fixes the trivia first. Units are what is
 * actually at stake; age breaks the tie.
 */
export function sortExceptions(list: readonly WarehouseException[]): WarehouseException[] {
  return [...list].sort((a, b) => {
    const sev =
      SEVERITY_ORDER[EXCEPTION_RULES[a.rule].severity] -
      SEVERITY_ORDER[EXCEPTION_RULES[b.rule].severity];
    if (sev !== 0) return sev;
    const units = (b.units ?? 0) - (a.units ?? 0);
    if (units !== 0) return units;
    const age = (b.ageDays ?? 0) - (a.ageDays ?? 0);
    if (age !== 0) return age;
    // Last resort so the order is TOTAL. Without this, two identical-looking
    // rows can swap places between renders and the list appears to flicker.
    return a.key.localeCompare(b.key);
  });
}

/** Grouped for rendering, in the same order, with empty groups omitted. */
export function groupExceptions(
  list: readonly WarehouseException[],
): Array<{ meta: ExceptionRuleMeta; items: WarehouseException[] }> {
  const sorted = sortExceptions(list);
  const out: Array<{ meta: ExceptionRuleMeta; items: WarehouseException[] }> = [];
  for (const e of sorted) {
    const existing = out.find((g) => g.meta.rule === e.rule);
    if (existing) existing.items.push(e);
    else out.push({ meta: EXCEPTION_RULES[e.rule], items: [e] });
  }
  return out;
}

/** Total across every rule — the number the nav badge and the header show. */
export function countExceptions(list: readonly WarehouseException[]): {
  total: number;
  critical: number;
} {
  let critical = 0;
  for (const e of list) if (EXCEPTION_RULES[e.rule].severity === 'critical') critical += 1;
  return { total: list.length, critical };
}

// ═══════════════════════════════════════════════════════════════════════════
// STORED OCCURRENCES (F1-1, migration 0370)
// ═══════════════════════════════════════════════════════════════════════════
//
// Conditions stay DERIVED: the rules above are evaluated org-wide by the
// system, never per reader. Only the LIFECYCLE is stored — an occurrence is
// raised the first time a condition is seen, keeps its EX number while it
// stays true, and is resolved by the system when a complete evaluation no
// longer finds it. Nobody marks a row resolved; a person can acknowledge it
// and add notes. A condition that comes back after resolving is a NEW
// occurrence linked to the previous one (a recurrence).
//
// Everything a web page and the phone both show about an occurrence is
// derived here, so the two never word the same row differently.

/** Every rule this build evaluates, in display order. */
export const EXCEPTION_RULE_IDS: readonly ExceptionRule[] = [
  'orphaned_stock',
  'over_reserved',
  'stale_staging',
  'long_unplaced',
  'label_mismatch',
];

/** A value read from the database is one of this build's rules. A rule a newer
 *  build stored (count_variance from F1-2) is not, and a caller must not index
 *  EXCEPTION_RULES with it. */
export function isExceptionRule(value: unknown): value is ExceptionRule {
  return typeof value === 'string' && (EXCEPTION_RULE_IDS as readonly string[]).includes(value);
}

/**
 * Rules about ONE HOLDING (an item at a location). Their identity includes the
 * location; every other rule is about the item as a whole and has none. The
 * database refuses a row that breaks this (exc_occ_location_matches_rule).
 */
export const HOLDING_RULES: readonly ExceptionRule[] = [
  'orphaned_stock',
  'stale_staging',
  'long_unplaced',
];

export function isHoldingRule(rule: ExceptionRule): boolean {
  return HOLDING_RULES.includes(rule);
}

/** The identity of an occurrence: at most one is open per identity. */
export interface OccurrenceIdentity {
  rule: ExceptionRule;
  itemId: string;
  /** The holding's location for a holding rule; null for an item-level rule. */
  locationId: string | null;
}

/**
 * A stable display anchor for an identity (React keys, test fixtures). It is
 * NOT the identity — the stored row is keyed by (organization, rule, item,
 * location). Each rule has its own prefix, which is what fixes the old live
 * screen's collision where one `item:location` key was shared by three rules.
 */
export function occurrenceKey(id: OccurrenceIdentity): string {
  switch (id.rule) {
    case 'label_mismatch':
      return `label:${id.itemId}`;
    case 'over_reserved':
      return `over:${id.itemId}`;
    default:
      return `${id.rule}:${id.itemId}:${id.locationId ?? 'none'}`;
  }
}

/** 42 -> "EX-000042". Anything that is not a positive safe integer -> null, so
 *  the caller shows nothing rather than a made-up reference. */
export function formatOccurrenceNumber(n: number | string | null | undefined): string | null {
  const value = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return `EX-${String(value).padStart(6, '0')}`;
}

// ── Facts ───────────────────────────────────────────────────────────────────
//
// `facts` is the jsonb the system stores with each occurrence: numbers and
// names only (no order numbers, customer names or costs), refreshed on every
// sync while the row is open and frozen when it resolves. describeOccurrence
// is the ONLY reader, and it reads defensively: a row written by another
// build, or an empty object, still renders a sentence rather than throwing.

/** Facts for a holding rule (orphaned_stock, stale_staging, long_unplaced). */
export interface HoldingOccurrenceFacts {
  itemName: string;
  sku: string | null;
  units: number;
  locationName: string;
  locationKind: string | null;
}

export interface OverReservedOccurrenceFacts {
  itemName: string;
  sku: string | null;
  promised: number;
  onHand: number;
}

export interface LabelMismatchOccurrenceFacts {
  itemName: string;
  sku: string | null;
  /** The rack the label names (the rack segment of a composite label). */
  label: string;
  /** The racks (or position-less crates) that hold the stock, sorted. */
  stockOn: string[];
}

export type OccurrenceFacts =
  | HoldingOccurrenceFacts
  | OverReservedOccurrenceFacts
  | LabelMismatchOccurrenceFacts;

export interface OccurrenceDescription {
  /** The subject, in the warehouse's own words. */
  title: string;
  /** The specific numbers. Never a restatement of the rule. */
  detail: string;
  /** Units at stake, for sorting; null when the rule has no unit count. */
  units: number | null;
}

const DAY_MS = 86_400_000;

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whole days a condition has held at `asOf` (default now), or null when the
 * start is unknown. For a holding rule the start is the holding's
 * `positive_since`, which the migration backfilled from `updated_at` for
 * stock that existed before it: a LOWER bound on the true age. So every
 * surface says "for at least N days", never "for N days".
 */
export function conditionAgeDays(
  conditionSince: string | Date | null | undefined,
  asOf: string | Date = new Date(),
): number | null {
  const since = toMs(conditionSince);
  const at = toMs(asOf);
  if (since === null || at === null) return null;
  return Math.max(0, Math.floor((at - since) / DAY_MS));
}

/** "for at least 9 days" / "for at least 1 day". */
export function atLeastDaysCopy(days: number): string {
  return `for at least ${days} ${days === 1 ? 'day' : 'days'}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The sentence for one occurrence, from its rule and stored facts.
 *
 * `itemName` (optional) is the item's CURRENT name, read live, and wins over
 * the name stored in the facts: a rename shows at once instead of at the next
 * sync. `conditionSince` and `asOf` give the age for Staging and Unplaced; for
 * a resolved row pass its resolved time as `asOf`, so the age stops where the
 * condition did.
 */
export function describeOccurrence(
  rule: ExceptionRule,
  facts: unknown,
  opts: {
    itemName?: string | null;
    conditionSince?: string | Date | null;
    asOf?: string | Date;
  } = {},
): OccurrenceDescription {
  const f = record(facts);
  const itemName = str(opts.itemName) ?? str(f.itemName) ?? 'Item';
  switch (rule) {
    case 'orphaned_stock':
    case 'stale_staging':
    case 'long_unplaced': {
      const units = num(f.units);
      const title = units === null ? itemName : `${formatStockQuantity(units)} × ${itemName}`;
      const locationName = str(f.locationName);
      const days = conditionAgeDays(opts.conditionSince, opts.asOf);
      const age = days === null ? '' : ` ${atLeastDaysCopy(days)}`;
      let detail: string;
      if (rule === 'orphaned_stock') {
        detail = locationName ? `in ${locationName}, which is archived` : 'in an archived location';
      } else if (rule === 'stale_staging') {
        detail = `in Staging${age}`;
      } else {
        detail = `unplaced${age}`;
      }
      return { title, detail, units };
    }
    case 'over_reserved': {
      const promised = num(f.promised);
      const onHand = num(f.onHand);
      const detail =
        promised === null || onHand === null
          ? 'more units promised to open orders than on hand'
          : `${formatStockQuantity(promised)} promised, ${formatStockQuantity(onHand)} on hand`;
      const units = promised === null || onHand === null ? null : Math.max(0, promised - onHand);
      return { title: itemName, detail, units };
    }
    case 'label_mismatch': {
      const label = str(f.label);
      const stockOn = Array.isArray(f.stockOn)
        ? f.stockOn.map(str).filter((s): s is string => s !== null)
        : [];
      const detail =
        label && stockOn.length > 0
          ? `labelled ${label}, stock is on ${stockOn.join(', ')}`
          : label
            ? `labelled ${label}, which holds none of its stock`
            : 'the label does not name where the stock is';
      return { title: itemName, detail, units: null };
    }
  }
}

// ── Displayed state ─────────────────────────────────────────────────────────

export type OccurrenceResolvedReason = 'cleared' | 'reclassified' | 'subject_gone';

/** How each resolution reason reads. None of them says a person resolved it. */
export const OCCURRENCE_RESOLVED_REASON_COPY: Record<OccurrenceResolvedReason, string> = {
  cleared: 'Cleared',
  reclassified: 'Now reported under another rule',
  subject_gone: 'Item archived or deleted',
};

/** The recount linked to an occurrence, as far as the reader can see it. */
export interface OccurrenceRecountRef {
  cycleCountId: string;
  countNumber: number | null;
  status: string;
  completedAt: string | null;
}

export interface OccurrenceStateInput {
  resolvedAt: string | null;
  resolvedReason: OccurrenceResolvedReason | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  recount: OccurrenceRecountRef | null;
}

export type OccurrenceState =
  | { kind: 'resolved'; reason: OccurrenceResolvedReason; at: string }
  | { kind: 'rechecking'; cycleCountId: string; countNumber: number | null }
  | { kind: 'recount_in_progress'; cycleCountId: string; countNumber: number | null }
  | { kind: 'acknowledged'; at: string; by: string | null }
  | { kind: 'open' };

/**
 * The state a reader sees, in this order of precedence:
 *   1. Resolved, with its reason.
 *   2. Re-checking: the linked recount is completed and the stored state
 *      predates it (the last applied evaluation was before the count
 *      completed, or there has been none). Display only — the next sync
 *      decides whether the condition cleared.
 *   3. Recount in progress: the linked recount is still open.
 *   4. Acknowledged (who and when).
 *   5. Open.
 * `lastEvaluatedAt` is exception_sync_state.last_evaluated_at (null before
 * the first sync).
 */
export function occurrenceState(
  o: OccurrenceStateInput,
  lastEvaluatedAt: string | null,
): OccurrenceState {
  if (o.resolvedAt !== null) {
    return { kind: 'resolved', reason: o.resolvedReason ?? 'cleared', at: o.resolvedAt };
  }
  const rc = o.recount;
  if (rc) {
    if (rc.status === 'completed') {
      const completed = toMs(rc.completedAt);
      const evaluated = toMs(lastEvaluatedAt);
      if (evaluated === null || completed === null || evaluated < completed) {
        return { kind: 'rechecking', cycleCountId: rc.cycleCountId, countNumber: rc.countNumber };
      }
    } else if (rc.status === 'in_progress') {
      return {
        kind: 'recount_in_progress',
        cycleCountId: rc.cycleCountId,
        countNumber: rc.countNumber,
      };
    }
  }
  if (o.acknowledgedAt !== null) {
    return { kind: 'acknowledged', at: o.acknowledgedAt, by: o.acknowledgedBy };
  }
  return { kind: 'open' };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The recurrence badge: null for a first occurrence, else "Recurred (2nd
 * time)" for the second occurrence of the same identity, and so on.
 * `recurrenceIndex` is the stored recurrence_index (0 for the first).
 */
export function recurrenceBadge(recurrenceIndex: number): string | null {
  if (!Number.isSafeInteger(recurrenceIndex) || recurrenceIndex <= 0) return null;
  return `Recurred (${ordinal(recurrenceIndex + 1)} time)`;
}

/**
 * True when the condition was already there when tracking began for the org:
 * the row was first seen by the very first sync. Such a row reads "Already
 * present when tracking began", because its first-seen time says when the
 * system started looking, not when the problem started.
 */
export function presentWhenTrackingBegan(
  firstSeenAt: string | null | undefined,
  trackingStartedAt: string | null | undefined,
): boolean {
  const a = toMs(firstSeenAt);
  const b = toMs(trackingStartedAt);
  return a !== null && b !== null && a === b;
}

// ── Sync freshness ──────────────────────────────────────────────────────────

/** The system re-checks every organization on this cadence (the cron). */
export const EXCEPTION_SYNC_INTERVAL_MINUTES = 15;

/**
 * Shown before an organization's first check has run. An empty list at that
 * point means "not checked yet", never "all clear", so no surface may render
 * its all-clear state until a check has run.
 */
export const EXCEPTION_FIRST_CHECK_PENDING_COPY = `The first check has not run yet. It runs within ${EXCEPTION_SYNC_INTERVAL_MINUTES} minutes.`;
