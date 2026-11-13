import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/server/services/context';

const withApiContext = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: (...a: unknown[]) => withApiContext(...a) }));
const checkRateLimit = vi.fn(async (..._a: unknown[]) => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('server-only', () => ({}));
const load = vi.fn();
vi.mock('@/server/services/return-request-email', () => ({
  loadReturnRequestEmailForOrder: (...a: unknown[]) => load(...a),
}));

import { GET } from './route';

const ORDER = '11111111-1111-4111-8111-111111111111';
const CTX = {
  organizationId: 'org-1',
  userId: 'member-1',
  role: 'staff',
  supabase: {},
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set(['returns', 'orders']),
};
// Reserved test domains only.
const ANSWER = {
  recipients: { to: 'intake@warehouse.test', cc: 'copy@warehouse.test' },
  order: {
    orderNumber: 'SO-000103',
    requestedBy: 'Sample Requester',
    requesterEmail: 'requester@school.test',
    site: null,
    warehouseName: 'Main',
    link: `https://app.example.test/dashboard/orders/${ORDER}#your-requests`,
  },
};

const req = () =>
  new Request(`https://test.local/api/v1/orders/${ORDER}/return-request-email`, {
    headers: { authorization: 'Bearer t' },
  }) as unknown as Parameters<typeof GET>[0];
const params = (id = ORDER) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  withApiContext.mockResolvedValue(CTX);
  load.mockResolvedValue(ANSWER);
});

describe('GET /api/v1/orders/[id]/return-request-email', () => {
  it('401 when signed out, and nothing is read', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it('404 for an id that is not a uuid, and nothing is read', async () => {
    const res = await GET(req(), params('nope'));
    expect(res.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  it('403 while the returns module is off', async () => {
    withApiContext.mockResolvedValueOnce({ ...CTX, enabledModules: new Set(['orders']) });
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it('429 past the per-member read limit', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 121, resetAt: Date.now() + 5000 });
    const res = await GET(req(), params());
    expect(res.status).toBe(429);
    expect(load).not.toHaveBeenCalled();
  });

  it("200 for the order's own requester: the mailboxes and the order facts, no-store, scoped by the caller's context", async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual(ANSWER);
    expect(load).toHaveBeenCalledWith(CTX, ORDER);
  });

  it("the one 404 for another member's, another organization's or a missing order", async () => {
    load.mockResolvedValueOnce(null);
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  it('an internal failure is a 500, never a 200 with half an answer', async () => {
    load.mockRejectedValueOnce(new ServiceError('internal_error', 'boom'));
    const res = await GET(req(), params());
    expect(res.status).toBe(500);
  });
});
