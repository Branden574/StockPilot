import 'server-only';

import {
  EXCEPTION_RULES,
  formatStockQuantity,
  type WarehouseException,
} from '@stockpilot/core';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';

/**
 * The Exception Center's read model.
 *
 * ═══ WHY THIS IS QUERIES AND NOT A TABLE ═══
 *
 * Every condition here is DERIVED from rows that already exist. Copying them
 * into an `exceptions` table would create a second truth that goes stale the
 * moment somebody fixes the underlying problem — and "the screen still lists a
 * thing you already fixed" is precisely how an oversight surface loses its
 * reader. Nothing is persisted; the page is a live read.
 *
 * The corollary is that a resolved exception disappears on its own, with no
 * dismissal flow, no resolution status and no cleanup job to write.
 *
 * ═══ CAPS ARE REPORTED, NEVER SILENT ═══
 *
 * Each rule is capped. A rule that matches ten thousand rows is itself the
 * finding, and rendering all of them helps nobody — but a truncated list that
 * looks complete is a lie the reader cannot detect, so `truncated` travels with
 * the result and the page says so.
 */
const PER_RULE_CAP = 100;

/**
 * ═══ THE SOURCE READ HAS ITS OWN CAP, AND IT IS ALSO REPORTED ═══
 *
 * PER_RULE_CAP bounds what is RENDERED. It cannot bound what is READ, and for
 * a while nothing did: `placementRules` ran one bare `.select()` over every
 * positive holding in the org, and PostgREST clamps any single response to
 * `[api] max_rows = 1000` (supabase/config.toml) with no error and no marker.
 * Past a thousand holdings the rules were being evaluated against an arbitrary
 * subset — an archived-location holding on row 1,001 was simply never listed,
 * and `truncatedRules` stayed EMPTY because `capped()` only ever sees rows
 * PostgREST returned. Worse, `labelMismatches` compares an item's label
 * against the SET of its rack holdings built from those same rows, so a
 * dropped rack row turned a correctly-shelved item into a FALSE
 * "labelled 41-C, stock is on 40-B". The screen built to catch undetected
 * wrongness was quietly wrong itself. Now the read pages to exhaustion
 * (fetchAllRows, catalogue pattern #3).
 *
 * Exhaustion still needs a ceiling so one enormous org cannot pull an
 * unbounded set into memory on a server render — but an undisclosed ceiling
 * would reintroduce the exact lie above, so hitting it marks EVERY rule this
 * query feeds as truncated. Prod's largest org holds ~405 positive holdings,
 * so in practice the loop makes one round trip and stops.
 */
const HOLDINGS_SOURCE_CAP = 20_000;

/** The rules `placementRules` derives from the shared holdings read; all four
 *  are incomplete together if that read is capped. */
const PLACEMENT_RULES = [
  'orphaned_stock',
  'stale_staging',
  'long_unplaced',
  'label_mismatch',
] as const;

/** Staging is a transit bucket; two days is a normal put-away, a week is not. */
const STALE_STAGING_DAYS = 7;
/** Unplaced has no natural cadence, so the bar is "nobody is coming back". */
const LONG_UNPLACED_DAYS = 30;

export interface ExceptionsResult {
  exceptions: WarehouseException[];
  /** Rules whose row count exceeded the cap, so the page can say so out loud. */
  truncatedRules: string[];
}

type HoldingRow = {
  quantity: number;
  updated_at: string;
  item_id: string;
  inventory_items: { name: string; sku: string; bin_location: string | null } | null;
  locations: {
    id: string;
    name: string;
    kind: string | null;
    warehouse_id: string | null;
    deleted_at: string | null;
  } | null;
};

export class ExceptionsService {
  constructor(private ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<ExceptionsService> {
    return new ExceptionsService(await withContext());
  }

  /**
   * Run every rule. Rules are independent, so they run in parallel and a
   * failure in one must not blank the page — a half-populated exception screen
   * still surfaces real problems, whereas a 500 surfaces none.
   */
  async list(): Promise<ExceptionsResult> {
    assertPermission(this.ctx, 'items:read');
    const access = await getWarehouseAccess(this.ctx);
    const warehouseIds = access.hasAllAccess ? null : access.readableIds;
    // No readable warehouse means no visible stock, which is a legitimate empty
    // rather than an error — an auditor scoped to nothing sees nothing.
    if (warehouseIds && warehouseIds.length === 0) {
      return { exceptions: [], truncatedRules: [] };
    }

    const [placement, reservations] = await Promise.all([
      this.placementRules(warehouseIds),
      this.overReserved(),
    ]);

    return {
      exceptions: [...placement.exceptions, ...reservations.exceptions],
      truncatedRules: [...placement.truncatedRules, ...reservations.truncatedRules],
    };
  }

  /**
   * Four of the five rules read the same shape — a positive holding joined to
   * its location and item — so they share ONE query rather than four. The
   * alternative reads `item_stock_levels` four times for the same rows.
   */
  private async placementRules(warehouseIds: string[] | null): Promise<ExceptionsResult> {
    // Every filter is rebuilt INSIDE buildPage, so page 2 is scoped exactly
    // like page 1 — a warehouse filter applied only to the first window would
    // leak another site's stock onto a scoped auditor's page (pattern #10).
    // The `.order('id')` is required by fetchAllRows: without a stable sort a
    // row can land on two pages or on none.
    const rows = (await fetchAllRows<Record<string, unknown>>(
      (from, to) => {
        let q = this.ctx.supabase
          .from('item_stock_levels')
          .select(
            'quantity, updated_at, item_id, inventory_items!inner(name, sku, bin_location), locations!inner(id, name, kind, warehouse_id, deleted_at)',
          )
          .eq('organization_id', this.ctx.organizationId)
          .gt('quantity', 0);
        if (warehouseIds) q = q.in('locations.warehouse_id', warehouseIds);
        return q.order('id', { ascending: true }).range(from, to);
      },
      { cap: HOLDINGS_SOURCE_CAP },
    )) as unknown as HoldingRow[];

    const now = Date.now();
    const orphaned: WarehouseException[] = [];
    const staging: WarehouseException[] = [];
    const unplaced: WarehouseException[] = [];

    /** Positive RACK holdings per item, for the label check below. */
    const rackNamesByItem = new Map<string, Set<string>>();

    for (const r of rows) {
      const loc = r.locations;
      const item = r.inventory_items;
      if (!loc || !item) continue;
      const units = Number(r.quantity);
      const ageDays = Math.floor((now - new Date(r.updated_at).getTime()) / 86_400_000);
      const base = {
        key: `${r.item_id}:${loc.id}`,
        title: `${formatStockQuantity(units)} × ${item.name}`,
        href: `/dashboard/inventory/${r.item_id}`,
        units,
        ageDays,
      };

      // ARCHIVED FIRST, and before the kind checks: an archived Staging bucket
      // is an orphan, not a stale put-away, and the more severe reading wins.
      if (loc.deleted_at !== null) {
        orphaned.push({ ...base, rule: 'orphaned_stock', detail: `in ${loc.name}, archived` });
        continue;
      }
      if (loc.kind === 'staging' && ageDays >= STALE_STAGING_DAYS) {
        staging.push({ ...base, rule: 'stale_staging', detail: `in Staging for ${ageDays} days` });
        continue;
      }
      if (loc.kind === 'unplaced' && ageDays >= LONG_UNPLACED_DAYS) {
        unplaced.push({ ...base, rule: 'long_unplaced', detail: `unplaced for ${ageDays} days` });
        continue;
      }
      if (loc.kind === 'rack' || loc.kind === 'crate') {
        const set = rackNamesByItem.get(r.item_id) ?? new Set<string>();
        set.add(loc.name);
        rackNamesByItem.set(r.item_id, set);
      }
    }

    const mismatched = this.labelMismatches(rows, rackNamesByItem);

    const truncated = new Set<string>();
    // The source read stopped at its ceiling, so any of these four rules may
    // be short. Erring toward over-disclosure (exactly CAP rows could also be
    // the whole set) is the safe direction: a page that warns needlessly is
    // recoverable, a page that looks complete and is not cannot be detected.
    if (rows.length >= HOLDINGS_SOURCE_CAP) for (const r of PLACEMENT_RULES) truncated.add(r);
    const capped = (list: WarehouseException[], rule: string) => {
      if (list.length > PER_RULE_CAP) truncated.add(rule);
      return list.slice(0, PER_RULE_CAP);
    };

    return {
      exceptions: [
        ...capped(orphaned, 'orphaned_stock'),
        ...capped(staging, 'stale_staging'),
        ...capped(unplaced, 'long_unplaced'),
        ...capped(mismatched, 'label_mismatch'),
      ],
      truncatedRules: [...truncated],
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
   * Items with NO rack holdings are skipped entirely: their problem is that the
   * stock is in Staging or Unplaced, which the rules above already report, and
   * reporting it twice under a second heading is double-counting.
   */
  private labelMismatches(
    rows: readonly HoldingRow[],
    rackNamesByItem: Map<string, Set<string>>,
  ): WarehouseException[] {
    const seen = new Set<string>();
    const out: WarehouseException[] = [];
    for (const r of rows) {
      const item = r.inventory_items;
      if (!item || seen.has(r.item_id)) continue;
      const label = (item.bin_location ?? '').trim();
      if (label === '') continue;
      const racks = rackNamesByItem.get(r.item_id);
      if (!racks || racks.size === 0) continue;

      const labelRack = label.split('·')[0]!.trim();
      if (labelRack === '') continue;
      // Case-insensitive: production holds both "42-c" and "42-C" as typed.
      const lower = labelRack.toLowerCase();
      const matches = [...racks].some((n) => n.trim().toLowerCase() === lower);
      if (matches) continue;

      seen.add(r.item_id);
      out.push({
        rule: 'label_mismatch',
        key: `label:${r.item_id}`,
        title: item.name,
        detail: `labelled ${labelRack}, stock is on ${[...racks].sort().join(', ')}`,
        href: `/dashboard/inventory/${r.item_id}`,
      });
    }
    return out;
  }

  /**
   * More units promised to open orders than exist.
   *
   * Bounded by OPEN reservations rather than by catalogue size — an org with
   * 50,000 items and three open orders reads three rows here.
   */
  private async overReserved(): Promise<ExceptionsResult> {
    const { data: resRows, error: resErr } = await this.ctx.supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', this.ctx.organizationId)
      .is('released_at', null);
    if (resErr) throw new ServiceError('internal_error', resErr.message);

    const reservedByItem = new Map<string, number>();
    for (const r of (resRows ?? []) as Array<{ item_id: string; quantity: number }>) {
      reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + Number(r.quantity));
    }
    const itemIds = [...reservedByItem.keys()];
    if (itemIds.length === 0) return { exceptions: [], truncatedRules: [] };

    const { data: items, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name, sku, quantity_on_hand')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds)
      .is('deleted_at', null);
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);

    const out: WarehouseException[] = [];
    for (const it of (items ?? []) as Array<{
      id: string;
      name: string;
      quantity_on_hand: number;
    }>) {
      const reserved = reservedByItem.get(it.id) ?? 0;
      const onHand = Number(it.quantity_on_hand) || 0;
      if (reserved <= onHand) continue;
      out.push({
        rule: 'over_reserved',
        key: `over:${it.id}`,
        title: it.name,
        detail: `${formatStockQuantity(reserved)} promised, ${formatStockQuantity(onHand)} on hand`,
        href: `/dashboard/inventory/${it.id}`,
        units: reserved - onHand,
      });
    }
    return {
      exceptions: out.slice(0, PER_RULE_CAP),
      truncatedRules: out.length > PER_RULE_CAP ? ['over_reserved'] : [],
    };
  }
}

export { EXCEPTION_RULES };
