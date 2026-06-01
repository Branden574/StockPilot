import 'server-only';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { suggestReorderPoint, type ReorderSuggestion } from './forecasting';
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

/** Coerce a settings value to a positive finite number, else fall back. */
function posNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Upper bound on items scanned per planning run — keeps the per-item velocity
// fan-out bounded for large catalogs (mirrors the PO reorder-forecast cap).
const MAX_ITEMS = 500;

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
    if (error) throw new ServiceError('internal_error', error.message);

    const settings = (data as { settings?: unknown } | null)?.settings;
    const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
    return {
      leadTimeDays: posNumber(s.leadTimeDays, DEFAULT_PLANNING_PARAMS.leadTimeDays),
      safetyMultiplier: posNumber(s.safetyMultiplier, DEFAULT_PLANNING_PARAMS.safetyMultiplier),
      velocityWindowDays: posNumber(s.velocityWindowDays, DEFAULT_PLANNING_PARAMS.velocityWindowDays),
    };
  }

  /**
   * Compute velocity-based reorder suggestions for the org's active, non-rental,
   * non-deleted items, sorted by urgency (lowest days-of-cover first; items with
   * no cover but a positive suggested deficit float to the top).
   */
  async getReorderSuggestions(_params: { warehouseId?: string } = {}): Promise<PlanningSuggestion[]> {
    assertModuleEnabled(this.ctx, 'planning');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const planningParams = await this.readParams();

    // Bounded fetch of the candidate set. warehouseId is reserved for a future
    // per-warehouse slice; velocity is org-scoped today, so we keep the filter
    // signature stable without scoping the velocity calc yet.
    const { data: rows, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, quantity_on_hand, reorder_point, unit_cost, supplier_id')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .eq('is_rental', false)
      .limit(MAX_ITEMS);
    if (error) throw new ServiceError('internal_error', error.message);

    type Row = {
      id: string;
      sku: string | null;
      name: string | null;
      quantity_on_hand: number | null;
      reorder_point: number | null;
      unit_cost: number | null;
      supplier_id: string | null;
    };
    const items = (rows ?? []) as Row[];
    if (items.length === 0) return [];

    // Resolve supplier names in one round-trip.
    const supplierIds = [...new Set(items.map((i) => i.supplier_id).filter((id): id is string => !!id))];
    const supplierName = new Map<string, string>();
    if (supplierIds.length > 0) {
      const { data: suppliers } = await this.ctx.supabase
        .from('suppliers')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', supplierIds);
      for (const s of (suppliers ?? []) as Array<{ id: string; name: string }>) {
        supplierName.set(s.id, s.name);
      }
    }

    const forecasts = await Promise.all(
      items.map((item) =>
        suggestReorderPoint(this.ctx.supabase, this.ctx.organizationId, item.id, {
          leadTimeDays: planningParams.leadTimeDays,
          safetyMultiplier: planningParams.safetyMultiplier,
          windowDays: planningParams.velocityWindowDays,
        }),
      ),
    );

    const byItem = new Map<string, Row>(items.map((i) => [i.id, i]));
    const suggestions: PlanningSuggestion[] = forecasts.map((f: ReorderSuggestion) => {
      const item = byItem.get(f.itemId)!;
      return {
        itemId: f.itemId,
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

    return suggestions;
  }

  /**
   * Auto-generate draft purchase orders for the below-par set. Delegates to
   * PurchaseOrdersService.createDraftsFromReorderForecast (the single source of
   * truth for supplier grouping + deficit math + draft creation); planning adds
   * only its own module gate on top of that service's PO gates.
   *
   * `itemIds` is accepted for forward-compatibility with a future
   * selection-scoped draft; the underlying forecast currently recomputes the
   * full below-par set, so it is not yet narrowed here.
   */
  async autoGenerateDraftPOs(
    _params: { itemIds?: string[] } = {},
  ): Promise<Awaited<ReturnType<PurchaseOrdersService['createDraftsFromReorderForecast']>>> {
    assertModuleEnabled(this.ctx, 'planning');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const poService = new PurchaseOrdersService(this.ctx);
    return poService.createDraftsFromReorderForecast();
  }
}
