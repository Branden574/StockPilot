import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  guardedSupabaseFetch,
  resetUrlLengthGuardForTests,
  URL_BLOCK_CHARS_PROD,
} from './url-length-guard';

const BASE = 'https://proj.supabase.co';

/** A PostgREST URL whose path plus query string is exactly `length` long. */
function restUrl(length: number, table = 'inventory_items'): string {
  const path = `/rest/v1/${table}`;
  const head = `?select=id&id=in.%28`;
  const pad = length - path.length - head.length;
  return `${BASE}${path}${head}${'a'.repeat(pad)}`;
}

function lengthOf(url: string): number {
  const u = new URL(url);
  return u.pathname.length + u.search.length;
}

const realFetch = vi.fn(async () => new Response('[]', { status: 200 }));

beforeEach(() => {
  resetUrlLengthGuardForTests();
  reportError.mockClear();
  realFetch.mockClear();
  vi.stubGlobal('fetch', realFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('guardedSupabaseFetch', () => {
  it('passes a short PostgREST request straight through', async () => {
    const url = restUrl(500);
    const res = await guardedSupabaseFetch(url, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(realFetch).toHaveBeenCalledWith(url, { method: 'GET' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('in production reports a URL over 6,000 characters once per key and still sends it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const url = restUrl(7_000);
    expect(lengthOf(url)).toBe(7_000);
    await guardedSupabaseFetch(url);
    await guardedSupabaseFetch(url);
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = reportError.mock.calls[0] as unknown as [
      Error,
      { tag: string; level: string; extra: Record<string, unknown> },
    ];
    expect(ctx.tag).toBe('supabase.url_length');
    expect(ctx.level).toBe('warning');
    expect(ctx.extra).toMatchObject({
      method: 'GET',
      table: '/rest/v1/inventory_items',
      length: 7_000,
      params: 'select,id',
    });
    // Parameter names only: never a value, which could be a user's search term.
    expect(JSON.stringify(ctx.extra)).not.toContain('aaaa');
  });

  it('in production refuses 15,500 characters with a 414 and never calls fetch', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await guardedSupabaseFetch(restUrl(15_500));
    expect(res.status).toBe(414);
    expect(realFetch).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('URL_TOO_LONG');
    expect(body.message).toContain('/rest/v1/inventory_items');
    expect(body.message).toContain('fetchAllRowsByIds');
    const [, ctx] = reportError.mock.calls[0] as unknown as [Error, { level: string }];
    expect(ctx.level).toBe('error');
  });

  it('in production refuses 17,000 characters and still sends 14,000', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await guardedSupabaseFetch(restUrl(17_000))).status).toBe(414);
    expect(realFetch).not.toHaveBeenCalled();
    expect((await guardedSupabaseFetch(restUrl(URL_BLOCK_CHARS_PROD - 500))).status).toBe(200);
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('outside production refuses 9,000 characters like the local gateway does', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await guardedSupabaseFetch(restUrl(9_000));
    expect(res.status).toBe(414);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('outside production warns at 7,000 characters and sends the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await guardedSupabaseFetch(restUrl(7_000));
    expect(res.status).toBe(200);
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('7000');
  });

  it('leaves a path outside /rest/v1/ alone however long it is', async () => {
    const url = `${BASE}/storage/v1/object/sign/bucket?x=${'a'.repeat(20_000)}`;
    const res = await guardedSupabaseFetch(url);
    expect(res.status).toBe(200);
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('measures a Request input and a URL input', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = new Request(restUrl(9_000), { method: 'HEAD' });
    expect((await guardedSupabaseFetch(req)).status).toBe(414);
    expect((await guardedSupabaseFetch(new URL(restUrl(9_000, 'tags')))).status).toBe(414);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('turns a refused request into a PostgREST error, not a thrown fetch', async () => {
    // postgrest-js retries a THROWN fetch three times (1 s, 2 s, 4 s) but not
    // a 414, so the guard must answer, never throw.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(BASE, 'anon-key', {
      global: { fetch: guardedSupabaseFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ids = Array.from(
      { length: 400 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const started = Date.now();
    const { data, error, status } = await client.from('inventory_items').select('id').in('id', ids);
    expect(Date.now() - started).toBeLessThan(500);
    expect(status).toBe(414);
    expect(data).toBeNull();
    expect(error?.code).toBe('URL_TOO_LONG');
    expect(realFetch).not.toHaveBeenCalled();
  });
});
