/**
 * The Distribute screen's preview (app/bundles/[id].tsx), as pure functions.
 *
 * The preview has to count the same stock the server's distribute_bundle()
 * will draw, or the phone says "fully available" and the server answers with
 * a shortage. Since 0365 the server draws, for a kit handed out at warehouse W:
 *
 *   - a component only from an item row in W (or with no warehouse), and never
 *     from a deleted item;
 *   - pre-assembled kits only when the kit's phantom item is in W (or has no
 *     warehouse) and is not deleted. Kits boxed somewhere else are left alone
 *     and the whole run comes from W's components.
 *
 * The rule below is the same one the web preview uses
 * (apps/web/src/server/services/bundles.ts, `drawableAtWarehouse`), so the web
 * and the phone preview agree with each other and with the RPC.
 *
 * A row with no warehouse never reaches the phone in practice: row level
 * security hides it from every user, so the snapshot never sends it (and the
 * server refuses a required component it cannot see with
 * `component_not_visible`). The rule still counts one, like the SQL's
 * `coalesce(item_wh, p_warehouse_id) = p_warehouse_id` and the web helper do.
 *
 * Kept free of React / react-native imports so vitest can run it directly.
 */

/** What the rule reads from an item row: a component, or the kit's phantom. */
export interface BundleStockRow {
  quantityOnHand: number;
  warehouseId: string | null;
  /**
   * Soft-delete stamp. The phone's item cache never holds a deleted item (the
   * snapshot reads `deleted_at is null`, and a later pull removes one that
   * gets deleted), so the screen leaves this unset. The rule still honours it,
   * so it cannot drift from the server's.
   */
  deletedAt?: string | null;
}

export interface PreviewComponentInput {
  itemId: string;
  /** Units of this item per kit. */
  perBundleQty: number;
  isOptional: boolean;
  /**
   * The cached item row, or null when the phone does not hold it (not synced
   * yet, deleted, or not visible to this user). Null counts as 0 available.
   */
  item: (BundleStockRow & { name: string; sku: string }) | null;
}

export interface DistributionPreviewComponent {
  itemId: string;
  itemName: string;
  itemSku: string;
  perBundleQty: number;
  isOptional: boolean;
  needed: number;
  /** On-hand the server will draw at the chosen warehouse; 0 when it will not draw this row. */
  available: number;
  drawnFromComponents: number;
  shortage: number;
}

export interface DistributionPreview {
  fromPhantom: number;
  fromComponents: number;
  components: DistributionPreviewComponent[];
  hasShortage: boolean;
  totalShortageItems: number;
  totalShortageUnits: number;
}

/**
 * Whether stock on an item row can be drawn for a kit at `warehouseId`: the
 * row is in that warehouse, or in none. Identical to the web helper.
 */
export function drawableAtWarehouse(
  itemWarehouseId: string | null | undefined,
  warehouseId: string,
): boolean {
  return itemWarehouseId == null || itemWarehouseId === warehouseId;
}

/**
 * How many units of `row` the server will draw at `warehouseId`: 0 for a
 * missing row, a deleted row, or a row in another warehouse; otherwise its
 * on-hand, with a negative count read as 0 (the RPC's `greatest(0, …)`).
 * Applies to a component's item and to the kit's phantom alike.
 */
export function availableAtWarehouse(
  row: BundleStockRow | null | undefined,
  warehouseId: string,
): number {
  if (!row) return 0;
  if (row.deletedAt != null) return 0;
  if (!drawableAtWarehouse(row.warehouseId, warehouseId)) return 0;
  return Math.max(0, Number(row.quantityOnHand) || 0);
}

/**
 * Dry-run of distribute_bundle() against the phone's cache. Pre-assembled
 * kits at the chosen warehouse are used first; components at that warehouse
 * cover the rest. A short optional component is shown but never counts as a
 * shortage, as on the server.
 *
 * Returns null when there is nothing to preview: no warehouse chosen yet, or a
 * quantity that is not a positive number.
 */
export function computeDistributionPreview(input: {
  quantity: number;
  warehouseId: string | null;
  phantom: BundleStockRow | null;
  components: PreviewComponentInput[];
}): DistributionPreview | null {
  const { quantity, warehouseId } = input;
  if (!warehouseId) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const phantomQty = availableAtWarehouse(input.phantom, warehouseId);
  const fromPhantom = Math.min(quantity, phantomQty);
  const fromComponents = quantity - fromPhantom;

  let totalShortageItems = 0;
  let totalShortageUnits = 0;
  const components = input.components.map((c): DistributionPreviewComponent => {
    const needed = c.perBundleQty * fromComponents;
    const available = availableAtWarehouse(c.item, warehouseId);
    const drawn = Math.min(needed, available);
    const shortage = needed - drawn;
    if (shortage > 0 && !c.isOptional) {
      totalShortageItems += 1;
      totalShortageUnits += shortage;
    }
    return {
      itemId: c.itemId,
      itemName: c.item?.name ?? c.itemId.slice(0, 8),
      itemSku: c.item?.sku ?? '',
      perBundleQty: c.perBundleQty,
      isOptional: c.isOptional,
      needed,
      available,
      drawnFromComponents: drawn,
      shortage,
    };
  });

  return {
    fromPhantom,
    fromComponents,
    components,
    hasShortage: totalShortageItems > 0,
    totalShortageItems,
    totalShortageUnits,
  };
}

/**
 * The warehouse the Distribute screen starts on.
 *
 *   1. The kit's phantom warehouse, when the bundle has pre-assembled stock
 *      somewhere: that is where its kits can be handed out.
 *   2. Otherwise, when every component is cached and they all sit in one
 *      warehouse, that warehouse: it is the only one the server can draw them
 *      all from.
 *   3. Otherwise the first warehouse in the list, as before.
 *
 * A candidate is used only when it is one of the warehouses the screen offers,
 * so the preselected button is always a visible one.
 */
export function defaultDistributeWarehouseId(input: {
  phantomWarehouseId: string | null;
  /** One entry per component: its cached item's warehouse, or undefined when the item is not cached. */
  componentWarehouseIds: readonly (string | null | undefined)[];
  /** The warehouses the screen lists, in display order. */
  warehouseIds: readonly string[];
}): string | null {
  const offered = new Set(input.warehouseIds);
  if (input.phantomWarehouseId && offered.has(input.phantomWarehouseId)) {
    return input.phantomWarehouseId;
  }
  if (!input.phantomWarehouseId && input.componentWarehouseIds.length > 0) {
    const first = input.componentWarehouseIds[0];
    const allInFirst =
      typeof first === 'string' && input.componentWarehouseIds.every((w) => w === first);
    if (allInFirst && offered.has(first)) return first;
  }
  return input.warehouseIds[0] ?? null;
}
