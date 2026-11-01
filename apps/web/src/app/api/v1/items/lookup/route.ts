import { NextResponse, type NextRequest } from 'next/server';

import { formatPlacementLabel, resolvePlacement, type RackHoldingLike } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { fetchRackHoldingsByItem } from '@/server/services/rack-holdings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ItemLookupMatch {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  charterId: string | null;
  charterName: string | null;
  /**
   * Where this record's stock is, by the one placement rule (core
   * resolvePlacement): the racks or crate its holdings name when the stock is
   * split or all in a crate, else its rack keys ("Rack 37-B"), else its rack
   * text. Null when none is known. It was the raw rack text alone, which
   * named one shelf for split stock, a rack the stock had left for crated
   * stock, and nothing for a book whose rack lives in its rack keys.
   */
  placementLabel: string | null;
  quantityOnHand: number;
  /**
   * Sports (Task 9): present only when the matched row is a variant —
   * `groupId` non-null means this item belongs to a product_groups family
   * (e.g. one shoe style across sizes 9/10/11). `variantSize` and
   * `jerseyNumber` are the raw TEXT columns (jersey_number keeps its
   * leading zeroes, e.g. '07'). `unitOfMeasure` is the display convention
   * (e.g. 'pair') — never used for any conversion. All four are null for a
   * plain, non-sports item, so an existing scanner reading only the
   * pre-existing fields is unaffected. Scanning a variant barcode resolves
   * to THAT variant's own row, so these values are already scoped to the
   * exact size/number that was scanned — no extra lookup needed.
   */
  groupId: string | null;
  variantSize: string | null;
  jerseyNumber: string | null;
  unitOfMeasure: string | null;
  /**
   * Rack/crate HOLDINGS (item_stock_levels) this item's stock actually
   * sits on — empty when unplaced. `placementLabel` already names every
   * holding of a split item; this is the same truth as data, for a caller
   * that lists the holdings itself.
   */
  rackHoldings: RackHoldingLike[];
}

type LookupRow = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  quantity_on_hand: number | null;
  charter_id: string | null;
  bin_location: string | null;
  item_type: string | null;
  custom_fields: Record<string, unknown> | null;
  charter: { name: string | null } | { name: string | null }[] | null;
  group_id: string | null;
  variant_size: string | null;
  jersey_number: string | null;
  unit_of_measure: string | null;
};

/** PostgREST embeds a to-one relation as an object (or an array of one). */
function embedCharterName(value: LookupRow['charter']): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.name ?? null;
}

/**
 * Mobile scanner uses this to resolve a scanned code to inventory_items.
 * Tries barcode + sku in one OR. Under Model B the same SKU can legitimately
 * exist as MULTIPLE placement rows (one per charter/rack), so this returns
 * every match rather than an arbitrary single() row — the caller (or a user
 * picker) decides which placement to act on. An EXACT barcode match is
 * unambiguous (a barcode identifies one physical unit/label) and wins over
 * any sku-only matches in the same result set.
 *
 * Returns 404 when nothing matches so the client can branch into the "not
 * in inventory yet → add via ISBN" flow.
 *
 * Query: ?code=<barcode_or_sku>
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') ?? '').trim();
  if (!code) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 });
  }

  const safe = code.replace(/[%,()]/g, '');
  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(
      `id, sku, name, barcode, quantity_on_hand, charter_id, bin_location,
       item_type, custom_fields,
       group_id, variant_size, jersey_number, unit_of_measure,
       charter:charters!charter_id(name)`,
    )
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .or(`barcode.eq.${safe},sku.eq.${safe}`);

  if (error) {
    void reportError(new Error(error.message), {
      tag: 'items.lookup',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  const rows = (data ?? []) as LookupRow[];
  const barcodeMatches = rows.filter((r) => r.barcode === safe);
  const finalRows = barcodeMatches.length > 0 ? barcodeMatches : rows;

  if (finalRows.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // No single-warehouse context for a bare code lookup (unlike a pick
  // slip, which is scoped to one order's warehouse) — list every holding
  // wherever it physically sits.
  const rackHoldingsByItemId = await fetchRackHoldingsByItem(
    ctx,
    finalRows.map((r) => r.id),
  );

  const matches: ItemLookupMatch[] = finalRows.map((row) => {
    const rackHoldings = rackHoldingsByItemId.get(row.id) ?? [];
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      barcode: row.barcode,
      charterId: row.charter_id,
      charterName: embedCharterName(row.charter),
      placementLabel: formatPlacementLabel(
        resolvePlacement({
          itemType: row.item_type ?? null,
          customFields: row.custom_fields ?? null,
          binLocation: row.bin_location,
          holdings: rackHoldings,
        }),
      ),
      quantityOnHand: Number(row.quantity_on_hand) || 0,
      rackHoldings,
      groupId: row.group_id ?? null,
      variantSize: row.variant_size ?? null,
      jerseyNumber: row.jersey_number ?? null,
      unitOfMeasure: row.unit_of_measure ?? null,
    };
  });

  return NextResponse.json({ matches });
}
