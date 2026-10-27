import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

function buildCtx(client: unknown) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function req(code: string) {
  return new NextRequest(
    `http://localhost/api/v1/items/lookup?code=${encodeURIComponent(code)}`,
  );
}

describe('GET /api/v1/items/lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when there is no auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(req('SKU-1'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when code is missing', async () => {
    const stub = makeSupabaseStub({});
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    const res = await GET(new NextRequest('http://localhost/api/v1/items/lookup'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when nothing matches', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    const res = await GET(req('NOPE'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('a code shared by TWO same-sku placements (different charters/racks) returns 2 matches, not 1', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          {
            id: 'item-a',
            sku: 'SKU-1',
            name: 'Widget',
            barcode: null,
            quantity_on_hand: 4,
            charter_id: 'charter-a',
            bin_location: 'Rack A-1',
            group_id: null,
            variant_size: null,
            jersey_number: null,
            unit_of_measure: null,
            charter: { name: 'Charter A' },
          },
          {
            id: 'item-b',
            sku: 'SKU-1',
            name: 'Widget',
            barcode: null,
            quantity_on_hand: 9,
            charter_id: 'charter-b',
            bin_location: 'Rack B-2',
            group_id: null,
            variant_size: null,
            jersey_number: null,
            unit_of_measure: null,
            charter: { name: 'Charter B' },
          },
        ],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));

    const res = await GET(req('SKU-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toHaveLength(2);
    expect(body.matches).toEqual([
      {
        id: 'item-a',
        sku: 'SKU-1',
        name: 'Widget',
        barcode: null,
        charterId: 'charter-a',
        charterName: 'Charter A',
        placementLabel: 'Rack A-1',
        quantityOnHand: 4,
        rackHoldings: [],
        groupId: null,
        variantSize: null,
        jerseyNumber: null,
        unitOfMeasure: null,
      },
      {
        id: 'item-b',
        sku: 'SKU-1',
        name: 'Widget',
        barcode: null,
        charterId: 'charter-b',
        charterName: 'Charter B',
        placementLabel: 'Rack B-2',
        quantityOnHand: 9,
        rackHoldings: [],
        groupId: null,
        variantSize: null,
        jerseyNumber: null,
        unitOfMeasure: null,
      },
    ]);
  });

  it('populates rackHoldings for a split item (>1 rack/crate holding)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          {
            id: 'item-split',
            sku: 'SKU-2',
            name: 'Split Widget',
            barcode: null,
            quantity_on_hand: 25,
            charter_id: null,
            bin_location: 'Rack 1-A',
            charter: null,
          },
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          { item_id: 'item-split', quantity: 20, locations: { name: '2-C', kind: 'rack', warehouse_id: 'wh-1' } },
          { item_id: 'item-split', quantity: 5, locations: { name: '5-A', kind: 'rack', warehouse_id: 'wh-1' } },
        ],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));

    const res = await GET(req('SKU-2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    // The label follows the one placement rule (core resolvePlacement): stock
    // split across two racks is named by both, not by the one rack the stored
    // text names. It used to be that text, "Rack 1-A", which sends a picker to
    // one shelf while the stock sits on two.
    expect(body.matches[0].placementLabel).toBe('2-C ×20 · 5-A ×5');
    expect(body.matches[0].rackHoldings).toEqual([
      { name: '2-C', quantity: 20, kind: 'rack' },
      { name: '5-A', quantity: 5, kind: 'rack' },
    ]);
  });

  describe('placementLabel: where the stock is, by the one placement rule', () => {
    function lookupRow(extra: Record<string, unknown>) {
      return {
        id: 'item-1',
        sku: 'SKU-3',
        name: 'Into Algebra 1',
        barcode: null,
        quantity_on_hand: 12,
        charter_id: null,
        bin_location: null,
        item_type: 'product',
        custom_fields: {},
        charter: null,
        ...extra,
      };
    }
    async function labelFor(row: Record<string, unknown>, holdings: unknown[] = []) {
      const stub = makeSupabaseStub({
        'inventory_items.select': { data: [row], error: null },
        'item_stock_levels.select': { data: holdings, error: null },
      });
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
      const res = await GET(req('SKU-3'));
      expect(res.status).toBe(200);
      return ((await res.json()) as { matches: Array<{ placementLabel: string | null }> })
        .matches[0]!.placementLabel;
    }

    it("names a book's rack from its rack keys when it has no rack text", async () => {
      // A book's rack lives in its book_rack keys; bin_location can be blank.
      // The label was the blank text: null, as if the book had no place.
      expect(
        await labelFor(
          lookupRow({
            item_type: 'book',
            custom_fields: { book_rack_number: '37', book_rack_row: 'B' },
          }),
        ),
      ).toBe('Rack 37-B');
    });

    it("names an item's rack from its rack keys", async () => {
      expect(
        await labelFor(lookupRow({ custom_fields: { rack_number: '22', rack_row: 'C' } })),
      ).toBe('Rack 22-C');
    });

    it('names the crate when all of the stock is in a crate, not the rack it left', async () => {
      expect(
        await labelFor(lookupRow({ bin_location: '38-A' }), [
          {
            item_id: 'item-1',
            quantity: 12,
            locations: { name: 'Blue Shelf', kind: 'crate', warehouse_id: 'wh-1' },
          },
        ]),
      ).toBe('Blue Shelf ×12');
    });

    it('keeps the rack text when that is all there is', async () => {
      expect(await labelFor(lookupRow({ bin_location: ' 14-D ' }))).toBe('14-D');
      expect(await labelFor(lookupRow({}))).toBeNull();
    });

    // B37: a Site is a NULL kind with a site type. The label named the rack the
    // stock had left, because the rule was handed the rack and crate rows only.
    it('names the Site when all of the stock sits on one, not the rack its keys still name (B37)', async () => {
      const book = lookupRow({
        item_type: 'book',
        bin_location: '38-A',
        custom_fields: { book_rack_number: '38', book_rack_row: 'A' },
      });
      const dc4 = { name: 'DC4', kind: null, type: 'warehouse', warehouse_id: null };
      expect(
        await labelFor(book, [
          { item_id: 'item-1', quantity: 7, locations: dc4 },
          {
            item_id: 'item-1',
            quantity: 1,
            locations: { name: 'Staging', kind: 'staging', type: 'other', warehouse_id: 'wh-1' },
          },
        ]),
      ).toBe('DC4 ×7');
      // Stock on a rack beside the Site keeps naming the rack, as before.
      expect(
        await labelFor(book, [
          {
            item_id: 'item-1',
            quantity: 5,
            locations: { name: '38-A', kind: 'rack', type: 'shelf', warehouse_id: 'wh-1' },
          },
          { item_id: 'item-1', quantity: 2, locations: dc4 },
        ]),
      ).toBe('Rack 38-A');
    });

    it('keeps rackHoldings to the racks and crates: a Site row is in the label only (B37)', async () => {
      const stub = makeSupabaseStub({
        'inventory_items.select': { data: [lookupRow({ bin_location: '38-A' })], error: null },
        'item_stock_levels.select': {
          data: [
            {
              item_id: 'item-1',
              quantity: 7,
              locations: { name: 'DC4', kind: null, type: 'warehouse', warehouse_id: null },
            },
          ],
          error: null,
        },
      });
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
      const res = await GET(req('SKU-3'));
      const match = ((await res.json()) as { matches: Array<Record<string, unknown>> }).matches[0]!;
      expect(match.placementLabel).toBe('DC4 ×7');
      expect(match.rackHoldings).toEqual([]);
    });
  });

  it('an exact barcode match is unambiguous and wins over a same-code sku-only row', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          {
            id: 'item-barcode-hit',
            sku: 'SKU-9',
            name: 'Exact barcode item',
            barcode: 'BC123',
            quantity_on_hand: 2,
            charter_id: null,
            bin_location: null,
            charter: null,
          },
          {
            id: 'item-sku-collision',
            sku: 'BC123',
            name: 'Unrelated item whose SKU happens to equal the scanned code',
            barcode: null,
            quantity_on_hand: 7,
            charter_id: null,
            bin_location: null,
            charter: null,
          },
        ],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));

    const res = await GET(req('BC123'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ id: 'item-barcode-hit', barcode: 'BC123' });
  });

  it('returns 500 and reports the error when the query fails', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: { message: 'boom' } },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub.client));
    const res = await GET(req('SKU-1'));
    expect(res.status).toBe(500);
  });
});
