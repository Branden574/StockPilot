import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * B37: the pick slip names the Site for a line whose stock all sits on one.
 * The route reads every line item's placed holdings in ONE query, scoped to
 * the order's warehouse (fetchPlacementHoldingsByItem), and must hand BOTH
 * halves of that read to the renderer: the rack and crate rows, and the Site
 * rows. Both options are optional, so typecheck alone would never notice the
 * Site half dropped; this pins the hand-off. The renderer's own tests
 * (lib/pdf/pick-slip.test.ts) pin what it prints from them.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/dashboard/cached-org', () => ({ getCachedOrgTimezone: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/pdf/image-prefetch', () => ({
  prefetchImagesAsDataUris: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/pdf/pick-slip', () => ({
  renderPickSlipPdf: vi.fn(async () => Buffer.from('%PDF-1.4')),
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    primaryImagesForServerDecoding = async () => new Map();
  },
}));
vi.mock('@/server/services/rack-holdings', () => ({ fetchPlacementHoldingsByItem: vi.fn() }));
const get = vi.fn();
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: class {
    get = get;
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { renderPickSlipPdf } from '@/lib/pdf/pick-slip';
import { fetchPlacementHoldingsByItem } from '@/server/services/rack-holdings';

import { GET } from './route';

const ORDER_ID = '0a000000-0000-4000-8000-000000000037';
const WH = '0b000000-0000-4000-8000-000000000037';

const line = (id: string, itemId: string) => ({
  id,
  item_id: itemId,
  quantity_requested: 2,
  item: { id: itemId, name: 'Sample item', sku: `SKU-${id}`, item_type: 'book', custom_fields: {} },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(
    makeServiceContext(makeSupabaseStub().client, { role: 'manager' }) as never,
  );
  get.mockResolvedValue({
    request: { id: ORDER_ID, status: 'pick_slip_generated', warehouse_id: WH },
    lines: [line('L1', 'i1'), line('L2', 'i2')],
  });
});

async function call() {
  return GET(new NextRequest(`https://test.local/api/orders/${ORDER_ID}/pick-slip.pdf`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
}

describe("GET /api/orders/[id]/pick-slip.pdf: each line's placement holdings (B37)", () => {
  it("reads the lines' holdings in the order's warehouse and hands the renderer both halves", async () => {
    const rack = new Map([['i2', [{ name: '38-A', quantity: 4, kind: 'rack' }]]]);
    const other = new Map([['i1', [{ name: 'DC4', quantity: 7, kind: null, type: 'warehouse' }]]]);
    vi.mocked(fetchPlacementHoldingsByItem).mockResolvedValue({ rack, other } as never);

    const res = await call();

    expect(res.status).toBe(200);
    expect(fetchPlacementHoldingsByItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchPlacementHoldingsByItem).mock.calls[0]!.slice(1)).toEqual([
      ['i1', 'i2'],
      WH,
    ]);
    const opts = vi.mocked(renderPickSlipPdf).mock.calls[0]![1]!;
    expect(opts.rackHoldingsByItemId).toBe(rack);
    expect(opts.otherHoldingsByItemId).toBe(other);
  });
});
