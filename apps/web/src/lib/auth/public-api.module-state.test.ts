import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * authorizePublicApi turns the key resolver's failure into the response a
 * public API route returns. When the organization's module state could not be
 * read the resolver answers 503 with a wait: the response carries Retry-After
 * and is never stored, and it is not the 403 a module that is off gets.
 */

const key = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('./api-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-key')>()),
  withApiKey: vi.fn(async () => key.result),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { authorizePublicApi } from './public-api';

const request = () => new Request('https://app.test/api/public/v1/items');

beforeEach(() => {
  key.result = null;
});

describe('authorizePublicApi', () => {
  it('a module state that could not be read: 503, Retry-After, no-store, and the try-again sentence', async () => {
    key.result = {
      ok: false,
      status: 503,
      error: 'API access could not be checked. Please try again.',
      retryAfter: 5,
    };
    const out = await authorizePublicApi(request(), 'inventory:read');
    if (!('res' in out)) throw new Error('expected a response');
    expect(out.res.status).toBe(503);
    expect(out.res.headers.get('retry-after')).toBe('5');
    expect(out.res.headers.get('cache-control')).toBe('no-store');
    expect(await out.res.json()).toEqual({
      error: 'API access could not be checked. Please try again.',
    });
  });

  it('a module that is off: 403 with its own words and no Retry-After, as before', async () => {
    key.result = {
      ok: false,
      status: 403,
      error: 'API access is not enabled for this organization.',
    };
    const out = await authorizePublicApi(request(), 'inventory:read');
    if (!('res' in out)) throw new Error('expected a response');
    expect(out.res.status).toBe(403);
    expect(out.res.headers.get('retry-after')).toBeNull();
    expect(await out.res.json()).toEqual({
      error: 'API access is not enabled for this organization.',
    });
  });

  it('a rate limit keeps its Retry-After', async () => {
    key.result = { ok: false, status: 429, error: 'Rate limit exceeded.', retryAfter: 12 };
    const out = await authorizePublicApi(request(), 'inventory:read');
    if (!('res' in out)) throw new Error('expected a response');
    expect(out.res.status).toBe(429);
    expect(out.res.headers.get('retry-after')).toBe('12');
  });

  it('a key that resolves and holds the scope gets its context', async () => {
    key.result = {
      ok: true,
      ctx: { organizationId: 'org-1', keyId: 'key-1', scopes: ['inventory:read'] },
    };
    expect(await authorizePublicApi(request(), 'inventory:read')).toEqual({
      ctx: { organizationId: 'org-1', keyId: 'key-1', scopes: ['inventory:read'] },
    });
  });
});
