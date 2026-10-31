import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * GHSA-mrhx-c7xc-m3w5 stopgap on the UNAUTHENTICATED public order form.
 * zod 3 keeps parsing every element of an over-long array (one issue per bad
 * element, no cap; see lib/oversized-array.ts), so the route refuses a body
 * holding an array longer than its 100-line limit BEFORE safeParse, before the
 * rate limiter and before the admin client. "Before validation" is proven by
 * watching zod's ZodArray._parse, the loop the advisory is about: it never
 * runs for a refused body, and does run for a valid one.
 */

const checkRateLimitMock = vi.fn(async (_key: string, _limit: number, windowMs: number) => ({
  allowed: true,
  count: 1,
  resetAt: Date.now() + windowMs,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string, limit: number, windowMs: number) =>
    checkRateLimitMock(key, limit, windowMs),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: vi.fn(async () => undefined),
}));
const adminHolder = { client: null as unknown };
const createAdminClientMock = vi.fn(() => adminHolder.client);
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClientMock() }));

import { POST } from './route';

const TOKEN = 'pub_token_abcdef0123456789';
const WAREHOUSE_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';
const TOO_LONG = 'Array must contain at most 100 element(s)';

function body(lines: unknown) {
  return {
    token: TOKEN,
    warehouseId: WAREHOUSE_ID,
    requesterName: 'Jane Teacher',
    requesterEmail: 'jane@school.edu',
    lines,
  };
}

function post(payload: unknown) {
  return new Request('https://test.local/api/v1/public/order-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }) as unknown as Parameters<typeof POST>[0];
}

/** The full happy path (legacy organization token), as route.test.ts wires it. */
function wireHappyAdmin() {
  const stub = makeSupabaseStub({
    'organizations.select.maybeSingle': { data: { id: 'org-1' }, error: null },
    'organization_modules.select.maybeSingle': {
      data: { module_id: 'public_requests' },
      error: null,
    },
    'warehouses.select.maybeSingle': {
      data: { id: WAREHOUSE_ID, is_public_orderable: true, organization_id: 'org-1' },
      error: null,
    },
    'inventory_items.select': {
      data: [
        {
          id: ITEM_ID,
          warehouse_id: WAREHOUSE_ID,
          unit_cost: 8.5,
          item_type: 'book',
          status: 'active',
          deleted_at: null,
        },
      ],
      error: null,
    },
    // The header, side row and lines: one transaction (0413 review fix round).
    'rpc:insert_order_request_with_lines': {
      data: { id: 'req-1', organization_id: 'org-1', warehouse_id: WAREHOUSE_ID },
      error: null,
    },
    'rpc:cleanup_expired_unconfirmed_order_requests': { data: null, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

let arrayParse: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  adminHolder.client = null;
  arrayParse = vi.spyOn(z.ZodArray.prototype, '_parse');
});

afterEach(() => {
  arrayParse.mockRestore();
});

describe('POST /api/v1/public/order-requests: an oversized array is refused before validation', () => {
  it('refuses 100,001 lines with the 400 the schema gives, without running the array parse', async () => {
    const res = await POST(post(body(new Array(100_001).fill(0))));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_LONG });
    expect(arrayParse).not.toHaveBeenCalled();
    // Nothing past the refusal ran: no rate-limit write, no admin client.
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it('gives a cart of 101 valid lines the same words the schema gave it before', async () => {
    const lines = Array.from({ length: 101 }, () => ({ itemId: ITEM_ID, quantity: 1 }));
    const res = await POST(post(body(lines)));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_LONG });
    expect(arrayParse).not.toHaveBeenCalled();
    // The pre-check repeats the schema's own answer for this body.
    arrayParse.mockRestore();
    const schemaSays = z.array(z.unknown()).max(100).safeParse(lines);
    expect(schemaSays.success).toBe(false);
    expect(schemaSays.error?.issues[0]?.message).toBe(TOO_LONG);
  });

  it('refuses an oversized array nested inside a line', async () => {
    const res = await POST(
      post(body([{ itemId: ITEM_ID, quantity: 1, notes: new Array(101).fill('x') }])),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_LONG });
    expect(arrayParse).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('refuses an oversized array anywhere else in the body', async () => {
    const res = await POST(
      post({ ...body([{ itemId: ITEM_ID, quantity: 1 }]), hp: new Array(5000).fill(1) }),
    );

    expect(res.status).toBe(400);
    expect(arrayParse).not.toHaveBeenCalled();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/public/order-requests: a valid request still goes through', () => {
  it('a one-line request is validated and submitted', async () => {
    const stub = wireHappyAdmin();
    const res = await POST(post(body([{ itemId: ITEM_ID, quantity: 3 }])));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('req-1');
    expect(arrayParse).toHaveBeenCalled();
    expect(stub.rpcCalls.map((c) => c.name)).toContain('insert_order_request_with_lines');
  });

  it('exactly 100 lines pass the pre-check and reach validation', async () => {
    wireHappyAdmin();
    // 100 lines of one item: the route folds them into one line of 100 units.
    const lines = Array.from({ length: 100 }, () => ({ itemId: ITEM_ID, quantity: 1 }));
    const res = await POST(post(body(lines)));

    expect(res.status).toBe(200);
    expect(arrayParse).toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalled();
  });
});
