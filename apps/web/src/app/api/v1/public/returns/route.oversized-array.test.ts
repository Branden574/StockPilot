import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * GHSA-mrhx-c7xc-m3w5 stopgap on the UNAUTHENTICATED public return request.
 * zod 3 keeps parsing every element of an over-long array (one issue per bad
 * element, no cap; see lib/oversized-array.ts), so the route refuses a body
 * holding an array longer than its 100-line limit BEFORE safeParse, with the
 * same 400 as any other malformed body, and before the rate limiter and the
 * service. "Before validation" is proven by watching zod's ZodArray._parse,
 * the loop the advisory is about: it never runs for a refused body, and does
 * run for a valid one.
 */

const checkRateLimit = vi.fn(async (..._a: unknown[]) => ({
  allowed: true,
  count: 1,
  resetAt: Date.now() + 3_600_000,
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock('server-only', () => ({}));
const createRequesterReturn = vi.fn(async (..._a: unknown[]) => ({
  id: 'ret-1',
  returnNumber: 'RMA-1',
  organizationId: 'org-1',
  replay: false,
}));
vi.mock('@/server/services/returns', () => ({
  createRequesterReturn: (...a: unknown[]) => createRequesterReturn(...a),
}));

import { POST } from './route';

const TOKEN = 'AAAAAAAA-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const MALFORMED = {
  error: 'validation_error',
  message: 'Check the items and quantities, then try again.',
};

function req(body: unknown) {
  return new Request('https://test.local/api/v1/public/returns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

let arrayParse: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  arrayParse = vi.spyOn(z.ZodArray.prototype, '_parse');
});

afterEach(() => {
  arrayParse.mockRestore();
});

describe('POST /api/v1/public/returns: an oversized array is refused before validation', () => {
  it('refuses 100,001 lines with the one malformed-body 400, without running the array parse', async () => {
    const res = await POST(req({ token: TOKEN, lines: new Array(100_001).fill(0) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(MALFORMED);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(arrayParse).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(createRequesterReturn).not.toHaveBeenCalled();
  });

  it('refuses 101 well-formed lines the same way', async () => {
    const lines = Array.from({ length: 101 }, () => ({ orderRequestLineId: LINE, quantity: 1 }));
    const res = await POST(req({ token: TOKEN, lines }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(MALFORMED);
    expect(arrayParse).not.toHaveBeenCalled();
  });

  it("refuses an oversized array inside a line's exchange", async () => {
    const res = await POST(
      req({
        token: TOKEN,
        lines: [
          { orderRequestLineId: LINE, quantity: 1, exchange: { note: new Array(101).fill('L') } },
        ],
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(MALFORMED);
    expect(arrayParse).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(createRequesterReturn).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/public/returns: a valid request still goes through', () => {
  it('a one-line return is validated and created', async () => {
    const res = await POST(
      req({
        token: TOKEN,
        reasonCode: 'damaged',
        lines: [{ orderRequestLineId: LINE, quantity: 1 }],
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'ret-1', returnNumber: 'RMA-1', replay: false });
    expect(arrayParse).toHaveBeenCalled();
    expect(createRequesterReturn).toHaveBeenCalledTimes(1);
  });

  it('exactly 100 lines pass the pre-check and reach validation and the service', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      orderRequestLineId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
      quantity: 1,
    }));
    const res = await POST(req({ token: TOKEN, lines }));

    expect(res.status).toBe(200);
    expect(arrayParse).toHaveBeenCalled();
    const [, , input] = createRequesterReturn.mock.calls[0]!;
    expect((input as { lines: unknown[] }).lines).toHaveLength(100);
  });
});
