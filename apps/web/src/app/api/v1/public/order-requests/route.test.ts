import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Regression guard for P0 #5: the UNAUTHENTICATED public order-request
 * submit endpoint must reject over-limit traffic with a 429 and METER
 * the hit so abuse is observable.
 *
 * The endpoint authenticates the org (not a user) via a persistent
 * public token and writes through the service-role admin client. The
 * three fail-closed rate-limit buckets (per-IP / per-email / per-token,
 * migration 0048) plus the metric are the load-bearing defense; this
 * suite pins both.
 *
 * Strategy: mock `@/lib/rate-limit#checkRateLimit` so we control each
 * bucket's verdict deterministically (no DB), and mock `reportError` to
 * assert the hit metric fires. The 429 path returns BEFORE any admin DB
 * call, so the denial tests don't need a wired Supabase stub; the
 * "under the limit proceeds" test wires the full happy path to prove
 * the limiter isn't accidentally blocking legitimate submissions.
 */

interface RateLimitResult {
  allowed: boolean;
  count: number;
  resetAt: number;
}

// Controllable rate limiter. Default = allowed; tests override per key.
const checkRateLimitMock =
  vi.fn<
    (key: string, limit: number, windowMs: number, mode?: 'open' | 'closed') => Promise<RateLimitResult>
  >();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (
    key: string,
    limit: number,
    windowMs: number,
    mode?: 'open' | 'closed',
  ) => checkRateLimitMock(key, limit, windowMs, mode),
}));

// Metric sink. Assert the rate-limit HIT is reported (warning level,
// non-PII extras) so sustained abuse is observable.
const reportErrorMock = vi.fn(async (_err: unknown, _ctx: unknown) => undefined);
vi.mock('@/lib/error-reporter', () => ({
  reportError: (err: unknown, ctx: unknown) => reportErrorMock(err, ctx),
}));

// Confirmation email is best-effort + side-effecting; stub it out.
const sendOrderRequestEmailMock = vi.fn(async (_arg: unknown) => undefined);
vi.mock('@/lib/email/order-requests', () => ({
  sendOrderRequestEmail: (arg: unknown) => sendOrderRequestEmailMock(arg),
}));

// Admin client points at a mutable holder a test fills per-case.
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

import { POST } from './route';

const TOKEN = 'pub_token_abcdef0123456789';
const WAREHOUSE_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    warehouseId: WAREHOUSE_ID,
    requesterName: 'Jane Teacher',
    requesterEmail: 'jane@school.edu',
    lines: [{ itemId: ITEM_ID, quantity: 3 }],
    ...overrides,
  };
}

function buildRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://test.local/api/v1/public/order-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

/** Wire the admin stub for the full happy-path submission. */
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

describe('POST /api/v1/public/order-requests — rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminHolder.client = null;
    // Reset to the default allow-all verdict each test.
    checkRateLimitMock.mockImplementation(
      async (_key, _limit, windowMs) => ({
        allowed: true,
        count: 1,
        resetAt: Date.now() + windowMs,
      }),
    );
  });

  it('returns 429 (and never touches the DB) when the per-IP bucket is over the limit', async () => {
    checkRateLimitMock.mockImplementation(async (key, limit, windowMs) => {
      const allowed = !key.startsWith('public-order-request:') || key.includes(':email:') || key.includes(':token:') || key.includes(':fanout');
      return { allowed, count: allowed ? 1 : limit, resetAt: Date.now() + windowMs };
    });

    const res = await POST(buildRequest(validBody()));

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    // retry-after surfaced so a polite client backs off.
    expect(res.headers.get('retry-after')).toBeTruthy();
    // Denial short-circuits BEFORE any admin DB work.
    expect(adminHolder.client).toBeNull();
  });

  it('meters the rate-limit HIT via reportError (warning level, non-PII extras)', async () => {
    checkRateLimitMock.mockImplementation(async (key, limit, windowMs) => {
      const isIp = key.startsWith('public-order-request:') &&
        !key.includes(':email:') && !key.includes(':token:') && !key.includes(':fanout');
      return { allowed: !isIp, count: isIp ? limit : 1, resetAt: Date.now() + windowMs };
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(429);

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const call = reportErrorMock.mock.calls[0]!;
    const err = call[0];
    const ctx = call[1] as Record<string, unknown>;
    expect(ctx.tag).toBe('public.order-requests.rate-limited');
    expect(ctx.level).toBe('warning');
    const extra = ctx.extra as Record<string, unknown>;
    expect(extra.bucket).toBe('ip');
    // Non-PII: token is truncated to a prefix, never the full token /
    // requester email / raw IP.
    expect(String(extra.tokenPrefix).length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(ctx)).not.toContain('jane@school.edu');
    expect(JSON.stringify(ctx)).not.toContain(TOKEN);
    expect(err).toBeInstanceOf(Error);
  });

  it('returns 429 when the per-EMAIL bucket is over the limit (IP under)', async () => {
    checkRateLimitMock.mockImplementation(async (key, limit, windowMs) => {
      const isEmail = key.includes(':email:');
      return { allowed: !isEmail, count: isEmail ? limit : 1, resetAt: Date.now() + windowMs };
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(429);
    const ctx = reportErrorMock.mock.calls[0]![1] as Record<string, unknown>;
    expect((ctx.extra as Record<string, unknown>).bucket).toBe('email');
  });

  it('returns 429 when the per-TOKEN bucket is over the limit (IP + email under)', async () => {
    checkRateLimitMock.mockImplementation(async (key, limit, windowMs) => {
      const isToken = key.includes(':token:');
      return { allowed: !isToken, count: isToken ? limit : 1, resetAt: Date.now() + windowMs };
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(429);
    const ctx = reportErrorMock.mock.calls[0]![1] as Record<string, unknown>;
    expect((ctx.extra as Record<string, unknown>).bucket).toBe('token');
  });

  it('checks all three fail-CLOSED buckets (ip, email, token) on the submission path', async () => {
    wireHappyAdmin();
    await POST(buildRequest(validBody()));

    const closedKeys = checkRateLimitMock.mock.calls
      .filter((c) => c[3] === 'closed')
      .map((c) => c[0]);
    expect(closedKeys.some((k) => k.startsWith('public-order-request:') &&
      !k.includes(':email:') && !k.includes(':token:'))).toBe(true);
    expect(closedKeys.some((k) => k.includes('public-order-request:email:'))).toBe(true);
    expect(closedKeys.some((k) => k.includes('public-order-request:token:'))).toBe(true);
  });

  it('lets a submission UNDER all limits proceed (limiter does not block legitimate traffic)', async () => {
    wireHappyAdmin();
    const res = await POST(buildRequest(validBody()));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; trackUrl: string };
    expect(json.id).toBe('req-1');
    // No rate-limit hit metric on the happy path.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });
});
