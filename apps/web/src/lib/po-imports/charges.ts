/**
 * Turn a PO import's NON-INVENTORY lines (tax / freight / White Glove service /
 * e-waste fee / discount / anything priced-but-unmatched) into financial-only
 * purchase_order_charges rows.
 *
 * These are display + total-math ONLY. They carry no item_id and land in a table
 * with no FK to inventory_items, so there is structurally no path from a charge
 * to a stock movement — the owner's "charges never touch inventory" guarantee.
 *
 * Pure + deterministic so the tricky bits (type mapping, discount sign,
 * "nothing priced is silently dropped") are unit-testable without a DB.
 */

export type PoChargeType = 'tax' | 'freight' | 'service' | 'fee' | 'discount' | 'other';

/** Human label for a charge_type, used when a charge has no free-text label. */
export function humanizeChargeType(type: string): string {
  switch (type) {
    case 'tax':
      return 'Tax';
    case 'freight':
      return 'Freight / shipping';
    case 'service':
      return 'Service';
    case 'fee':
      return 'Fee';
    case 'discount':
      return 'Discount';
    default:
      return 'Charge';
  }
}

/** The line_type values that already ARE a charge class; anything else → 'other'. */
const CHARGE_TYPES = new Set<PoChargeType>(['tax', 'freight', 'service', 'fee', 'discount']);

/** The subset of a po_import line this builder needs. */
export interface PoChargeSourceLine {
  line_type: string;
  description?: string | null;
  line_total?: number | null;
  line_number?: number | null;
  qty_ordered_original?: number | null;
  unit_cost?: number | null;
}

export interface PoChargeRow {
  organization_id: string;
  charge_type: PoChargeType;
  label: string | null;
  /** Optional qty + unit cost for faithful line-row rendering on the PO PDF. */
  quantity: number | null;
  unit_cost: number | null;
  /** Signed: discounts are always negative so Σ(amount) is a straight add. */
  amount: number;
  source_line_number: number | null;
  sort_order: number;
}

/**
 * @param finalLines the import's lines AFTER overrides + skip filtering (i.e. the
 *   exact set that will post). Inventory lines are excluded here; every other
 *   line becomes a charge so no priced line vanishes from the PO total.
 */
export function buildPoCharges(
  finalLines: PoChargeSourceLine[],
  organizationId: string,
): { chargeRows: PoChargeRow[]; chargeTotal: number } {
  const chargeRows: PoChargeRow[] = finalLines
    .filter((l) => l.line_type !== 'inventory')
    .map((l, i) => {
      const chargeType: PoChargeType = CHARGE_TYPES.has(l.line_type as PoChargeType)
        ? (l.line_type as PoChargeType)
        : 'other';
      const raw = l.line_total ?? 0;
      // A discount must reduce the total regardless of the parser's sign
      // convention (some emit -50, some emit 50 with a 'discount' type).
      const amount = chargeType === 'discount' ? -Math.abs(raw) : raw;
      const label = l.description && l.description.trim().length > 0 ? l.description : null;
      const quantity = l.qty_ordered_original ?? null;
      // Only carry unit_cost when there's a real multi-unit qty to show
      // (a flat tax/fee line reads better as just its amount, not "1 @ $x").
      const unitCost = quantity != null && quantity !== 1 ? (l.unit_cost ?? null) : null;
      return {
        organization_id: organizationId,
        charge_type: chargeType,
        label,
        quantity: quantity != null && quantity !== 1 ? quantity : null,
        unit_cost: unitCost,
        amount,
        source_line_number: l.line_number ?? null,
        sort_order: i,
      };
    });
  const chargeTotal = chargeRows.reduce((sum, c) => sum + c.amount, 0);
  return { chargeRows, chargeTotal };
}
