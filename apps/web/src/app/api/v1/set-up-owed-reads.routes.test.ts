// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHENTICATOR_SET_UP_OWED_COPY, CONTEXT_UNAVAILABLE_COPY } from '@stockpilot/core';

import { heldHandlers, shippedSources } from '@/test/authenticator-read-tree';

/**
 * Every API read, for a member who must set up an authenticator first: the
 * context is withApiContext's (mocked here; the real one is
 * server/lib/api-read-context.set-up-reads.test.ts) labelled as set-up owed,
 * and every held handler answers 403 `forbidden` with core's sentence and
 * `details.reason: 'mfa_required'`, not stored, before any work of its own:
 * no table, no service client, no rate-limit slot. The handlers are every GET
 * and every read by POST under /api/v1, read from the source tree by the
 * guard's own reading.
 *
 * When the organization's policy could not be read (the context carries the
 * mark withApiContext gives it), the same handlers answer the retryable 503
 * `check_failed` instead, with nothing read either.
 *
 * The writes in the same files (a POST, PATCH or DELETE beside the GET) and
 * the returns writes are not held by this answer: they reach their own
 * handling as before. The sign-in email status (account/email) is not held
 * either: a member reads their own email before setting up an authenticator.
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
import { markMfaPolicyUnread } from '@/lib/auth/mfa-policy';

const ID = '5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c';
const PARAMS = {
  id: ID,
  slug: 'a-release',
  groupId: ID,
  key: 'k-0123456789abcdef',
  itemId: ID,
  sessionId: ID,
};

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

/**
 * Every handler the read rule holds, as `<route folder under app/api> <METHOD>`,
 * read from the source tree by the guard's own reading
 * (test/authenticator-read-tree.ts heldHandlers): every GET and HEAD under
 * /api/v1 whose first step is a read gate, and every handler by another method
 * that hands a read gate 'read'. A handler the guard counts as held is called
 * here, so the two cannot drift apart.
 */
const HELD = heldHandlers(shippedSources()).map((entry) => {
  const [route, method] = entry.split(' ') as [string, string];
  return { route, method };
});

/** Writes in files that also export a GET, and two returns writes through the shared gates. */
const WRITES: Array<[string, string]> = [
  ['v1/cycle-counts', 'POST'],
  ['v1/maintenance-requests', 'POST'],
  ['v1/maintenance-requests/[id]', 'PATCH'],
  ['v1/maintenance-requests/[id]/notes', 'POST'],
  ['v1/me/announcements', 'POST'],
  ['v1/orders/[id]/return-request', 'POST'],
  ['v1/orders/catalog-visibility', 'POST'],
  ['v1/product-groups/linking', 'POST'],
  ['v1/product-groups/linking', 'DELETE'],
  ['v1/returns/[id]/cancel', 'POST'],
  ['v1/size-counts/training', 'POST'],
];

type Handler = (req: NextRequest, ctx: { params: Promise<typeof PARAMS> }) => Promise<Response>;

async function call(route: string, method: string): Promise<Response> {
  const mod = (await import(`../${route}/route`)) as Record<string, Handler>;
  const handler = mod[method === 'HEAD' ? 'GET' : method];
  expect(handler, `${route} exports ${method}`).toBeTypeOf('function');
  const url = `https://app.test/api/${route.replace(/\[[a-zA-Z]+\]/g, ID)}?q=ab`;
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

describe('a read by a member who must set up an authenticator first', () => {
  it('reads the held handlers from the tree', () => {
    // 56 on 2026-11-16: 54 GETs and 2 POSTs.
    expect(HELD.length).toBeGreaterThan(50);
    expect(HELD).toContainEqual({ route: 'v1/mobile/snapshot', method: 'GET' });
    expect(HELD).toContainEqual({ route: 'v1/orders/[id]/return-request/options', method: 'POST' });
    expect(HELD).toContainEqual({ route: 'v1/orders/signature-lookup', method: 'POST' });
  });

  it.each(HELD)(
    '$route $method: 403, core sentence, mfa_required, not stored, nothing read',
    async ({ route, method }) => {
      await expectHeld(await call(route, method));
    },
  );

  it('a HEAD is held the same way', async () => {
    expect((await call('v1/mobile/snapshot', 'HEAD')).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('a null context stays each route its own 401 (snapshot, returns, a member return)', async () => {
    h.ctx = null;
    for (const route of ['v1/mobile/snapshot', 'v1/returns', 'v1/orders/[id]/return-request']) {
      expect((await call(route, 'GET')).status, route).toBe(401);
    }
  });

  it('the sign-in email status is not held: the member reads their own email', async () => {
    const res = await call('v1/account/email', 'GET');
    expect(res.status).not.toBe(403);
    expect(h.calls).toContain('service client');
  });
});

describe('a read when the organization policy could not be read', () => {
  it.each(HELD)(
    '$route $method: the retryable 503 check_failed, never the set-up sentence, nothing read',
    async ({ route, method }) => {
      h.ctx = markMfaPolicyUnread(owedCtx());
      const res = await call(route, method);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = await res.json();
      expect(body).toEqual({
        error: 'check_failed',
        message: CONTEXT_UNAVAILABLE_COPY,
        details: { reason: 'context_unavailable', retryable: true },
      });
      expect(JSON.stringify(body)).not.toContain(AUTHENTICATOR_SET_UP_OWED_COPY);
      expect(h.calls).toEqual([]);
    },
  );
});

describe('a write in the same files is not held by the read answer', () => {
  it.each(WRITES)('%s %s answers as it does without the read rule', async (route, method) => {
    const res = await call(route, method);
    const text = await res.text();
    expect(text).not.toContain(AUTHENTICATOR_SET_UP_OWED_COPY);
  });
});
