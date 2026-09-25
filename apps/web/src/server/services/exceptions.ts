import 'server-only';

import {
  COUNT_VARIANCE_OPEN_WINDOW_DAYS,
  EXCEPTION_FACTS_LABEL_MAX,
  EXCEPTION_FACTS_LIST_MAX,
  EXCEPTION_FACTS_NAME_MAX,
  EXCEPTION_RULE_IDS,
  EXCEPTION_RULES,
  locationNameSitsOnRack,
  offlineCaptureAt,
  rackPositionOfLocationName,
  roundQuantity,
  type CountVarianceOccurrenceFacts,
  type ExceptionRule,
  type HoldingOccurrenceFacts,
  type LabelMismatchOccurrenceFacts,
  type OccurrenceFacts,
  type OverReservedOccurrenceFacts,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import { fetchAllRowsByIds, rawErrorText } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';
import { assertSystemContext, type SystemServiceContext } from './lib/system-context';

/**
 * The Exception Center's EVALUATOR: the one place the rules are computed.
 *
 * ═══ CONDITIONS ARE DERIVED; THE LIFECYCLE IS STORED; NO PERSON RESOLVES ═══
 *
 * Every condition here is derived from rows that already exist (holdings,
 * reservations, labels, posted counts). Nothing about a condition is typed in
 * by a person.
 * What IS stored (migration 0370) is each condition's lifecycle: an
 * exception_occurrences row is raised with an EX number the first time the
 * system sees a condition, refreshed while it stays true, and resolved by the
 * system when a complete evaluation no longer finds it. A person can
 * acknowledge an occurrence and add notes; nobody can mark one resolved,
 * because "resolved" means the condition is gone, and only an evaluation can
 * say that.
 *
 * ═══ WHY ONLY THE SYSTEM EVALUATES ═══
 *
 * The sync (exceptions_sync) resolves every open occurrence of a complete rule
 * that the evaluation did not report. An evaluation run with a reader's
 * context would see only what that reader can see, and would resolve
 * everything outside their warehouses. So `evaluateForSync` takes a
 * SystemServiceContext, which only the shared `buildSystemContext` issues,
 * and refuses anything else at runtime. Under that service-role client RLS is
 * bypassed, so every read below filters `organization_id` itself; a test fails
 * if any read drops it, because that filter is the only tenant boundary here.
 *
 * ═══ COMPLETE, FAILED, TRUNCATED AND HELD ═══
 *
 * The sync resolves an absent occurrence only for a rule listed COMPLETE. A
 * rule whose read failed is FAILED; a rule fed by a read that stopped at its
 * ceiling is TRUNCATED; neither is complete, so nothing of theirs resolves on
 * that run. An identity the evaluator cannot decide (see HOLD below) is HELD:
 * it neither opens nor resolves. Readers see which rules could not be checked
 * through exception_sync_state.
 *
 * ═══ NO PER-RULE CAP ═══
 *
 * The old live screen cut each rule at 100 rows for display. A sync must never
 * do that: a row past the cut would read as absent and be resolved. Every
 * finding is emitted; the display pages the stored rows instead.
 */

/**
 * ═══ THE SOURCE READ HAS A CEILING, AND HITTING IT IS NOT "COMPLETE" ═══
 *
 * PostgREST clamps any single response to `[api] max_rows = 1000`
 * (supabase/config.toml) with no error and no marker, so the holdings read
 * pages to exhaustion (fetchAllRows, catalogue pattern #3). Exhaustion still
 * needs a ceiling so one enormous org cannot pull an unbounded set into
 * memory. Hitting it marks EVERY rule this read feeds as truncated, which
 * keeps all four out of `completeRules`: an occurrence past the ceiling would
 * otherwise read as absent and resolve. Prod's largest org holds ~405 positive
 * holdings, so in practice the loop makes one round trip and stops.
 */
export const HOLDINGS_SOURCE_CAP = 20_000;

/** The rules derived from the shared holdings read; all four are incomplete
 *  together if that read fails or is capped. */
export const PLACEMENT_RULES: readonly ExceptionRule[] = [
  'orphaned_stock',
  'stale_staging',
  'long_unplaced',
  'label_mismatch',
];

/**
 * The same kind of ceiling for count_variance's source: one row per item the
 * org has ever counted (_latest_count_lines). Hitting it marks count_variance
 * truncated, so nothing of it resolves on that run. L4L has counted ~100
 * items.
 */
export const COUNT_LINES_SOURCE_CAP = 20_000;

/** Staging is a transit bucket; two days is a normal put-away, a week is not. */
export const STALE_STAGING_DAYS = 7;
/** Unplaced has no natural cadence, so the bar is "nobody is coming back". */
export const LONG_UNPLACED_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * ═══ EVERY NAME COPIED INTO FACTS IS CLIPPED ═══
 *
 * Item names, SKUs, labels and location names have no length limit in the
 * database (the app's form limits are app-only; a direct API write can store
 * 20,000 characters). A stored facts object is capped at 16 KB
 * (exc_occ_facts_shape), and exceptions_sync replaces an oversized one with
 * an empty object rather than fail the org's whole sync, but that loses the
 * row's words. Clipping here keeps every facts object far below the cap: at
 * most one 200-character name, three 100-character labels and ten
 * 100-character rack names. The page shows the item's LIVE name anyway;
 * facts.itemName is the fallback.
 */
export function clipFactText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

function clipOrNull(value: string | null | undefined, max: number): string | null {
  return value === null || value === undefined ? null : clipFactText(value, max);
}

/** One condition the evaluation found, in the shape exceptions_sync takes. */
export interface SyncPresentEntry {
  rule: ExceptionRule;
  itemId: string;
  /** The holding's location for a holding rule; null for an item-level rule. */
  locationId: string | null;
  /** Informational: the database derives the warehouse stamp itself. */
  warehouseId: string | null;
  facts: OccurrenceFacts;
  /** positive_since of the holding for a holding rule; null otherwise. */
  conditionSince: string | null;
}

/** An identity the evaluation could not decide: it must neither open nor
 *  resolve on this run. */
export interface SyncHoldEntry {
  rule: ExceptionRule;
  itemId: string;
  locationId: string | null;
}

export interface SyncEvaluation {
  /** Taken immediately before the first read, the same for the whole run. */
  evaluatedAt: string;
  present: SyncPresentEntry[];
  hold: SyncHoldEntry[];
  /** Rules whose reads fully succeeded and were not truncated. */
  completeRules: ExceptionRule[];
  failedRules: ExceptionRule[];
  truncatedRules: ExceptionRule[];
}

interface GroupResult {
  present: SyncPresentEntry[];
  hold: SyncHoldEntry[];
  truncatedRules: ExceptionRule[];
}

type HoldingRow = {
  quantity: number | string;
  positive_since: string | null;
  item_id: string;
  location_id: string;
  inventory_items: {
    name: string;
    sku: string | null;
    bin_location: string | null;
    warehouse_id: string | null;
  } | null;
  locations: {
    id: string;
    name: string;
    kind: string | null;
    warehouse_id: string | null;
    deleted_at: string | null;
  } | null;
};

export class ExceptionsService {
  /**
   * Evaluate every rule for one org, as the system, for exceptions_sync.
   *
   * Rule groups settle independently: a failed group is named in
   * `failedRules`, reported, and left out of `completeRules`, while the other
   * groups still count. Nothing here writes.
   */
  static async evaluateForSync(sysCtx: SystemServiceContext): Promise<SyncEvaluation> {
    // Runtime check, not just the type: a reader-scoped context cast to the
    // branded type must still be refused (see the header).
    assertSystemContext(sysCtx);
    // Taken BEFORE the first read. The sync stamps first/last-seen and
    // resolution with it, and a recount completed after this instant is still
    // "re-checking" until a later evaluation applies.
    const evaluatedAt = new Date().toISOString();
    const nowMs = Date.parse(evaluatedAt);

    const groups: Array<{ rules: readonly ExceptionRule[]; run: Promise<GroupResult> }> = [
      { rules: PLACEMENT_RULES, run: placementRules(sysCtx, nowMs) },
      { rules: ['over_reserved'], run: overReserved(sysCtx) },
      { rules: ['count_variance'], run: countVariance(sysCtx, nowMs, evaluatedAt) },
    ];
    const settled = await Promise.allSettled(groups.map((g) => g.run));

    const present: SyncPresentEntry[] = [];
    const hold: SyncHoldEntry[] = [];
    const failed = new Set<ExceptionRule>();
    const truncated = new Set<ExceptionRule>();
    const evaluated = new Set<ExceptionRule>();
    settled.forEach((outcome, i) => {
      const group = groups[i]!;
      for (const r of group.rules) evaluated.add(r);
      if (outcome.status === 'fulfilled') {
        present.push(...outcome.value.present);
        hold.push(...outcome.value.hold);
        for (const r of outcome.value.truncatedRules) truncated.add(r);
        return;
      }
      for (const r of group.rules) failed.add(r);
      void reportError(new Error('Exception Center rule failed to read'), {
        tag: 'exceptions.rule_failed',
        organizationId: sysCtx.organizationId,
        extra: { rules: group.rules.join(','), detail: rawErrorText(outcome.reason) },
      });
    });

    const completeRules = EXCEPTION_RULE_IDS.filter(
      (r) => evaluated.has(r) && !failed.has(r) && !truncated.has(r),
    );
    return {
      evaluatedAt,
      present: present.sort(numberingOrder),
      hold,
      completeRules,
      failedRules: EXCEPTION_RULE_IDS.filter((r) => failed.has(r)),
      truncatedRules: EXCEPTION_RULE_IDS.filter((r) => truncated.has(r)),
    };
  }
}

const SEVERITY_RANK = { critical: 0, warning: 1 } as const;

/**
 * The order new occurrences are numbered in (exceptions_sync numbers them in
 * array order): critical first, then by rule, item name and ids, so one run's
 * numbering is deterministic.
 */
function numberingOrder(a: SyncPresentEntry, b: SyncPresentEntry): number {
  const sev =
    SEVERITY_RANK[EXCEPTION_RULES[a.rule].severity] - SEVERITY_RANK[EXCEPTION_RULES[b.rule].severity];
  if (sev !== 0) return sev;
  const rule = EXCEPTION_RULE_IDS.indexOf(a.rule) - EXCEPTION_RULE_IDS.indexOf(b.rule);
  if (rule !== 0) return rule;
  const name = a.facts.itemName.localeCompare(b.facts.itemName);
  if (name !== 0) return name;
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  const la = a.locationId ?? '';
  const lb = b.locationId ?? '';
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/** Whole days since `since`, or null when there is no start. */
function ageDays(since: string | null, nowMs: number): number | null {
  if (!since) return null;
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((nowMs - ms) / DAY_MS);
}

/**
 * Four rules read the same shape — a positive holding joined to its location
 * and item — so they share ONE paged read.
 *
 * ═══ AGES COME FROM positive_since, NOT updated_at ═══
 *
 * The old live screen aged a holding by `updated_at`, which moves on EVERY
 * write, so a Staging holding topped up once a week never reached seven days
 * and never showed. `positive_since` (0370) is stamped when a holding goes
 * from empty to positive and kept through top-ups and partial draws. A
 * positive holding with no positive_since cannot be aged, so its Staging or
 * Unplaced rule is HELD rather than guessed either way.
 */
async function placementRules(ctx: SystemServiceContext, nowMs: number): Promise<GroupResult> {
  const orgId = ctx.organizationId;
  // Every filter is rebuilt inside buildPage so page 2 is scoped exactly like
  // page 1 (pattern #10). The `.order('id')` is required by fetchAllRows:
  // without a stable sort a row can land on two pages or on none.
  const rows = (await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      ctx.supabase
        .from('item_stock_levels')
        .select(
          'id, quantity, positive_since, item_id, location_id, inventory_items!inner(name, sku, bin_location, warehouse_id), locations!inner(id, name, kind, warehouse_id, deleted_at)',
        )
        .eq('organization_id', orgId)
        .gt('quantity', 0)
        .order('id', { ascending: true })
        .range(from, to),
    { cap: HOLDINGS_SOURCE_CAP },
  )) as unknown as HoldingRow[];

  const present: SyncPresentEntry[] = [];
  const hold: SyncHoldEntry[] = [];

  /** Positive rack and crate holdings per item, as location name -> its kind
   *  and warehouse, for the label check. The kind travels with the name so
   *  the facts can say which RACK a crate stands on
   *  (rackPositionOfLocationName); the warehouse decides whether the facts
   *  may name it (labelMismatches). */
  const rackHoldingsByItem = new Map<string, Map<string, RackHolding>>();

  for (const r of rows) {
    const loc = r.locations;
    const item = r.inventory_items;
    if (!loc || !item) continue;
    const units = Number(r.quantity);
    const facts: HoldingOccurrenceFacts = {
      itemName: clipFactText(item.name, EXCEPTION_FACTS_NAME_MAX),
      sku: clipOrNull(item.sku, EXCEPTION_FACTS_LABEL_MAX),
      units,
      locationName: clipFactText(loc.name, EXCEPTION_FACTS_LABEL_MAX),
      locationKind: loc.kind ?? null,
    };
    const entry = (rule: ExceptionRule): SyncPresentEntry => ({
      rule,
      itemId: r.item_id,
      locationId: loc.id,
      warehouseId: loc.warehouse_id ?? null,
      facts,
      conditionSince: r.positive_since ?? null,
    });

    // ARCHIVED FIRST, and before the kind checks: an archived Staging bucket
    // is an orphan, not a stale put-away, and the more severe reading wins.
    // (An occurrence that moves between the two resolves as "reclassified".)
    if (loc.deleted_at !== null) {
      present.push(entry('orphaned_stock'));
      continue;
    }
    if (loc.kind === 'staging' || loc.kind === 'unplaced') {
      const rule: ExceptionRule = loc.kind === 'staging' ? 'stale_staging' : 'long_unplaced';
      const threshold = loc.kind === 'staging' ? STALE_STAGING_DAYS : LONG_UNPLACED_DAYS;
      const days = ageDays(r.positive_since, nowMs);
      if (days === null) hold.push({ rule, itemId: r.item_id, locationId: loc.id });
      else if (days >= threshold) present.push(entry(rule));
      continue;
    }
    if (loc.kind === 'rack' || loc.kind === 'crate') {
      const held = rackHoldingsByItem.get(r.item_id) ?? new Map<string, RackHolding>();
      held.set(loc.name, { kind: loc.kind, warehouseId: loc.warehouse_id ?? null });
      rackHoldingsByItem.set(r.item_id, held);
    }
  }

  const labels = labelMismatches(rows, rackHoldingsByItem);
  present.push(...labels.present);
  hold.push(...labels.hold);

  return {
    present,
    hold,
    // The source read stopped at its ceiling, so any of these four rules may
    // be short. Erring toward over-disclosure (exactly CAP rows could also be
    // the whole set) is the safe direction: an incomplete rule resolves
    // nothing, whereas a complete-looking subset would resolve real rows.
    truncatedRules: rows.length >= HOLDINGS_SOURCE_CAP ? [...PLACEMENT_RULES] : [],
  };
}

/**
 * The item's printed rack label names a bay holding none of its stock.
 *
 * ═══ WHY THE LABEL IS SPLIT BEFORE COMPARING ═══
 *
 * `bin_location` is a COMPOSITE in production — "41-C · grayBIN" is a rack
 * and the crate sitting on it. Comparing the whole string against a location
 * name flags every crated book in the warehouse, which is exactly the false
 * positive that turns this screen into noise. Only the rack segment is
 * compared.
 *
 * ═══ NOT APPLICABLE IS HELD, NOT ABSENT ═══
 *
 * An item with a label and stock but NO rack or crate holding (all of it in
 * Staging, Unplaced, a site or an archived location) cannot be checked: its
 * stock is reported under those rules, and reporting it again as a bad label
 * would count one problem twice. But "cannot be checked" is not "fine": an
 * open label occurrence for it must not resolve just because the stock passed
 * through Staging, so the identity is HELD. An item whose label is empty
 * (after dropping a crate suffix) has nothing to compare and is simply absent,
 * so clearing the label resolves the row.
 *
 * ═══ WHY THE RACK SEGMENT IS MATCHED BY THE CORE PREDICATE, NOT BY EQUALITY ═══
 *
 * A CRATE SITS ON A RACK, and a positioned crate's rack lives only inside its
 * name: "Gray #5 on rack 43-B". An exact string comparison read that crate as
 * "not 43-B" and flagged every book stored in a crate on its own labelled rack
 * (a pattern L4L uses widely), and it also flagged a legacy rack spelled
 * "22 - B" against a label "22-B". `locationNameSitsOnRack` understands both
 * shapes. Its canonical comparison is a superset of the old case-insensitive
 * equality, so nothing that matched before stops matching.
 *
 * ═══ THE LABEL IS REDUCED TO THE RACK IT NAMES, FOR THE SAME REASON ═══
 *
 * A put-away into a positioned crate stamps the crate's own name as the label
 * (InventoryService.stampPlacementBin: bin = dest.name), so bin_location can
 * read "Blue #0 on rack 38-B". The label segment is therefore passed through
 * `rackPositionOfLocationName` (with no kind, because a label has none): a
 * " on rack X" tail yields X, and anything else comes back unchanged.
 *
 * The item card and the scan sheet ask the same question with the same
 * predicate (holdingsContradictRack), but of a different stored fact: the
 * structured rack pair in custom_fields, not bin_location.
 */
type RackHolding = { kind: string; warehouseId: string | null };

function labelMismatches(
  rows: readonly HoldingRow[],
  rackHoldingsByItem: Map<string, Map<string, RackHolding>>,
): { present: SyncPresentEntry[]; hold: SyncHoldEntry[] } {
  const seen = new Set<string>();
  const present: SyncPresentEntry[] = [];
  const hold: SyncHoldEntry[] = [];
  for (const r of rows) {
    const item = r.inventory_items;
    if (!item || seen.has(r.item_id)) continue;
    seen.add(r.item_id);
    const label = (item.bin_location ?? '').trim();
    if (label === '') continue;
    const labelSegment = label.split('·')[0]!.trim();
    if (labelSegment === '') continue;

    const held = rackHoldingsByItem.get(r.item_id);
    if (!held || held.size === 0) {
      hold.push({ rule: 'label_mismatch', itemId: r.item_id, locationId: null });
      continue;
    }

    // The rack the label names, so both sides of the comparison and of the
    // facts are racks: "Blue #0 on rack 38-B" is compared, and reported, as
    // "38-B", just as the composite "38-B · Blue0" is.
    const labelRack = rackPositionOfLocationName(labelSegment);
    const matches = [...held.keys()].some((name) => locationNameSitsOnRack(name, labelRack));
    if (matches) continue;

    // Name the RACKS the stock stands on, once each, the way the Rack column
    // does (placementPhysicalNames): a crate contributes the rack it sits on,
    // and a position-less crate ("Blue Shelf") keeps its own name because
    // that is the only place a picker can walk to.
    //
    // ONLY racks a reader of this occurrence may see holdings at. A label
    // mismatch is an ITEM-level row, visible to anyone who can read the item,
    // but item_stock_levels_select hides holdings in warehouses outside the
    // reader's own. Every reader of the item can see holdings in the item's
    // own warehouse (that is how they read the item) and at org-level
    // locations (no warehouse), so only those are named. The comparison above
    // still uses every rack: a label matching stock anywhere is not a
    // mismatch.
    const where = new Set<string>();
    for (const [name, h] of held) {
      if (h.warehouseId !== null && h.warehouseId !== (item.warehouse_id ?? null)) continue;
      const at = rackPositionOfLocationName(name, h.kind);
      if (at) where.add(clipFactText(at, EXCEPTION_FACTS_LABEL_MAX));
    }
    const sorted = [...where].sort((a, b) => a.localeCompare(b));
    const facts: LabelMismatchOccurrenceFacts = {
      itemName: clipFactText(item.name, EXCEPTION_FACTS_NAME_MAX),
      sku: clipOrNull(item.sku, EXCEPTION_FACTS_LABEL_MAX),
      label: clipFactText(labelRack, EXCEPTION_FACTS_LABEL_MAX),
      stockOn: sorted.slice(0, EXCEPTION_FACTS_LIST_MAX),
      ...(sorted.length > EXCEPTION_FACTS_LIST_MAX
        ? { stockOnMore: sorted.length - EXCEPTION_FACTS_LIST_MAX }
        : {}),
    };
    present.push({
      rule: 'label_mismatch',
      itemId: r.item_id,
      locationId: null,
      warehouseId: null,
      facts,
      conditionSince: null,
    });
  }
  return { present, hold };
}

/**
 * More units promised to open orders than exist.
 *
 * Bounded by OPEN reservations rather than by catalogue size — an org with
 * 50,000 items and three open orders reads three rows here.
 */
async function overReserved(ctx: SystemServiceContext): Promise<GroupResult> {
  const orgId = ctx.organizationId;
  // Paged: a bare `.select()` is cut at 1000 rows with no error, so a busy
  // org's sums were silently low.
  const resRows = await fetchAllRows<{ item_id: string; quantity: number | string }>((from, to) =>
    ctx.supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', orgId)
      .is('released_at', null)
      .order('id')
      .range(from, to),
  );

  const reservedByItem = new Map<string, number>();
  for (const r of resRows) {
    reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + Number(r.quantity));
  }
  const itemIds = [...reservedByItem.keys()];
  if (itemIds.length === 0) return { present: [], hold: [], truncatedRules: [] };

  // Batched: every item with an open reservation, org-wide, has no ceiling,
  // and one `.in()` past ~215 uuids fails (pattern #29).
  const items = await fetchAllRowsByIds<{
    id: string;
    name: string;
    sku: string | null;
    warehouse_id: string | null;
    quantity_on_hand: number | string;
  }>(
    itemIds,
    (batch) => (from, to) =>
      ctx.supabase
        .from('inventory_items')
        .select('id, name, sku, warehouse_id, quantity_on_hand')
        .eq('organization_id', orgId)
        .in('id', batch)
        .is('deleted_at', null)
        .order('id')
        .range(from, to),
  );

  const present: SyncPresentEntry[] = [];
  for (const it of items) {
    const reserved = reservedByItem.get(it.id) ?? 0;
    const onHand = Number(it.quantity_on_hand) || 0;
    if (reserved <= onHand) continue;
    const facts: OverReservedOccurrenceFacts = {
      itemName: clipFactText(it.name, EXCEPTION_FACTS_NAME_MAX),
      sku: clipOrNull(it.sku, EXCEPTION_FACTS_LABEL_MAX),
      promised: reserved,
      onHand,
    };
    present.push({
      rule: 'over_reserved',
      itemId: it.id,
      locationId: null,
      warehouseId: it.warehouse_id ?? null,
      facts,
      conditionSince: null,
    });
  }
  return { present, hold: [], truncatedRules: [] };
}

/** One row of _latest_count_lines (0372): the latest completed, counted line
 *  per item, with the item's fields. */
type LatestCountLineRow = {
  item_id: string;
  cycle_count_id: string;
  count_number: number | string | null;
  completed_at: string | null;
  counted_at: string | null;
  captured_at: string | null;
  baseline_at: string | null;
  expected_quantity: number | string | null;
  counted_quantity: number | string | null;
  counted_location_name: string | null;
  ai_assisted: boolean | null;
  item_name: string | null;
  item_sku: string | null;
  item_warehouse_id: string | null;
  item_countable: boolean | null;
};

function finiteOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The item's latest posted count found a different quantity than the book
 * (F1-2, owner decision Q2).
 *
 * ═══ THE ONE SOURCE OF "LAST PHYSICAL COUNT" ═══
 *
 * _latest_count_lines (0372, service_role only) returns, per item, the latest
 * line of a COMPLETED count where the item was counted, ordered by the moment
 * its expected quantity is true for (baseline_at, 0369), not by when the count
 * was posted: a phone that counted offline and synced late holds an older
 * observation. The p_org argument is this read's tenant boundary (the
 * function pins every join to that org); a test checks it is always this
 * org. It is paged like any other source (max_rows = 1000), ordered by
 * item_id, which is unique per row.
 *
 * ═══ WHAT OPENS, WHAT HOLDS, WHAT CLEARS ═══
 *
 *   - variance = counted - expected: exactly what the post applied.
 *   - Not zero, and the count completed within
 *     COUNT_VARIANCE_OPEN_WINDOW_DAYS: PRESENT (opens, or stays open with
 *     refreshed facts).
 *   - Not zero, but older: HELD. An open row never ages out, and nothing new
 *     opens for an old count.
 *   - Zero: absent, so an open row CLEARS. It clears only when a later
 *     completed count matches the book exactly; a recount that finds another
 *     difference replaces the facts and keeps the row open.
 *   - Rental equipment, kits, archived, discontinued and deleted items are
 *     left out (item_countable is start_cycle_count's own predicate): counts
 *     never include them, so a recount could not settle them. An open row
 *     for such an item resolves on this run as subject_gone (exceptions_sync,
 *     0372), never as cleared: no count matched its book.
 *   - AS OF THE EVALUATION: counts completed after evaluatedAt are not read
 *     (p_as_of). The sync closes a recount pointer only for a count completed
 *     at or before evaluatedAt, so a recount posted while this evaluation
 *     runs is judged by the next one (the post's own follow-up sync).
 *   - A line whose numbers or completion time cannot be read is HELD: it can
 *     be decided neither way.
 */
async function countVariance(ctx: SystemServiceContext, nowMs: number, evaluatedAt: string): Promise<GroupResult> {
  const orgId = ctx.organizationId;
  const rows = await fetchAllRows<LatestCountLineRow>(
    (from, to) =>
      ctx.supabase
        // p_as_of: only counts completed at or before this evaluation began.
        // exceptions_sync closes a recount's pointer only for such a count,
        // so the evaluator never resolves an exception from a recount whose
        // pointer the same sync keeps open.
        .rpc('_latest_count_lines', { p_org: orgId, p_item_ids: null, p_as_of: evaluatedAt })
        .order('item_id', { ascending: true })
        .range(from, to),
    { cap: COUNT_LINES_SOURCE_CAP },
  );

  const windowStart = nowMs - COUNT_VARIANCE_OPEN_WINDOW_DAYS * DAY_MS;
  const present: SyncPresentEntry[] = [];
  const hold: SyncHoldEntry[] = [];
  for (const r of rows) {
    if (r.item_countable !== true) continue;
    const counted = finiteOrNull(r.counted_quantity);
    const expected = finiteOrNull(r.expected_quantity);
    const completedMs = r.completed_at ? Date.parse(r.completed_at) : Number.NaN;
    if (counted === null || expected === null || !Number.isFinite(completedMs)) {
      hold.push({ rule: 'count_variance', itemId: r.item_id, locationId: null });
      continue;
    }
    const variance = roundQuantity(counted - expected);
    if (variance === 0) continue;
    if (completedMs < windowStart) {
      hold.push({ rule: 'count_variance', itemId: r.item_id, locationId: null });
      continue;
    }
    const countNumber = finiteOrNull(r.count_number);
    const facts: CountVarianceOccurrenceFacts = {
      itemName: clipFactText(r.item_name ?? 'Item', EXCEPTION_FACTS_NAME_MAX),
      sku: clipOrNull(r.item_sku, EXCEPTION_FACTS_LABEL_MAX),
      cycleCountId: r.cycle_count_id,
      countNumber: countNumber !== null && Number.isSafeInteger(countNumber) ? countNumber : null,
      observedAt: r.baseline_at ?? r.counted_at ?? null,
      completedAt: r.completed_at,
      expected,
      counted,
      variance,
      countedLocationName: clipOrNull(r.counted_location_name, EXCEPTION_FACTS_LABEL_MAX),
      aiAssisted: r.ai_assisted === true,
      capturedOfflineAt: offlineCaptureAt({ captured_at: r.captured_at, counted_at: r.counted_at }),
    };
    present.push({
      rule: 'count_variance',
      itemId: r.item_id,
      locationId: null,
      warehouseId: r.item_warehouse_id ?? null,
      facts,
      // When the counted quantity was observed: coalesce(baseline_at,
      // counted_at), the same order _latest_count_lines ranks lines by.
      conditionSince: r.baseline_at ?? r.counted_at ?? null,
    });
  }
  return {
    present,
    hold,
    // Erring toward over-disclosure, as for the holdings read: exactly CAP
    // rows could be the whole set, but a complete-looking subset would
    // resolve real rows.
    truncatedRules: rows.length >= COUNT_LINES_SOURCE_CAP ? ['count_variance'] : [],
  };
}
