import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Permission } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ReceivingService } from '@/server/services/receiving';
import { SizeCountsService } from '@/server/services/size-counts';

import { POST as distributePOST } from './bundles/[id]/distribute/route';
import { POST as clearPOST } from './cycle-counts/[id]/lines/[lineId]/clear/route';
import { POST as recordPOST } from './cycle-counts/[id]/lines/[lineId]/record/route';
import { POST as receiveLinePOST } from './po/[id]/receive-line/route';
import { POST as eventsPOST } from './size-counts/[id]/events/route';

/**
 * Security invariant: the routes the phone's outbox sends queued changes to,
 * when the service refuses: a count, a cleared count, a receipt line, a kit
 * distribution and a size-count batch (the adjust route has its own tests).
 * Each answer carries the refusal's `details` as the adjust route's does, so
 * the phone can tell the authenticator answers ('mfa_required': set one up;
 * 'aal2_required': enter its code) apart from a missing permission, which is
 * a 403 'forbidden' too. An internal error keeps its fixed sentence and
 * carries no details.
 *
 * The real routes and the real services: the authenticator and permission
 * refusals come from the services' own gate (assertPermission), which runs
 * before any read. The context, the rate limit, the reporter and the cache
 * invalidation are stubbed; the receipt route's two reads are a small double.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

const COUNT = '11111111-0000-4000-8000-000000000001';
const LINE = '11111111-0000-4000-8000-000000000002';
const PO = '11111111-0000-4000-8000-000000000003';
const ITEM = '11111111-0000-4000-8000-000000000004';
const WAREHOUSE = '11111111-0000-4000-8000-000000000005';
const BUNDLE = '11111111-0000-4000-8000-000000000006';
const SESSION = '11111111-0000-4000-8000-000000000007';
const KEY = '11111111-0000-4000-8000-000000000008';

const INTERNAL_SENTENCE = 'An internal error occurred. Please try again.';
const RAW_DB_TEXT = 'new row for relation "example_table" violates row-level security policy';

/** The receipt route's own reads, before the service: an open PO with one line. */
function receiptReadsClient() {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    purchase_orders: [
      { id: PO, status: 'ordered', destination_location_id: null, supplier_id: null },
    ],
    purchase_order_items: [
      { id: LINE, item_id: ITEM, quantity_ordered: 5, quantity_received: 0, unit_cost: 2 },
    ],
  };
  return {
    from: (table: string) => {
      const data = rows[table] ?? [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data, error: null }).then(ok, bad),
      };
      return builder;
    },
  };
}

interface Caller {
  mfaRequired: boolean;
  mfaSatisfied: boolean;
  mfaEnrolled: boolean;
  permissions?: ReadonlySet<Permission>;
}

/** An admin with every module these routes need. */
function context(caller: Caller) {
  return {
    organizationId: 'org-example',
    userId: 'user-example',
    role: 'admin' as const,
    enabledModules: new Set<ModuleId>([
      'cycle_counts',
      'receiving',
      'bundles',
      'instant_size_count',
    ]),
    supabase: receiptReadsClient() as never,
    ...caller,
  };
}

/** No authenticator, under a policy that requires one. */
const SET_UP_OWED: Caller = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
/** An authenticator whose code this session has not entered. */
const CODE_OWED: Caller = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true };
/** The authenticator rule met, and no permission at all. */
const NO_PERMISSION: Caller = {
  mfaRequired: false,
  mfaSatisfied: true,
  mfaEnrolled: false,
  permissions: new Set<Permission>(),
};

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer example-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface RouteCase {
  name: string;
  permission: Permission;
  send: () => Promise<Response>;
  /** Makes the service method this route calls throw `e`. */
  failWith: (e: unknown) => void;
}

const ROUTES: RouteCase[] = [
  {
    name: 'record a count',
    permission: 'stock:adjust',
    send: () =>
      recordPOST(
        post(`/api/v1/cycle-counts/${COUNT}/lines/${LINE}/record`, { countedQuantity: 3 }),
        {
          params: Promise.resolve({ id: COUNT, lineId: LINE }),
        },
      ),
    failWith: (e) => {
      vi.spyOn(CycleCountsService.prototype, 'recordCount').mockRejectedValueOnce(e);
    },
  },
  {
    name: 'clear a count',
    permission: 'stock:adjust',
    send: () =>
      clearPOST(post(`/api/v1/cycle-counts/${COUNT}/lines/${LINE}/clear`), {
        params: Promise.resolve({ id: COUNT, lineId: LINE }),
      }),
    failWith: (e) => {
      vi.spyOn(CycleCountsService.prototype, 'clearCount').mockRejectedValueOnce(e);
    },
  },
  {
    name: 'receive a PO line',
    permission: 'stock:adjust',
    send: () =>
      receiveLinePOST(
        post(`/api/v1/po/${PO}/receive-line`, {
          itemId: ITEM,
          qty: 1,
          warehouseId: WAREHOUSE,
          idempotencyKey: KEY,
        }),
        { params: Promise.resolve({ id: PO }) },
      ),
    failWith: (e) => {
      vi.spyOn(ReceivingService.prototype, 'postReceipt').mockRejectedValueOnce(e);
    },
  },
  {
    name: 'distribute a kit',
    permission: 'bundles:distribute',
    send: () =>
      distributePOST(
        post(`/api/v1/bundles/${BUNDLE}/distribute`, {
          quantity: 1,
          warehouseId: WAREHOUSE,
          idempotencyKey: KEY,
        }),
        { params: Promise.resolve({ id: BUNDLE }) },
      ),
    failWith: (e) => {
      vi.spyOn(BundlesService.prototype, 'distribute').mockRejectedValueOnce(e);
    },
  },
  {
    name: 'append size-count events',
    permission: 'stock:adjust',
    send: () =>
      eventsPOST(
        post(`/api/v1/size-counts/${SESSION}/events`, {
          events: [{ idempotencyKey: KEY, size: 'M' }],
        }),
        { params: Promise.resolve({ id: SESSION }) },
      ),
    failWith: (e) => {
      vi.spyOn(SizeCountsService.prototype, 'appendEvents').mockRejectedValueOnce(e);
    },
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe.each(ROUTES)('the outbox route: $name', (route) => {
  async function answer(caller: Caller) {
    vi.mocked(withApiContext).mockResolvedValueOnce(context(caller) as never);
    const res = await route.send();
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("an account with no authenticator under a requiring policy: 403 forbidden with details.reason 'mfa_required'", async () => {
    const { status, body } = await answer(SET_UP_OWED);
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'forbidden',
      message: 'Multi-factor authentication required. Enroll in MFA before performing this action.',
      details: { reason: 'mfa_required' },
    });
  });

  it("a session that owes its authenticator code: 403 forbidden with details.reason 'aal2_required'", async () => {
    const { status, body } = await answer(CODE_OWED);
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      details: { reason: 'aal2_required' },
    });
  });

  it('a missing permission: 403 forbidden with its sentence and no details', async () => {
    const { status, body } = await answer(NO_PERMISSION);
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'forbidden',
      message: `Missing permission: ${route.permission}`,
    });
  });

  it('an internal error: 500 with the fixed sentence, no details and none of the raw text', async () => {
    route.failWith(new ServiceError('internal_error', RAW_DB_TEXT, { table: 'example_table' }));
    const { status, body } = await answer({
      mfaRequired: false,
      mfaSatisfied: true,
      mfaEnrolled: false,
    });
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'internal_error', message: INTERNAL_SENTENCE });
    expect(JSON.stringify(body)).not.toContain('example_table');
  });

  it("another refusal's own reason is carried the same way, with its status and sentence", async () => {
    route.failWith(
      new ServiceError('forbidden', 'Example refusal sentence.', { reason: 'example_reason' }),
    );
    const { status, body } = await answer({
      mfaRequired: false,
      mfaSatisfied: true,
      mfaEnrolled: false,
    });
    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'forbidden',
      message: 'Example refusal sentence.',
      details: { reason: 'example_reason' },
    });
  });
});

describe('the count route: a count that waited on a busy line', () => {
  it('keeps its 503 try-again answer with no details', async () => {
    vi.spyOn(CycleCountsService.prototype, 'recordCount').mockRejectedValueOnce(
      new ServiceError('internal_error', `cycle_count_record_busy (55P03): ${RAW_DB_TEXT}`, {
        retryable: true,
      }),
    );
    vi.mocked(withApiContext).mockResolvedValueOnce(
      context({ mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false }) as never,
    );
    const res = await ROUTES[0]!.send();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual({ error: 'internal_error', message: INTERNAL_SENTENCE });
  });
});
