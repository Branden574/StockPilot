import 'server-only';

import { assertModuleEnabled, assertPermission, withContext, type ServiceContext } from './context';
import { computeReorderSuggestion, getBulkItemVelocities } from './forecasting';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';
import { whereReorderCandidate } from './lib/orderable-items';
import { fetchAllRows } from './lib/paginate';
import { PurchaseOrdersService } from './purchase-orders';

/** Per-org planning parameters, stored in organization_modules.settings. */
export interface PlanningParams {
  /** Days from PO placement to stock-on-shelf — drives the reorder point. */
  leadTimeDays: number;
  /** Safety-stock multiplier on top of lead-time demand (1.5 = +50% buffer). */
  safetyMultiplier: number;
  /** Lookback window (days) for the velocity calc. */
  velocityWindowDays: number;
}

export const DEFAULT_PLANNING_PARAMS: PlanningParams = {
  leadTimeDays: 14,
  safetyMultiplier: 1.5,
  velocityWindowDays: 90,
};

/** A single item's velocity-derived reorder recommendation for the planning UI. */
export interface PlanningSuggestion {
  itemId: string;
  sku: string | null;
  name: string;
  quantityOnHand: number;
  currentReorderPoint: number;
  suggestedReorderPoint: number;
  suggestedReorderQty: number;
  unitsPerDay: number;
  /** Days of cover at current velocity; null = no outbound movement. */
  daysOfStockRemaining: number | null;
  supplierId: string | null;
  supplierName: string | null;
  unitCost: number;
}

/** The planning table: the ranked suggestions and whether the catalog was cut
 *  off at PLANNING_MAX_ITEMS. */
export interface PlanningSuggestions {
  suggestions: PlanningSuggestion[];
  /**
   * True when the organization has MORE than PLANNING_MAX_ITEMS candidate
   * items: only the first PLANNING_MAX_ITEMS by item id were ranked, so an
   * urgent item past them is missing and every count taken from
   * `suggestions` (the page's below-par count, the AI tool's total) covers
   * only part of the catalog. Callers must say so.
   */
  truncated: boolean;
}

/** Coerce a settings value to a positive finite number, else fall back. */
function posNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Upper bound on items ranked per planning run. The velocity calc is bulk
// (one stock_movements query for the whole candidate set), so this bounds row
// COUNT, not query volume. Past it the plan is PARTIAL, never silently: the
// read asks for one more row than this, and finding it sets `truncated`.
export const PLANNING_MAX_ITEMS = 5_000;

/**
 * PlanningService — velocity-based demand planning. Reads per-org planning
 * params from organization_modules.settings, composes per-item reorder
 * suggestions off the shared forecasting engine, and delegates auto-draft PO
 * generation to PurchaseOrdersService (no duplicated PO logic). Gated behind
 * the `planning` module + the reused `purchase_orders:manage` permission.
 */
export class PlanningService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new PlanningService(await withContext());
  }

  /**
   * Read planning params from the org's `planning` module settings, falling
   * back to defaults for any unset/garbage value (never throws on bad JSON).
   */
  async readParams(): Promise<PlanningParams> {
    const { data, error } = await this.ctx.supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', this.ctx.organizationId)
      .eq('module_id', 'planning')
      .maybeSingle();
    // Fail CLOSED to defaults: this method's contract is "never throws on a bad
    // value" — a transient query error is just another bad value. Throwing here
    // would take down the whole planning page (and the auto-draft PO run) over a
    // params read, when sensible defaults exist. Log so it's not silent.
    if (error) {
      console.error('[PlanningService.readParams] settings read failed, using defaults:', error.message);
      return { ...DEFAULT_PLANNING_PARAMS };
    }

    const settings = (data as { settings?: unknown } | null)?.settings;
    const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
    return {
      leadTimeDays: posNumber(s.leadTimeDays, DEFAULT_PLANNING_PARAMS.leadTimeDays),
      safetyMultiplier: posNumber(s.safetyMultiplier, DEFAULT_PLANNING_PARAMS.safetyMultiplier),
      velocityWindowDays: posNumber(s.velocityWindowDays, DEFAULT_PLANNING_PARAMS.velocityWindowDays),
    };
  }

  /**
   * Compute velocity-based reorder suggestions for the org's reorder
   * candidates (active, not deleted, not a rental, not a kit's pre-assembled
   * stock), sorted by urgency (lowest days-of-cover first; items with no
   * cover but a positive suggested deficit float to the top). At most
   * PLANNING_MAX_ITEMS are ranked; `truncated` says when there were more.
   */
  async getReorderSuggestions(params: { warehouseId?: string } = {}): Promise<PlanningSuggestions> {
    assertModuleEnabled(this.ctx, 'planning');
    // Defense-in-depth on the registry's dependsOn: ['inventory','purchase_orders']
    // contract. dependsOn is normally enforced at toggle/pack-apply time, but a
    // direct organization_modules write or a partial cascade could leave
    // planning=true while purchase_orders=false. Re-assert at the boundary so we
    // never run velocity math for a module whose dependency is off.
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const planningParams = await this.readParams();

    type Row = {
      id: string;
      sku: string | null;
      name: string | null;
      quantity_on_hand: number | null;
      reorder_point: number | null;
      reorder_quantity: number | null;
      unit_cost: number | null;
      supplier_id: string | null;
      created_at: string;
    };

    // Fetch the candidate set (the shared reorder-candidate predicate: active,
    // not deleted, not a rental, not a kit's pre-assembled stock), optionally
    // sliced to one warehouse (the AI suggestReorderPoints tool passes
    // warehouseId; velocity math itself stays per-item so the slice is just a
    // candidate filter). Every item is ranked, with or without a reorder point.
    //
    // PostgREST clamps any single response to `[api] max_rows = 1000`, so the
    // former `.limit(MAX_ITEMS)` SILENTLY returned at most 1000 items — every
    // candidate past the first 1000 got no reorder suggestion. Paginate in
    // 1000-row `.range()` windows with a stable `.order('id')` and accumulate
    // up to the cap (same cap class as forecasting.ts / order-requests.ts).
    //
    // The cap reads ONE row past PLANNING_MAX_ITEMS: that row is only a
    // sentinel. If it exists the plan is partial (`truncated`) and the row is
    // dropped, so exactly PLANNING_MAX_ITEMS are ranked either way.
    const fetched = await fetchAllRows<Row>(
      (from, to) => {
        let q = whereReorderCandidate(
          this.ctx.supabase
            .from('inventory_items')
            .select(
              'id, sku, name, quantity_on_hand, reorder_point, reorder_quantity, unit_cost, supplier_id, created_at',
            ),
          this.ctx.organizationId,
          { withReorderPoint: false },
        );
        if (params.warehouseId) q = q.eq('warehouse_id', params.warehouseId);
        return q.order('id', { ascending: true }).range(from, to);
      },
      { cap: PLANNING_MAX_ITEMS + 1 },
    );
    const truncated = fetched.length > PLANNING_MAX_ITEMS;
    const items = truncated ? fetched.slice(0, PLANNING_MAX_ITEMS) : fetched;
    if (items.length === 0) return { suggestions: [], truncated: false };

    // Resolve supplier names. Batched: the candidate set spans every supplier
    // in the org. Names are labels, so a failed read leaves them blank and is
    // reported rather than failing the plan.
    const supplierIds = [
      ...new Set(items.map((i) => i.supplier_id).filter((id): id is string => !!id)),
    ];
    const supplierName = new Map<string, string>();
    if (supplierIds.length > 0) {
      const ctx = this.ctx;
      try {
        const suppliers = await fetchAllRowsByIds<{ id: string; name: string }>(
          supplierIds,
          (batch) => (from, to) =>
            ctx.supabase
              .from('suppliers')
              .select('id, name')
              .eq('organization_id', ctx.organizationId)
              .in('id', batch)
              .order('id')
              .range(from, to),
        );
        for (const s of suppliers) supplierName.set(s.id, s.name);
      } catch (err) {
        reportDegradedRead('planning.supplier_names', err, { suppliers: supplierIds.length });
      }
    }

    // ONE stock_movements query for the whole candidate set — no per-item DB
    // fan-out. The reorder formula is then computed in memory off each item's
    // already-fetched reorder_point/quantity (no redundant second item read).
    const velocities = await getBulkItemVelocities(
      this.ctx.supabase,
      this.ctx.organizationId,
      items,
      planningParams.velocityWindowDays,
    );

    const suggestions: PlanningSuggestion[] = items.map((item) => {
      const velocity = velocities.get(item.id)!;
      const f = computeReorderSuggestion(
        velocity,
        Number(item.reorder_point ?? 0),
        Number(item.reorder_quantity ?? 0),
        {
          leadTimeDays: planningParams.leadTimeDays,
          safetyMultiplier: planningParams.safetyMultiplier,
        },
      );
      return {
        itemId: item.id,
        sku: item.sku ?? null,
        name: item.name ?? '',
        quantityOnHand: f.velocity.quantityOnHand,
        currentReorderPoint: f.currentReorderPoint,
        suggestedReorderPoint: f.suggestedReorderPoint,
        suggestedReorderQty: f.suggestedReorderQty,
        unitsPerDay: f.velocity.unitsOutPerDay,
        daysOfStockRemaining: f.velocity.daysOfStockRemaining,
        supplierId: item.supplier_id ?? null,
        supplierName: item.supplier_id ? (supplierName.get(item.supplier_id) ?? null) : null,
        unitCost: Number(item.unit_cost ?? 0),
      };
    });

    // Urgency sort: lowest days-of-cover first. Items WITH a finite cover rank
    // by that ascending; non-moving items (null cover) sink below all moving
    // items, then break ties by largest deficit (suggestedReorderPoint - onHand).
    const coverKey = (s: PlanningSuggestion) =>
      s.daysOfStockRemaining === null ? Number.POSITIVE_INFINITY : s.daysOfStockRemaining;
    const deficit = (s: PlanningSuggestion) => s.suggestedReorderPoint - s.quantityOnHand;
    suggestions.sort((a, b) => {
      const ca = coverKey(a);
      const cb = coverKey(b);
      if (ca !== cb) return ca - cb;
      return deficit(b) - deficit(a);
    });

    return { suggestions, truncated };
  }

  /**
   * Ids of the items already on an open purchase order — the items the draft
   * button skips — so the Planning page's below-par count matches what the
   * button will draft. Throws when the set cannot be read; the page shows the
   * unfiltered count with a note rather than a count it cannot vouch for.
   */
  async itemIdsOnOpenPurchaseOrders(): Promise<Set<string>> {
    assertModuleEnabled(this.ctx, 'planning');
    return new PurchaseOrdersService(this.ctx).listOpenPoItemIds();
  }

  /**
   * Auto-generate draft purchase orders for the below-par set. Delegates to
   * PurchaseOrdersService.createDraftsFromReorderForecast (the single source of
   * truth for supplier grouping + deficit math + the skip of items already on
   * an open PO + draft creation); planning adds only its own module gate on
   * top of that service's PO gates.
   */
  async autoGenerateDraftPOs(): Promise<
    Awaited<ReturnType<PurchaseOrdersService['createDraftsFromReorderForecast']>>
  > {
    assertModuleEnabled(this.ctx, 'planning');
    // Mirror getReorderSuggestions: assert the dependsOn'd purchase_orders
    // module here too. createDraftsFromReorderForecast re-gates internally, but
    // asserting at the planning boundary keeps the dependency contract explicit.
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const poService = new PurchaseOrdersService(this.ctx);
    return poService.createDraftsFromReorderForecast();
  }
}
