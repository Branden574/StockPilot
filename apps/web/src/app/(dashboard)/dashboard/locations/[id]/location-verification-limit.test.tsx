// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODULE_IDS,
  VERIFICATION_RATE_LIMITED_COPY,
  type ModuleId,
} from '@stockpilot/core';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * ONE bucket for a person's location page reads (B25, integrator decision
 * 2026-10-25). The limit used to sit on GET /api/v1/locations/[id]/verification
 * alone, while this web page ran the same VerificationService.location() read
 * with no limit, so a signed-in browser could repeat the expensive read (every
 * holding at the location and every holding's summary, on every page) through
 * the page as often as it liked. The limit now lives in location() itself.
 *
 * Executed end to end: the REAL page and the REAL route, the REAL
 * VerificationService over a stubbed database, and a limiter that answers as
 * increment_rate_limit (0048) does: per key, the first `limit` calls in a
 * window are allowed, and a refused call is not counted. Only the session
 * lookups, the database and the limiter's storage are stand-ins.
 */

const limiter = vi.hoisted(() => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    buckets,
    check: async (key: string, limit: number, windowMs: number) => {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        const fresh = { count: 1, resetAt: now + windowMs };
        buckets.set(key, fresh);
        return { allowed: true, count: 1, resetAt: fresh.resetAt };
      }
      if (bucket.count >= limit)
        return { allowed: false, count: bucket.count, resetAt: bucket.resetAt };
      bucket.count += 1;
      return { allowed: true, count: bucket.count, resetAt: bucket.resetAt };
    },
  };
});
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: limiter.check }));

const { withContextMock, reportError } = vi.hoisted(() => ({
  withContextMock: vi.fn(),
  reportError: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: (...a: unknown[]) => reportError(...(a as [])),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({
      hasAllAccess: true,
      readableIds: [],
      writableIds: [],
    })),
    assertWarehouseAccess: vi.fn(async () => undefined),
  };
});
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/actions/exceptions', () => ({
  listItemsRecountTargetsAction: vi.fn(),
  listCountAssigneesAction: vi.fn(),
  startRecountAction: vi.fn(),
}));

import { GET } from '@/app/api/v1/locations/[id]/verification/route';
import { withApiContext } from '@/lib/auth/api-context';

import LocationPage from './page';

const LOC = '22222222-2222-4222-8222-222222222222';
const URL_ = `https://t.local/api/v1/locations/${LOC}/verification`;
const LIMIT = 60;

function itemId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** A location with two holdings, every read answering. */
function database() {
  const held = [1, 2].map((n) => ({
    id: `h-${n}`,
    organization_id: 'org-1',
    location_id: LOC,
    item_id: itemId(n),
    quantity: 1,
    item: { id: itemId(n), name: `Item ${n}`, sku: null },
  }));
  return makeSupabaseStub({
    'locations.select.maybeSingle': {
      data: {
        id: LOC,
        name: 'A-12',
        kind: 'rack',
        type: 'shelf',
        warehouse_id: 'wh-a',
        deleted_at: null,
        warehouse: { name: 'Main' },
      },
      error: null,
    },
    'rpc:location_holdings_visible': { data: true, error: null },
    'item_stock_levels.select': servedLikePostgrest(held),
    'rpc:item_verification_summaries': { data: [], error: null },
    'exception_occurrences.select': servedLikePostgrest([]),
    'exception_sync_state.select.maybeSingle': {
      data: { last_synced_at: '2026-09-24T18:00:02Z' },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Chicago' }, error: null },
  });
}

/** One person, signed in on the web (cookie) and on the phone (Bearer). */
function signedIn(userId: string) {
  const stub = database();
  const ctx = {
    organizationId: 'org-1',
    userId,
    role: 'manager',
    supabase: stub.client,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS),
  };
  withContextMock.mockResolvedValue(ctx);
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

/** The web page for the location, as the server renders it. */
function openPage() {
  return LocationPage({
    params: Promise.resolve({ id: LOC }),
    searchParams: Promise.resolve({}),
  });
}

/** The phone's read of the same location. */
function phoneRead() {
  return GET(new Request(URL_, { headers: { authorization: 'Bearer token-1' } }) as never, {
    params: Promise.resolve({ id: LOC }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  limiter.buckets.clear();
});
afterEach(() => {
  cleanup();
});

describe('a person has ONE budget of location page reads, on the web page and the phone together', () => {
  it('60 web page reads, then the phone is refused (429 in its usual shape), and so is the page', async () => {
    signedIn('u-1');
    for (let i = 0; i < LIMIT; i += 1) {
      render(await openPage());
      expect(screen.getByRole('heading', { level: 1, name: /A-12/ })).toBeInTheDocument();
      cleanup();
    }

    const res = await phoneRead();
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toEqual({
      error: 'rate_limited',
      message: VERIFICATION_RATE_LIMITED_COPY,
      retryAt: expect.any(Number),
    });

    render(await openPage());
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
    expect(screen.getByTestId('location-refusal')).toHaveTextContent(
      'Too many reads in a short time. Try again in a minute.',
    );
    expect(reportError).not.toHaveBeenCalled();
    expect([...limiter.buckets.keys()]).toEqual(['location-verification:user:u-1']);
  });

  it('the reverse: 60 phone reads, then the web page says "Too many reads" instead of the location', async () => {
    signedIn('u-1');
    for (let i = 0; i < LIMIT; i += 1) expect((await phoneRead()).status).toBe(200);

    render(await openPage());
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load verification");
    expect(screen.getByTestId('location-refusal')).toHaveTextContent(
      'Too many reads in a short time. Try again in a minute.',
    );
    expect(screen.queryByRole('heading', { name: /A-12/ })).not.toBeInTheDocument();
    expect(reportError).not.toHaveBeenCalled();
    expect((await phoneRead()).status).toBe(429);
  });

  it('a refused read reads nothing, and another person keeps their own budget', async () => {
    const spent = signedIn('u-1');
    for (let i = 0; i < LIMIT; i += 1) await openPage();
    const readsBefore = spent.fromCalls.length + spent.rpcCalls.length;
    await openPage();
    expect((await phoneRead()).status).toBe(429);
    expect(spent.fromCalls.length + spent.rpcCalls.length).toBe(readsBefore);

    signedIn('u-2');
    expect((await phoneRead()).status).toBe(200);
    render(await openPage());
    expect(screen.getByRole('heading', { level: 1, name: /A-12/ })).toBeInTheDocument();
  });
});
