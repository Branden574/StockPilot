import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The public return request is validated before the rate limiter, for anyone,
 * so no body may make that validation throw: a throw escapes the handler and
 * the route answers 500. This schema coerces nothing (`quantity` is a plain
 * z.number() and `exchange` is passed through untouched for the service to
 * check), so bodies nested 500,000 levels deep (about 1 MB, the depth a 1 MB
 * body can reach) get the one malformed-body 400. If a later change makes the
 * check throw anyway, the body gets the same 400.
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
const DEPTH = 500_000;

/** Raw JSON text, sent as is: JSON.stringify itself overflows on these depths. */
function req(json: string) {
  return new Request('https://test.local/api/v1/public/returns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json,
  }) as unknown as Parameters<typeof POST>[0];
}

function nest(depth: number): string {
  return `${'['.repeat(depth)}1${']'.repeat(depth)}`;
}

function bodyWithLine(lineJson: string): string {
  return `{"token":"${TOKEN}","lines":[${lineJson}]}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/public/returns: nesting anywhere in the body never answers 500', () => {
  it.each([
    [
      'a line quantity',
      (n: string) => bodyWithLine(`{"orderRequestLineId":"${LINE}","quantity":${n}}`),
    ],
    ['a line', (n: string) => bodyWithLine(n)],
    [
      'the token',
      (n: string) => `{"token":${n},"lines":[{"orderRequestLineId":"${LINE}","quantity":1}]}`,
    ],
    ['the whole body', (n: string) => n],
  ])('%s nested 500,000 levels deep is the malformed-body 400', async (_where, build) => {
    const res = await POST(req(build(nest(DEPTH))));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(MALFORMED);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(createRequesterReturn).not.toHaveBeenCalled();
  });

  it('a deeply nested exchange is handed to the service untouched, after the rate limiter', async () => {
    const res = await POST(
      req(bodyWithLine(`{"orderRequestLineId":"${LINE}","quantity":1,"exchange":${nest(DEPTH)}}`)),
    );

    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalled();
    expect(createRequesterReturn).toHaveBeenCalledTimes(1);
  });

  it('if checking the body throws anyway, the answer is the 400, before the rate limiter', async () => {
    // Nothing in the schema throws today (the cases above); this pins what a
    // future change that does would get. safeParse is bound to each schema
    // when it is built, so the throw goes in the object parser it calls.
    const objectParse = vi.spyOn(z.ZodObject.prototype, '_parse').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      const res = await POST(req(bodyWithLine(`{"orderRequestLineId":"${LINE}","quantity":1}`)));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(MALFORMED);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(objectParse).toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(createRequesterReturn).not.toHaveBeenCalled();
    } finally {
      objectParse.mockRestore();
    }
  });
});
