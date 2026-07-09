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
      },
    ]);
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
