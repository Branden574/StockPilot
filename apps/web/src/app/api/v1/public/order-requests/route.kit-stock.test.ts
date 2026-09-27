import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * A kit's pre-assembled stock (inventory_items.is_bundle) can never be picked
 * for an order: assembled kits sit in Staging and picking draws placed stock.
 * The New order page's service refuses it; this unauthenticated route writes
 * its lines with the service-role client, and neither the link eligibility
 * function nor the database line guard refuses kit stock yet, so the route
 * must, before anything is written (review F10, 2026-09-27). Both ways a token
 * resolves are covered: a request link, and the legacy organization token.
 */

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async (_key: string, _limit: number, windowMs: number) => ({
    allowed: true,
    count: 1,
    resetAt: Date.now() + windowMs,
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: vi.fn(async () => undefined),
}));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import { POST } from './route';

const TOKEN = 'pub_token_abcdef0123456789';
const WAREHOUSE_ID = '11111111-1111-1111-1111-111111111111';
const BOOK = '22222222-2222-2222-2222-222222222222';
const KIT_STOCK = '33333333-3333-3333-3333-333333333333';

function request(lines: Array<{ itemId: string; quantity: number }>) {
  return new Request('https://test.local/api/v1/public/order-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: TOKEN,
      warehouseId: WAREHOUSE_ID,
      requesterName: 'Jane Teacher',
      requesterEmail: 'jane@school.edu',
      lines,
    }),
  }) as unknown as Parameters<typeof POST>[0];
}

const rows = [
  {
    id: BOOK,
    organization_id: 'org-1',
    name: 'Reading Primer',
    warehouse_id: WAREHOUSE_ID,
    unit_cost: 8.5,
    item_type: 'book',
    status: 'active',
    deleted_at: null,
    is_bundle: false,
  },
  {
    id: KIT_STOCK,
    organization_id: 'org-1',
    name: 'New Hire Bundle (assembled)',
    warehouse_id: WAREHOUSE_ID,
    unit_cost: 40,
    item_type: 'book',
    status: 'active',
    deleted_at: null,
    is_bundle: true,
  },
];

function wire({ viaLink }: { viaLink: boolean }) {
  const stub = makeSupabaseStub({
    'public_request_links.select.maybeSingle': viaLink
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
    'rpc:public_link_eligible_items': {
      data: rows.map((r) => ({ item_id: r.id, max_qty: null })),
      error: null,
    },
    // Answers like PostgREST: only the rows the request names.
    'inventory_items.select': servedLikePostgrest(rows),
    'order_requests.insert.single': {
      data: { id: 'req-1', organization_id: 'org-1', warehouse_id: WAREHOUSE_ID },
      error: null,
    },
    'order_request_lines.insert': { data: null, error: null },
    'rpc:cleanup_expired_unconfirmed_order_requests': { data: null, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

describe('POST /api/v1/public/order-requests: kit stock is refused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminHolder.client = null;
  });

  for (const viaLink of [true, false]) {
    const how = viaLink ? 'a request link' : 'the legacy organization token';

    it(`through ${how}: 400 naming the kit, and no order is written`, async () => {
      const stub = wire({ viaLink });
      const res = await POST(
        request([
          { itemId: BOOK, quantity: 1 },
          { itemId: KIT_STOCK, quantity: 2 },
        ]),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_line',
        message:
          "New Hire Bundle (assembled) is a pre-assembled kit and can't be put on an order. Please remove it and order the kit's items instead.",
      });
      expect(stub.chainsAll.get('order_requests.insert')).toBeUndefined();
      expect(stub.chainsAll.get('order_request_lines.insert')).toBeUndefined();
    });

    it(`through ${how}: an order without kit stock still goes through`, async () => {
      wire({ viaLink });
      const res = await POST(request([{ itemId: BOOK, quantity: 1 }]));
      expect(res.status).toBe(200);
    });
  }
});
