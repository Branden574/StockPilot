import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forbiddenRequesterKeys } from '@stockpilot/core';

/**
 * POST /api/v1/public/returns/options (returns RX-3): the token page's
 * exchange sizes. POST only with the token in the body, no-store on every
 * answer, one 404 for every closed door, fail-closed limits keyed by IP and
 * sha256(token), and no input but the token (no oracle).
 */

const checkRateLimit = vi.fn(async (..._a: unknown[]) => ({ allowed: true, count: 1, resetAt: Date.now() + 3_600_000 }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
const reportError = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock('server-only', () => ({}));

const ANSWER = {
  exchangesEnabled: true,
  lines: [
    {
      orderRequestLineId: '22222222-2222-4222-8222-222222222222',
      options: [
        {
          itemId: '33333333-3333-4333-8333-333333333333',
          name: 'New Hire Shirt',
          sizeLabel: 'Size L',
          availability: 'available',
          photo: { url: 'https://signed.example/l', thumbUrl: null },
        },
      ],
    },
  ],
};
const exchangeOptionsForToken = vi.fn(async (..._a: unknown[]): Promise<unknown> => ANSWER);
vi.mock('@/server/services/returns-requester', () => ({
  exchangeOptionsForToken: (...a: unknown[]) => exchangeOptionsForToken(...a),
}));

import * as routeModule from './route';
import { POST } from './route';

const TOKEN = 'AAAAAAAA-1111-4111-8111-111111111111';

function req(body: unknown, raw = false) {
  return new Request('https://test.local/api/v1/public/returns/options', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' },
    body: raw ? (body as string) : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/v1/public/returns/options', () => {
  it('is POST only: the token never rides in a URL (no GET handler)', () => {
    expect(Object.keys(routeModule)).not.toContain('GET');
    expect(typeof routeModule.POST).toBe('function');
  });

  it('answers the sizes, no-store, and nothing a requester may not see', async () => {
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual(ANSWER);
    expect(forbiddenRequesterKeys(body)).toEqual([]);
  });

  it('reads nothing from the body but the token (no item, group, warehouse or quantity input: no oracle)', async () => {
    await POST(
      req({
        token: TOKEN,
        itemId: '33333333-3333-4333-8333-333333333333',
        groupId: 'g',
        warehouseId: 'w',
        quantity: 999,
        orderRequestLineId: 'x',
      }),
    );
    expect(exchangeOptionsForToken).toHaveBeenCalledTimes(1);
    expect(exchangeOptionsForToken.mock.calls[0]).toEqual([{ admin: true }, TOKEN]);
  });

  it.each([
    ['an unknown token, an order not returnable, or the module off (the service answers null)', { token: TOKEN }, true],
    ['a malformed token', { token: 'not-a-token' }, false],
    ['no token', {}, false],
  ])('%s: the one 404, no-store', async (_label, body, reachesService) => {
    exchangeOptionsForToken.mockResolvedValueOnce(null);
    const res = await POST(req(body));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'not_found', message: 'This return link is invalid or has expired.' });
    expect(exchangeOptionsForToken).toHaveBeenCalledTimes(reachesService ? 1 : 0);
  });

  it('keys both fail-closed buckets without the raw token: 120 an hour per IP, 600 per sha256(token)', async () => {
    await POST(req({ token: TOKEN }));
    const calls = checkRateLimit.mock.calls.map((c) => ({ key: String(c[0]), limit: c[1], window: c[2], mode: c[3] }));
    expect(calls.some((c) => c.key.includes(TOKEN) || c.key.includes(TOKEN.toLowerCase()))).toBe(false);
    const hash = createHash('sha256').update(TOKEN.toLowerCase()).digest('hex');
    expect(calls).toContainEqual({ key: `public-return-options:token:${hash}`, limit: 600, window: 3_600_000, mode: 'closed' });
    expect(calls).toContainEqual({ key: 'public-return-options:ip:203.0.113.7', limit: 120, window: 3_600_000, mode: 'closed' });
  });

  it('429 from either bucket, before any lookup, no-store', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 121, resetAt: Date.now() + 1000 });
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(exchangeOptionsForToken).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is a 400, no-store', async () => {
    const res = await POST(req('{not json', true));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a fault is a generic 500 with words to try again; the report never carries the token', async () => {
    exchangeOptionsForToken.mockRejectedValueOnce(new Error('relation does not exist'));
    const res = await POST(req({ token: TOKEN }));
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error', message: "Couldn't load the other sizes. Try again." });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(TOKEN);
  });
});
