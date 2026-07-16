/**
 * Formatting for rack/crate HOLDINGS (item_stock_levels rows, not the
 * free-text `inventory_items.bin_location` / rack custom_fields label).
 *
 * An item's stock can be SPLIT across more than one rack/crate holding —
 * at that point a single "Rack 2-C" label is misleading: it points at one
 * rack while the stock actually sits on several, and it can also go
 * stale (holdings move; nobody remembers to re-type the label). Every
 * surface that walks a picker/counter to physical stock (pick-slip PDF,
 * cycle-count sheet, scanner lookup) should print the FULL breakdown for
 * a split item instead of a single rack name, so nothing gets missed.
 *
 * Shared by web (PDF renderers, API routes) and mobile (scan screen) —
 * kept dependency-free (no React/Next/Supabase types) so both bundle it
 * cheaply and both can unit test it the same way.
 */
export interface RackHoldingLike {
  /** Rack/crate location name, e.g. "2-C" or "Rack 39-B". */
  name: string;
  /** Quantity of this item's stock sitting at that location. */
  quantity: number;
}

/**
 * Renders a split item's holdings as "2-C ×20 · 5-A ×5" — every rack/crate
 * name with its quantity, sorted by name so the output is stable across
 * calls (matches the sort the inventory list already applies to
 * `placed_racks`). Returns null for an empty list so callers can fall
 * through to a label-based default without an extra length check.
 */
export function formatRackHoldings(holdings: readonly RackHoldingLike[]): string | null {
  if (holdings.length === 0) return null;
  return [...holdings]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((h) => `${h.name} ×${h.quantity}`)
    .join(' · ');
}

/**
 * True when stock sits on more than one distinct rack/crate holding — the
 * point at which a single free-text label becomes misleading and callers
 * should prefer `formatRackHoldings` over the label. Mirrors
 * `isSplitRackItem` (apps/web/src/lib/inventory/rack-holdings.ts), which
 * reads a precomputed `rackHoldingsCount` off the inventory list row;
 * this operates directly on a holdings array for callers (PDF renderers,
 * API routes, the mobile scan screen) that fetch holdings per-item rather
 * than through that list derivation.
 */
export function isSplitHoldings(holdings: readonly RackHoldingLike[]): boolean {
  return holdings.length > 1;
}
