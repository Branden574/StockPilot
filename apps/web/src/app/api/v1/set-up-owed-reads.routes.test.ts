// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';

/**
 * Every /api/v1 GET handler that serves organization data, for a member who
 * must set up an authenticator first: the context is withApiContext's
 * (mocked here; the real one is server/lib/api-read-context.set-up-reads.test.ts)
 * labelled as set-up owed, and every handler answers 403 `forbidden` with
 * core's sentence and `details.reason: 'mfa_required'`, not stored, before
 * any read of its own: no table, no service client, no rate-limit slot.
 *
 * The writes in the same files (a POST, PATCH or DELETE beside the GET) and
 * the returns writes are not held by this answer: they reach their own
 * handling as before. The sign-in email status (account/email) is not held
 * either: a member reads their own email before setting up an authenticator.
 *
 * test/authenticator-read.guard.test.ts keeps this list complete from the
 * source tree: every GET handler under /api/v1 is held or listed as open.
 */

const h = vi.hoisted(() => ({ ctx: null as unknown, calls: [] as string[] }));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn(async () => h.ctx) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => {
    h.calls.push('rate-limit');
    return { allowed: true, count: 1, resetAt: Date.now() + 60_000 };
  }),
}));
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn(async () => {
    h.calls.push('export-rate-limit');
    return null;
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    h.calls.push('service client');
    throw new Error('service client used');
  },
}));

import { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';

const ID = '5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c';
const PARAMS = { id: ID, slug: 'a-release', groupId: ID, key: 'k-0123456789abcdef', itemId: ID };

/** A client that records any use and answers nothing. */
function recordingClient(): unknown {
  const recordUse = (name: string) => () => {
    h.calls.push(`client.${name}`);
    throw new Error(`client.${name} used`);
  };
  return new Proxy(
    {},
    {
      get: (_t, p) => {
        if (p === 'then') return undefined;
        if (p === 'auth' || p === 'storage') {
          return new Proxy(
            {},
            { get: (_x, q) => (q === 'then' ? undefined : recordUse(`${String(p)}.${String(q)}`)) },
          );
        }
        return recordUse(String(p));
      },
    },
  );
}

/** Every permission and module, so nothing but the authenticator answer can refuse. */
class Everything extends Set<string> {
  override has() {
    return true;
  }
}

function owedCtx() {
  return {
    organizationId: '1d1d1d1d-2e2e-4f3f-8a4a-5b5b5b5b5b5b',
    userId: '6c6c6c6c-7d7d-4e8e-8f9f-a0a0a0a0a0a0',
    role: 'admin',
    permissions: new Everything(),
    enabledModules: new Everything(),
    supabase: recordingClient(),
    mfaRequired: true,
    mfaSatisfied: false,
    mfaEnrolled: false,
  };
}

/** The GET handlers held by the answer (app/api/v1/<route>/route.ts or .tsx). */
const HELD_READS = [
  'books/isbn-lookup',
  'bundles',
  'cycle-counts',
  'cycle-counts/[id]/exceptions',
  'exceptions',
  'exceptions/[id]',
  'integrations/connections',
  'integrations/sync-log',
  'inventory/staging',
  'items/[id]/barcode',
  'items/[id]/history',
  'items/[id]/verification',
  'items/lookup',
  'items/upc-lookup',
  'locations/[id]/verification',
  'maintenance-requests',
  'maintenance-requests/[id]',
  'maintenance-requests/[id]/notes',
  'maintenance-requests/members',
  'me/announcements',
  'me/permissions',
  'me/releases',
  'me/releases/[slug]',
  'mobile/snapshot',
  'orders/[id]',
  'orders/[id]/drivers',
  'orders/[id]/exchange-candidates',
  'orders/[id]/return-request',
  'orders/[id]/return-request-email',
  'orders/[id]/shipping',
  'orders/[id]/signature',
  'orders/catalog',
  'orders/catalog-visibility',
  'orders/catalog-visibility/family/[groupId]',
  'orders/catalog/photos',
  'orders/storefront',
  'orders/submissions/[key]',
  'product-groups',
  'product-groups/[id]/variants',
  'product-groups/linking',
  'rentals/borrowers',
  'reports/book-order-totals',
  'reports/book-order-totals/covers',
  'reports/book-order-totals/export',
  'reports/book-order-totals/items/[itemId]/orders',
  'reports/book-order-totals/options',
  'returns',
  'returns/[id]',
  'returns/[id]/candidates',
  'returns/exchange-switch',
  'size-counts/[id]',
  'size-counts/training',
  'size-counts/training/samples',
  'zendesk/connection',
];

/** Writes in files that also export a GET, and two returns writes through the shared gates. */
const WRITES: Array<[string, string]> = [
  ['cycle-counts', 'POST'],
  ['maintenance-requests', 'POST'],
  ['maintenance-requests/[id]', 'PATCH'],
  ['maintenance-requests/[id]/notes', 'POST'],
  ['me/announcements', 'POST'],
  ['orders/[id]/return-request', 'POST'],
  ['orders/[id]/return-request/options', 'POST'],
  ['orders/catalog-visibility', 'POST'],
  ['product-groups/linking', 'POST'],
  ['product-groups/linking', 'DELETE'],
  ['returns/[id]/cancel', 'POST'],
  ['size-counts/training', 'POST'],
];

type Handler = (req: NextRequest, ctx: { params: Promise<typeof PARAMS> }) => Promise<Response>;

async function call(route: string, method: string): Promise<Response> {
  const mod = (await import(`./${route}/route`)) as Record<string, Handler>;
  const handler = mod[method === 'HEAD' ? 'GET' : method];
  expect(handler, `${route} exports ${method}`).toBeTypeOf('function');
  const url = `https://app.test/api/v1/${route.replace(/\[[a-zA-Z]+\]/g, ID)}?q=ab`;
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify({ name: 'x' });
  return handler!(new NextRequest(url, init), { params: Promise.resolve(PARAMS) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.ctx = owedCtx();
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

async function expectHeld(res: Response) {
  expect(res.status).toBe(403);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(await res.json()).toEqual({
    error: 'forbidden',
    message: AUTHENTICATOR_SET_UP_OWED_COPY,
    details: { reason: 'mfa_required' },
  });
  expect(h.calls).toEqual([]);
  expect(withApiContext).toHaveBeenCalledTimes(1);
}

describe('a GET by a member who must set up an authenticator first', () => {
  it.each(HELD_READS)(
    '%s: 403, core sentence, mfa_required, not stored, nothing read',
    async (route) => {
      await expectHeld(await call(route, 'GET'));
    },
  );

  it('a HEAD is held the same way', async () => {
    expect((await call('mobile/snapshot', 'HEAD')).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('a null context stays each route its own 401 (snapshot, returns, a member return)', async () => {
    h.ctx = null;
    for (const route of ['mobile/snapshot', 'returns', 'orders/[id]/return-request']) {
      expect((await call(route, 'GET')).status, route).toBe(401);
    }
  });

  it('the sign-in email status is not held: the member reads their own email', async () => {
    const res = await call('account/email', 'GET');
    expect(res.status).not.toBe(403);
    expect(h.calls).toContain('service client');
  });
});

describe('a write in the same files is not held by the read answer', () => {
  it.each(WRITES)('%s %s answers as it does without the read rule', async (route, method) => {
    const res = await call(route, method);
    const text = await res.text();
    expect(text).not.toContain(AUTHENTICATOR_SET_UP_OWED_COPY);
  });
});
