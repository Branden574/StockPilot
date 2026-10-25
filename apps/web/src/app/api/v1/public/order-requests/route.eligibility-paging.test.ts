import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

/**
 * Submit checks a request's lines against the link's eligibility function,
 * fresh (B32). It read the function in one unpaged request, which PostgREST
 * answers with at most 1000 rows in no stated order: on a link with more than
 * 1000 eligible items, an item the page showed could be refused as "no longer
 * available through this request form". The read is now limited to the
 * request's own items (at most 100 lines, lineSchema), so it is one short
 * answer whatever the catalog's size.
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
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;

function request(lines: Array<{ itemId: string; quantity: number }>) {
  return new Request('https://test.local/api/v1/public/order-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: TOKEN,
      warehouseId: WAREHOUSE_ID,
      requesterName: 'Test Requester',
      requesterEmail: 'requester@example.test',
      lines,
    }),
  }) as unknown as Parameters<typeof POST>[0];
}

function wire(eligibleCount: number) {
  const ids = Array.from({ length: eligibleCount }, (_, i) => uuid(i));
  const rpcCalls: MockCall[] = [];
  const eligible = servedLikePostgrest(ids.map((item_id) => ({ item_id, max_qty: null })));
  const stub = makeSupabaseStub({
    'public_request_links.select.maybeSingle': {
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
    },
    'organization_modules.select.maybeSingle': {
      data: { module_id: 'public_requests' },
      error: null,
    },
    'warehouses.select.maybeSingle': {
      data: { id: WAREHOUSE_ID, is_public_orderable: true, organization_id: 'org-1' },
      error: null,
    },
    'rpc:public_link_eligible_items': (call) => {
      rpcCalls.push(call);
      return eligible(call);
    },
    'inventory_items.select': servedLikePostgrest(
      ids.map((id, i) => ({
        id,
        organization_id: 'org-1',
        name: `Book ${i}`,
        unit_cost: 4,
        is_bundle: false,
      })),
    ),
    'order_requests.insert.single': {
      data: { id: 'req-1', organization_id: 'org-1', warehouse_id: WAREHOUSE_ID },
      error: null,
    },
    'order_request_lines.insert': { data: null, error: null },
    'rpc:cleanup_expired_unconfirmed_order_requests': { data: null, error: null },
  });
  adminHolder.client = stub.client;
  return { ids, rpcCalls, stub };
}

describe('POST /api/v1/public/order-requests: eligibility past 1000 items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminHolder.client = null;
  });

  it('1000 eligible items: the last one is accepted', async () => {
    const { ids } = wire(1000);
    const res = await POST(request([{ itemId: ids[999]!, quantity: 1 }]));
    expect(res.status).toBe(200);
  });

  // Mutation caught: the unpaged read (the 1001st row never came back).
  it('1001 eligible items: the 1001st is accepted, not refused as unavailable', async () => {
    const { ids, stub } = wire(1001);
    const res = await POST(request([{ itemId: ids[1000]!, quantity: 2 }]));
    expect(res.status).toBe(200);
    expect(stub.chainsAll.get('order_request_lines.insert')).toHaveLength(1);
  });

  it('asks the function about the request’s own items only', async () => {
    const { ids, rpcCalls } = wire(1001);
    await POST(
      request([
        { itemId: ids[1000]!, quantity: 1 },
        { itemId: ids[3]!, quantity: 1 },
      ]),
    );
    const awaited = rpcCalls.filter((c) => c.methods.length > 1);
    expect(awaited).toHaveLength(1);
    expect(callArgs(awaited[0]!, 'in')).toEqual(['item_id', [ids[1000], ids[3]]]);
  });

  it('an item the link does not offer is still refused', async () => {
    wire(1001);
    const res = await POST(request([{ itemId: uuid(5000), quantity: 1 }]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_line' });
  });
});
