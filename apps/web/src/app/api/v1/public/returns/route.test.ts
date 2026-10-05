import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/server/services/context';

/**
 * The public return submit (returns RX-1): honeypot, the 10,000-unit cap,
 * hashed rate-limit keys (the raw token never reaches the rate-limit table),
 * the idempotency key passed through, a forged disposition stripped, and ONE
 * answer for every closed door (unknown token, module off). Closes the audit's
 * "public route untested" gap.
 */

const checkRateLimit = vi.fn(async (..._a: unknown[]) => ({ allowed: true, count: 1, resetAt: Date.now() + 3_600_000 }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock('server-only', () => ({}));
const createRequesterReturn = vi.fn(async (..._a: unknown[]) => ({ id: 'ret-1', returnNumber: 'RMA-1', organizationId: 'org-1', replay: false }));
vi.mock('@/server/services/returns', () => ({ createRequesterReturn: (...a: unknown[]) => createRequesterReturn(...a) }));

import { POST } from './route';

const TOKEN = 'AAAAAAAA-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

function req(body: unknown) {
  return new Request('https://test.local/api/v1/public/returns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const good = { token: TOKEN, reasonCode: 'damaged', lines: [{ orderRequestLineId: LINE, quantity: 1 }] };

beforeEach(() => vi.clearAllMocks());

describe('POST /api/v1/public/returns', () => {
  it('the honeypot answers a fake success and creates nothing', async () => {
    const res = await POST(req({ ...good, hp: 'https://spam.example' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'ok' });
    expect(createRequesterReturn).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('refuses more than 10,000 units in one request', async () => {
    const res = await POST(
      req({ ...good, lines: [{ orderRequestLineId: LINE, quantity: 6000 }, { orderRequestLineId: KEY, quantity: 6000 }] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('too_many_units');
    expect(createRequesterReturn).not.toHaveBeenCalled();
  });

  it('keys the token bucket by sha256(token), never the raw token', async () => {
    await POST(req(good));
    const keys = checkRateLimit.mock.calls.map((c) => String(c[0]));
    expect(keys.some((k) => k.includes(TOKEN) || k.includes(TOKEN.toLowerCase()))).toBe(false);
    const hash = createHash('sha256').update(TOKEN.toLowerCase()).digest('hex');
    expect(keys).toContain(`public-return-request:token:${hash}`);
    expect(checkRateLimit.mock.calls.every((c) => c[3] === 'closed')).toBe(true);
  });

  it('passes the idempotency key; strips a forged disposition and anything else', async () => {
    const res = await POST(
      req({
        ...good,
        idempotencyKey: KEY,
        warehouseId: 'w',
        organizationId: 'o',
        status: 'approved',
        lines: [{ orderRequestLineId: LINE, quantity: 1, disposition: 'scrap', itemId: LINE }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [, token, input, opts] = createRequesterReturn.mock.calls[0]!;
    expect(token).toBe(TOKEN);
    expect(input).toEqual({ reasonCode: 'damaged', notes: undefined, lines: [{ orderRequestLineId: LINE, quantity: 1 }] });
    expect(opts).toEqual({ idempotencyKey: KEY });
  });

  it.each([
    ['not_found', 'This return link is invalid or has expired.'],
    ['module_disabled', 'Returns are turned off for this organization.'],
  ])('a closed door (%s) answers the one 404', async (code, message) => {
    createRequesterReturn.mockRejectedValueOnce(new ServiceError(code as 'not_found', message));
    const res = await POST(req(good));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'This return link is invalid or has expired.' });
  });

  it('an over-return keeps its words and reason; an internal error stays generic', async () => {
    createRequesterReturn.mockRejectedValueOnce(
      new ServiceError('validation_error', 'That is more than was handed over.', { reason: 'return_exceeds_fulfilled' }),
    );
    const res = await POST(req(good));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'That is more than was handed over.',
      details: { reason: 'return_exceeds_fulfilled' },
    });

    createRequesterReturn.mockRejectedValueOnce(new ServiceError('internal_error', 'relation does not exist'));
    const res2 = await POST(req(good));
    expect(res2.status).toBe(500);
    expect(JSON.stringify(await res2.json())).not.toMatch(/relation/);
  });

  it('429 from either fail-closed bucket', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 11, resetAt: Date.now() + 1000 });
    const res = await POST(req(good));
    expect(res.status).toBe(429);
    expect(createRequesterReturn).not.toHaveBeenCalled();
  });

  it('a malformed body gets one generic 400', async () => {
    const res = await POST(req({ token: 'not-a-uuid', lines: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_error', message: 'Check the items and quantities, then try again.' });
  });
});
