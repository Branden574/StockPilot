import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan 2.1 rule 21 (review 9.7): the console gate refuses an account that
 * holds a passkey bridge, since a bridge answer is a fresh `totp` entry and
 * would pass the console's step-up rule. Refused for a reserved-name factor
 * in Auth's own list, for a bridge row in our table, and when the table
 * cannot be read; a table that does not exist yet records nothing. The same
 * real session reads as platform-admin.gates.test.ts.
 */

const record = vi.hoisted(() => ({
  answer: { data: null, error: null } as { data: unknown; error: unknown },
  throws: false,
  reads: 0,
}));

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar), headers: async () => new Headers() };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
      STOCKPILOT_PLATFORM_ADMIN_EMAILS: f.FIXTURE_EMAIL,
    },
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (record.throws) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              record.reads += 1;
              expect(table).toBe('passkey_bridges');
              return record.answer;
            },
          }),
        }),
      }),
    };
  },
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('./session', () => ({
  requireSession: vi.fn(async () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  })),
}));

import {
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { checkPlatformAdmin, currentUserIsPlatformAdmin, requirePlatformAdmin } from './platform-admin';

let projectKey: SigningKey;
let server: FakeAuthServer;
let extraFactor: Record<string, unknown> | null = null;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
});

beforeEach(() => {
  server = fakeAuthServer(projectKey);
  extraFactor = null;
  record.answer = { data: null, error: null };
  record.throws = false;
  record.reads = 0;
  // Auth's own list, with a factor added when a case asks for one.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await server.fetch(input as string, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/user') || !extraFactor || res.status !== 200) return res;
    const body = (await res.json()) as { factors: unknown[] };
    body.factors = [...body.factors, extraFactor];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signInAal2() {
  const claims = sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 });
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims);
}

describe('the console refuses a passkey bridge holder (rule 21)', () => {
  it('control: no bridge anywhere, the console opens', async () => {
    await signInAal2();
    await expect(requirePlatformAdmin()).resolves.toBeTruthy();
    expect(record.reads).toBe(1);
  });

  for (const status of ['verified', 'unverified']) {
    it(`a factor carrying the reserved name (${status}) is refused before the table is read`, async () => {
      await signInAal2();
      extraFactor = { id: 'bridge-1', factor_type: 'totp', status, friendly_name: 'sp-passkey-bridge-0123456789ab' };
      await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
      expect(await currentUserIsPlatformAdmin()).toBe(false);
      expect(await checkPlatformAdmin({ requireStepUp: true })).toMatchObject({ ok: false });
      expect(record.reads).toBe(0);
    });
  }

  it('a bridge row in our table is refused', async () => {
    await signInAal2();
    record.answer = { data: { factor_id: 'f-1' }, error: null };
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
    expect(await checkPlatformAdmin({ requireStepUp: true })).toMatchObject({ ok: false });
  });

  it('a table that cannot be read is refused (an error, or no service key)', async () => {
    await signInAal2();
    record.answer = { data: null, error: { code: '57014', message: 'canceling statement' } };
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
    record.answer = { data: null, error: null };
    record.throws = true;
    await expect(requirePlatformAdmin()).rejects.toThrow('NOT_FOUND');
  });

  for (const code of ['PGRST205', '42P01']) {
    it(`a table that does not exist yet (${code}) records nothing: the console opens`, async () => {
      await signInAal2();
      record.answer = { data: null, error: { code, message: 'passkey_bridges' } };
      await expect(requirePlatformAdmin()).resolves.toBeTruthy();
    });
  }
});
