import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every Supabase client that reads data passes the URL-length guard as its
 * fetch. Without it a long `.in()` list fails in production only after
 * postgrest-js has retried it for about 7 s.
 */

const seen = vi.hoisted(() => ({
  supabaseJs: [] as Array<{ options: Record<string, unknown> | undefined }>,
  server: [] as Array<{ options: Record<string, unknown> | undefined }>,
  browser: [] as Array<{ options: Record<string, unknown> | undefined }>,
}));

const env = vi.hoisted(() => ({
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
}));

vi.mock('@/lib/env', () => ({ env }));
vi.mock('@/lib/env.client', () => ({ env }));
const reporters = vi.hoisted(() => ({
  server: vi.fn(async () => {}),
  core: vi.fn(async () => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: reporters.server }));
vi.mock('@/lib/error-reporter-core', () => ({ reportError: reporters.core }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));

/** A client that answers the Bearer path's user lookup and returns an error
 *  for every later read, so withApiContext stops right after building its
 *  data client. */
function fakeClient() {
  const failed = { data: null, error: { message: 'stop' } };
  const chain = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) =>
        prop === 'then' ? (resolve: (v: unknown) => void) => resolve(failed) : () => chain(),
    });
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }),
    },
    rpc: () => chain(),
    from: () => chain(),
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options?: Record<string, unknown>) => {
    seen.supabaseJs.push({ options });
    return fakeClient();
  },
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options?: Record<string, unknown>) => {
    seen.server.push({ options });
    return fakeClient();
  },
  createBrowserClient: (_url: string, _key: string, options?: Record<string, unknown>) => {
    seen.browser.push({ options });
    return fakeClient();
  },
}));

import { guardedSupabaseFetch, resetUrlLengthGuardForTests } from './url-length-guard';
import { guardedServerSupabaseFetch } from './url-length-guard.server';

function globalFetch(options: Record<string, unknown> | undefined): unknown {
  return (options?.global as { fetch?: unknown } | undefined)?.fetch;
}

beforeEach(() => {
  seen.supabaseJs.length = 0;
  seen.server.length = 0;
  seen.browser.length = 0;
});

describe('Supabase clients use the URL-length guard', () => {
  it('the service-role client', async () => {
    const { createAdminClient } = await import('./admin');
    createAdminClient();
    expect(globalFetch(seen.supabaseJs[0]?.options)).toBe(guardedServerSupabaseFetch);
  });

  it('the cookie server client', async () => {
    const { createClient } = await import('./server');
    await createClient();
    expect(globalFetch(seen.server[0]?.options)).toBe(guardedServerSupabaseFetch);
  });

  it('the browser client', async () => {
    const { createClient } = await import('./client');
    createClient();
    expect(globalFetch(seen.browser[0]?.options)).toBe(guardedSupabaseFetch);
  });

  it('the Bearer data client, keeping its Authorization header', async () => {
    const { withApiContext } = await import('@/lib/auth/api-context');
    const req = new Request('https://app.example/api/v1/items', {
      headers: { authorization: 'Bearer token-abc' },
    });
    await withApiContext(req).catch(() => null);
    // [0] validates the token (auth only); [1] is the data client.
    const dataClient = seen.supabaseJs[1]?.options;
    expect(globalFetch(dataClient)).toBe(guardedServerSupabaseFetch);
    expect((dataClient?.global as { headers?: Record<string, string> }).headers).toEqual({
      Authorization: 'Bearer token-abc',
    });
  });
});

describe('which reporter each guard uses', () => {
  // Mutation caught: the server clients reporting through the core reporter,
  // whose POST nothing keeps alive once the route has answered.
  it('the server guard reports through the server reportError, the browser guard through the core', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 })),
    );
    resetUrlLengthGuardForTests();
    const long = (table: string) =>
      `https://example.supabase.co/rest/v1/${table}?select=id&id=in.%28${'a'.repeat(7_000)}`;
    await guardedServerSupabaseFetch(long('orders'));
    expect(reporters.server).toHaveBeenCalledTimes(1);
    expect(reporters.core).not.toHaveBeenCalled();
    await guardedSupabaseFetch(long('items'));
    expect(reporters.core).toHaveBeenCalledTimes(1);
    expect(reporters.server).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
