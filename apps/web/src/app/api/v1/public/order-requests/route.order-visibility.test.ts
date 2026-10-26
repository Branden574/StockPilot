import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Ordering visibility (0413) on the public request form. A link's catalog and
 * its submit share public_link_eligible_items, which leaves out an item hidden
 * from new ordering; the legacy organization token (no links row) checks the
 * column itself. The database gate refuses a hidden item's line for every
 * writer, the service role included, so a hide that lands between the
 * eligibility read and the insert still refuses: the header is removed and
 * the requester gets the route's own "no longer available" 400 (never a 500),
 * which does not say why. Lines go in item-id order, the lock order of every
 * gated writer.
 */

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async (_key: string, _limit: number, windowMs: number) => ({
    allowed: true,
    count: 1,
    resetAt: Date.now() + windowMs,
  }),
}));
const reportErrorMock = vi.fn(async (_e: unknown, _c: unknown) => undefined);
vi.mock('@/lib/error-reporter', () => ({
  reportError: (e: unknown, c: unknown) => reportErrorMock(e, c),
}));
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: vi.fn(async () => undefined),
}));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import { POST } from './route';

const TOKEN = 'pub_token_abcdef0123456789';
const WAREHOUSE_ID = '11111111-1111-1111-1111-111111111111';
const BOOK_A = '22222222-2222-2222-2222-222222222222';
const BOOK_B = '33333333-3333-3333-3333-333333333333';

function request(lines: Array<{ itemId: string; quantity: number }>) {
  return new Request('https://test.local/api/v1/public/order-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: TOKEN,
      warehouseId: WAREHOUSE_ID,
      requesterName: 'Sam Example',
      requesterEmail: 'sam@school.example',
      lines,
    }),
  }) as unknown as Parameters<typeof POST>[0];
}

const book = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  organization_id: 'org-1',
  name: `Book ${id.slice(0, 4)}`,
  warehouse_id: WAREHOUSE_ID,
  unit_cost: 8.5,
  item_type: 'book',
  status: 'active',
  deleted_at: null,
  is_bundle: false,
  order_catalog_visible: true,
  ...over,
});

function wire(opts: {
  viaLink: boolean;
  rows: Array<Record<string, unknown>>;
  lineError?: { message: string; code: string; hint?: string; details?: string };
}) {
  const stub = makeSupabaseStub({
    'public_request_links.select.maybeSingle': opts.viaLink
      ? {
          data: {
            id: 'link-1',
            organization_id: 'org-1',
            active: true,
            expires_at: null,
            available_from: null,
            available_until: null,
            default_max_qty: null,
          },
          error: null,
        }
      : { data: null, error: null },
    'organizations.select.maybeSingle': { data: { id: 'org-1' }, error: null },
    'organization_modules.select.maybeSingle': {
      data: { module_id: 'public_requests' },
      error: null,
    },
    'warehouses.select.maybeSingle': {
      data: { id: WAREHOUSE_ID, is_public_orderable: true, organization_id: 'org-1' },
      error: null,
    },
    // The eligibility function already applies `and i.order_catalog_visible`
    // (0413); this stub answers what it would for the visible rows.
    'rpc:public_link_eligible_items': {
      data: opts.rows
        .filter((r) => r.order_catalog_visible !== false)
        .map((r) => ({ item_id: r.id, max_qty: null })),
      error: null,
    },
    'inventory_items.select': servedLikePostgrest(opts.rows),
    'order_requests.insert.single': {
      data: { id: 'req-1', organization_id: 'org-1', warehouse_id: WAREHOUSE_ID },
      error: null,
    },
    'order_request_lines.insert': { data: null, error: opts.lineError ?? null },
    'rpc:cleanup_expired_unconfirmed_order_requests': { data: null, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

const GATE_REFUSAL = {
  message: 'This item is no longer available for new orders.',
  code: 'P0001',
  hint: 'order_item_hidden',
  details: BOOK_B,
};

describe('POST /api/v1/public/order-requests and items hidden from ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminHolder.client = null;
  });

  it('legacy token: a hidden book is refused before anything is written', async () => {
    const stub = wire({ viaLink: false, rows: [book(BOOK_A), book(BOOK_B, { order_catalog_visible: false })] });
    const res = await POST(
      request([
        { itemId: BOOK_A, quantity: 1 },
        { itemId: BOOK_B, quantity: 1 },
      ]),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_line',
      message: 'One of the books is no longer available.',
    });
    expect(stub.chainsAll.get('order_requests.insert')).toBeUndefined();
    const select = stub.chainArgsAll.get('inventory_items.select')?.[0]?.[0]?.[0] as string;
    expect(select).toContain('order_catalog_visible');
  });

  it('a link: an item the eligibility function left out is refused before anything is written', async () => {
    const stub = wire({ viaLink: true, rows: [book(BOOK_A), book(BOOK_B, { order_catalog_visible: false })] });
    const res = await POST(request([{ itemId: BOOK_B, quantity: 1 }]));
    expect(res.status).toBe(400);
    expect(stub.chainsAll.get('order_requests.insert')).toBeUndefined();
  });

  for (const viaLink of [true, false]) {
    const how = viaLink ? 'a link' : 'the legacy token';
    const sentence = viaLink
      ? 'This item is no longer available through this request form. Please remove it and submit again.'
      : 'One of the books is no longer available.';

    it(`${how}: a hide between the read and the insert is a 400 with the header removed, never a 500`, async () => {
      const stub = wire({ viaLink, rows: [book(BOOK_A), book(BOOK_B)], lineError: GATE_REFUSAL });
      const res = await POST(request([{ itemId: BOOK_B, quantity: 1 }]));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_line', message: sentence });
      expect(stub.chainsAll.get('order_requests.delete')).toHaveLength(1);
      // A refusal for the requester, not a fault to report.
      expect(reportErrorMock).not.toHaveBeenCalled();
    });
  }

  it('any other line failure is still the 500 it was, reported', async () => {
    wire({
      viaLink: true,
      rows: [book(BOOK_A)],
      lineError: { message: 'relation secret', code: 'XX000' },
    });
    const res = await POST(request([{ itemId: BOOK_A, quantity: 1 }]));
    expect(res.status).toBe(500);
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it('inserts the lines in item-id order', async () => {
    const stub = wire({ viaLink: true, rows: [book(BOOK_A), book(BOOK_B)] });
    const res = await POST(
      request([
        { itemId: BOOK_B, quantity: 2 },
        { itemId: BOOK_A, quantity: 1 },
      ]),
    );
    expect(res.status).toBe(200);
    const payload = stub.chainArgsAll.get('order_request_lines.insert')?.[0]?.[0]?.[0] as Array<{
      item_id: string;
    }>;
    expect(payload.map((l) => l.item_id)).toEqual([BOOK_A, BOOK_B]);
  });
});
