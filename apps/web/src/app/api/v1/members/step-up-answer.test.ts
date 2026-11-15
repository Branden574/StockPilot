import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: a member whose account has an authenticator, on a
 * session signed in with the password alone, changes nothing through the
 * member routes, and is answered 401 `unauthenticated`.
 *
 * The refusal is withApiContext's (lib/auth/api-context.ts, core's
 * stepUpOwed): right after GoTrue accepts
 * the token, a verified factor on the account and a session not at aal2 give
 * no context, before the context read, the organization's rule or any table.
 * The route answers that as its own 401. A 401 and not a 403 on purpose: the
 * phone answers a 401 by asking GoTrue for the account, and that answer is
 * what brings its code screen up (apps/mobile/src/lib/use-account-gate.ts),
 * while a 403 is a permission answer it does not probe for.
 *
 * Driven here through the real apiContextGate and withApiContext, with only
 * GoTrue and the database client faked, for both routes. The routes' own
 * Answers lists are pinned too, so they say which answer that session gets
 * and never again promise it a 403 `aal2_required`.
 */

const refs = vi.hoisted(() => ({
  reads: [] as string[],
  factors: [] as Array<{ status: string }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/server/services/team', () => ({ TeamService: vi.fn() }));
vi.mock('@/server/services/user-categories', () => ({ UserCategoriesService: vi.fn() }));

/** GoTrue answers the token; anything past it would be recorded as a read. */
function fakeClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: USER, email: 'admin@example.test', factors: refs.factors } },
        error: null,
      }),
    },
    rpc: (name: string) => {
      refs.reads.push(`rpc:${name}`);
      return Promise.resolve({ data: null, error: { code: 'XX000', message: 'not in this test' } });
    },
    from: (table: string) => {
      refs.reads.push(`from:${table}`);
      throw new Error('no table read is expected');
    },
  };
}
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient() }));

import { TeamService } from '@/server/services/team';
import { UserCategoriesService } from '@/server/services/user-categories';

import { POST as categoryAccess } from './[id]/category-access/route';
import { PATCH as role } from './[id]/role/route';

const USER = '7c0ffee0-0000-4000-8000-000000000001';
const MEMBER = '7c0ffee0-0000-4000-8000-00000000000b';
const CATEGORY = '7c0ffee0-0000-4000-8000-00000000000c';

/** A token whose payload carries the given level (GoTrue, faked above, accepts it). */
function tokenAt(aal: 'aal1' | 'aal2'): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: USER, aal })}.signature`;
}

function bearerRequest(url: string, method: string, body: unknown, aal: 'aal1' | 'aal2') {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenAt(aal)}` },
    body: JSON.stringify(body),
  });
}

const ROUTES = [
  {
    name: 'PATCH /api/v1/members/[id]/role',
    file: '[id]/role/route.ts',
    service: TeamService,
    send: (aal: 'aal1' | 'aal2') =>
      role(
        bearerRequest(
          `https://test.local/api/v1/members/${MEMBER}/role`,
          'PATCH',
          { role: 'manager' },
          aal,
        ) as unknown as Parameters<typeof role>[0],
        { params: Promise.resolve({ id: MEMBER }) },
      ),
  },
  {
    name: 'POST /api/v1/members/[id]/category-access',
    file: '[id]/category-access/route.ts',
    service: UserCategoriesService,
    send: (aal: 'aal1' | 'aal2') =>
      categoryAccess(
        bearerRequest(
          `https://test.local/api/v1/members/${MEMBER}/category-access`,
          'POST',
          { categoryId: CATEGORY, granted: true },
          aal,
        ) as unknown as Parameters<typeof categoryAccess>[0],
        { params: Promise.resolve({ id: MEMBER }) },
      ),
  },
] as const;

describe.each(ROUTES)('$name: an account with an authenticator, password-only session', (route) => {
  beforeEach(() => {
    vi.clearAllMocks();
    refs.reads = [];
    refs.factors = [{ status: 'verified' }];
  });

  it('answers 401 unauthenticated, reads nothing past GoTrue and never reaches the service', async () => {
    const res = await route.send('aal1');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(refs.reads).toEqual([]);
    expect(route.service).not.toHaveBeenCalled();
  });

  it('is refused for the account, not for an unverified factor: none verified gets past the refusal', async () => {
    // Control: the same password-only token with a factor never verified owes
    // no code, so the context read starts (and, faked here, finds nothing).
    refs.factors = [{ status: 'unverified' }];
    await route.send('aal1').catch(() => undefined);

    expect(refs.reads.length).toBeGreaterThan(0);
  });
});

/** The route's doc comment over its handler: the block that lists its answers. */
function answersBlock(file: string): string {
  const source = readFileSync(path.join(__dirname, file), 'utf8');
  const start = source.indexOf(' * Answers:');
  const end = source.indexOf('*/', start);
  if (start < 0 || end < 0) throw new Error(`${file}: no Answers list found`);
  return source.slice(start, end).replace(/\n\s*\*\s*/g, ' ');
}

describe.each(ROUTES)('$name: its Answers list', (route) => {
  it('names the session that still owes its authenticator code under 401', () => {
    const block = answersBlock(route.file);
    const line401 = block.slice(block.indexOf('401'), block.indexOf('403'));

    expect(line401).toMatch(/authenticator code/);
  });

  it('never promises 403 aal2_required to that session', () => {
    const block = answersBlock(route.file);
    const line403 = block.slice(block.indexOf('403'), block.indexOf('404'));

    expect(line403).toMatch(/mfa_required/);
    expect(line403).not.toMatch(/aal2_required or mfa_required when the authenticator rule refused/);
    // aal2_required is named only with the one case that can still give it.
    if (line403.includes('aal2_required')) {
      expect(line403).toMatch(/aal2_required[^;]*could not be read/);
    }
  });
});

describe('self-test of the Answers reader', () => {
  it('finds both routes', () => {
    for (const r of ROUTES) expect(answersBlock(r.file)).toContain('401 `unauthenticated`');
  });
});
