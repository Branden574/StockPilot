// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody, isRefusedBeforeAnyWrite, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * THE WRITES THE PHONE SENDS FROM ITS OUTBOX, through the API context gate.
 *
 * The phone's drain (apps/mobile/src/lib/sync.ts sendOne, cycle-count-sync.ts)
 * sends a queued purchase order line receipt, bundle hand-out, size count
 * batch, count line clear and count line record to these routes, and sends a
 * row again after a 5xx (drain-failure.ts). Each route calls the gate as its
 * first statement, and the count line record as its second, after one read of
 * the clock it places the capture against, so:
 *   - a context that could not be built because the caller's access could
 *     not be checked, and a write by a member whose organization's
 *     authenticator policy could not be read and who has no verified
 *     authenticator, get the gate's 503 `check_failed` (retryable, nothing
 *     written), before the rate limit, the body or any query;
 *   - a member whose policy was read and who must set up an authenticator
 *     first gets the service gate's 403 `mfa_required`, and nothing is
 *     written;
 *   - a member who owes nothing, and a verified authenticator at aal2 in
 *     every state, reach the route's own work;
 *   - no context is the route's own 401.
 *
 * The context is withApiContext's (mocked); the gate, the routes and the
 * services' own permission checks are real. The rows that reach the route's
 * work replace only the service method that writes.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

import { withApiContext } from '@/lib/auth/api-context';
import { MembershipUnavailableError } from '@/lib/auth/membership-unavailable';
import { markMfaPolicyUnread } from '@/lib/auth/mfa-policy';
import { checkRateLimit } from '@/lib/rate-limit';
import { BundlesService } from '@/server/services/bundles';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ReceivingService } from '@/server/services/receiving';
import { SizeCountsService } from '@/server/services/size-counts';

import { POST as distribute } from './bundles/[id]/distribute/route';
import { POST as clearLine } from './cycle-counts/[id]/lines/[lineId]/clear/route';
import { POST as recordLine } from './cycle-counts/[id]/lines/[lineId]/record/route';
import { POST as receiveLine } from './po/[id]/receive-line/route';
import { POST as sizeCountEvents } from './size-counts/[id]/events/route';

const PO = '1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e';
const ITEM = '2b2b2b2b-3c3c-4d4d-8e5e-6f6f6f6f6f6f';
const WH = '3c3c3c3c-4d4d-4e5e-8f6f-7a7a7a7a7a7a';
const KEY = '4d4d4d4d-5e5e-4f6f-8a7a-8b8b8b8b8b8b';
const KEY_2 = '5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c';
const LINE = '6f6f6f6f-7a7a-4b8b-8c9c-adadadadadad';
const BUNDLE = '7a7a7a7a-8b8b-4c9c-8dad-bebebebebebe';
const SESSION = '8b8b8b8b-9c9c-4dad-8ebe-cfcfcfcfcfcf';
const COUNT = '9c9c9c9c-adad-4ebe-8fcf-d0d0d0d0d0d0';

/** The stub's answers for the reads receive-line makes before the service. */
const RECEIVE_READS = {
  'purchase_orders.select': {
    data: { id: PO, status: 'ordered', destination_location_id: null, supplier_id: null },
    error: null,
  },
  'purchase_order_items.select': {
    data: [{ id: LINE, item_id: ITEM, quantity_ordered: 5, quantity_received: 0, unit_cost: 2 }],
    error: null,
  },
};

interface Route {
  name: string;
  /** The service and the method that does the route's write. */
  service: { prototype: object };
  method: string;
  /** What that method answers when it succeeds. */
  succeeds: unknown;
  /** The reads the route makes before the service, for a stub. */
  reads?: Parameters<typeof makeSupabaseStub>[0];
  send: () => Promise<Response>;
}

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`https://app.test${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ROUTES: Route[] = [
  {
    name: 'a purchase order line received (receive-line)',
    service: ReceivingService,
    method: 'postReceipt',
    succeeds: { id: KEY_2, receipt_number: 'RCV-0001' },
    reads: RECEIVE_READS,
    send: () =>
      receiveLine(
        post(`/api/v1/po/${PO}/receive-line`, {
          itemId: ITEM,
          qty: 1,
          warehouseId: WH,
          idempotencyKey: KEY,
        }),
        { params: Promise.resolve({ id: PO }) },
      ),
  },
  {
    name: 'a bundle handed out (distribute)',
    service: BundlesService,
    method: 'distribute',
    succeeds: { distributionId: KEY_2 },
    send: () =>
      distribute(
        post(`/api/v1/bundles/${BUNDLE}/distribute`, {
          quantity: 1,
          warehouseId: WH,
          idempotencyKey: KEY,
        }),
        { params: Promise.resolve({ id: BUNDLE }) },
      ),
  },
  {
    name: 'a size count batch (events)',
    service: SizeCountsService,
    method: 'appendEvents',
    succeeds: { inserted: 1 },
    send: () =>
      sizeCountEvents(
        post(`/api/v1/size-counts/${SESSION}/events`, {
          events: [{ idempotencyKey: KEY, size: 'M', quantityDelta: 1 }],
        }),
        { params: Promise.resolve({ id: SESSION }) },
      ),
  },
  {
    name: 'a count line cleared (clear)',
    service: CycleCountsService,
    method: 'clearCount',
    succeeds: undefined,
    send: () =>
      clearLine(post(`/api/v1/cycle-counts/${COUNT}/lines/${LINE}/clear`), {
        params: Promise.resolve({ id: COUNT, lineId: LINE }),
      }),
  },
  {
    name: 'a count recorded (record)',
    service: CycleCountsService,
    method: 'recordCount',
    succeeds: undefined,
    send: () => sendCount(),
  },
];

/** The phone's queued count: taken offline at 14:20, sent at 15:00 by the device's clock. */
function sendCount() {
  return recordLine(
    post(`/api/v1/cycle-counts/${COUNT}/lines/${LINE}/record`, {
      countedQuantity: 3,
      capturedAt: '2026-10-24T14:20:00.000Z',
      clientSentAt: '2026-10-24T15:00:00.000Z',
    }),
    { params: Promise.resolve({ id: COUNT, lineId: LINE }) },
  );
}

type Mfa = { mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled: boolean };
const OWES_SET_UP: Mfa = { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
const OWES_NOTHING: Mfa = { mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false };
const AAL2: Mfa = { mfaRequired: true, mfaSatisfied: true, mfaEnrolled: true };

/** Every module on, so only the authenticator check can refuse. */
const MODULES_ON = new Set<ModuleId>([
  'receiving',
  'bundles',
  'instant_size_count',
  'cycle_counts',
] as ModuleId[]);

/** A staff member's context on a stub client, marked when `unread`. */
function arrange(route: Route, mfa: Mfa, unread: boolean) {
  const stub = makeSupabaseStub(route.reads ?? {});
  const ctx = {
    ...makeServiceContext(stub.client, {
      role: 'staff',
      mfaRequired: mfa.mfaRequired,
      mfaSatisfied: mfa.mfaSatisfied,
      enabledModules: MODULES_ON,
    }),
    mfaEnrolled: mfa.mfaEnrolled,
  };
  vi.mocked(withApiContext).mockResolvedValue((unread ? markMfaPolicyUnread(ctx) : ctx) as never);
  return stub;
}

/** The service method that does the route's write, watched (and called through unless replaced). */
function spyOnWrite(route: Route) {
  return vi.spyOn(
    route.service.prototype as Record<string, (...args: unknown[]) => Promise<unknown>>,
    route.method,
  );
}

/** Nothing written: no RPC, and no table write. */
function expectNothingWritten(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.rpcCalls).toEqual([]);
  const writes = [...stub.chains.keys()].filter((k) => !k.endsWith('.select'));
  expect(writes).toEqual([]);
}

async function expectMarker(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('5');
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as { error: string; details: unknown };
  expect(body).toEqual(contextUnavailableBody());
  // What the phone reads it through: nothing was written, send it again.
  expect(isRefusedBeforeAnyWrite({ status: 503, code: body.error, details: body.details })).toBe(
    true,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(ROUTES)('$name', (route) => {
  it('the policy could not be read, no authenticator: the gate marker, before the limit, the body or any query', async () => {
    const write = spyOnWrite(route);
    const stub = arrange(route, OWES_SET_UP, true);

    await expectMarker(await route.send());

    expect(stub.fromCalls).toEqual([]);
    expectNothingWritten(stub);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('access that could not be checked: the gate marker, before anything', async () => {
    const write = spyOnWrite(route);
    vi.mocked(withApiContext).mockRejectedValue(new MembershipUnavailableError());

    await expectMarker(await route.send());

    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("the policy was read and set-up is owed: the service gate's 403 mfa_required, nothing written", async () => {
    const stub = arrange(route, OWES_SET_UP, false);

    const res = await route.send();

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; details?: { reason?: string } };
    expect(body.error).toBe('forbidden');
    expect(body.details?.reason).toBe('mfa_required');
    expectNothingWritten(stub);
  });

  it('a member who owes nothing reaches the write', async () => {
    const write = spyOnWrite(route).mockResolvedValue(route.succeeds);
    arrange(route, OWES_NOTHING, false);

    const res = await route.send();

    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the policy was read', false],
    ['the policy could not be read', true],
  ])('a verified authenticator at aal2 reaches the write when %s', async (_label, unread) => {
    const write = spyOnWrite(route).mockResolvedValue(route.succeeds);
    arrange(route, AAL2, unread);

    const res = await route.send();

    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("no context: the route's own 401, and nothing is spent", async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);

    const res = await route.send();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('a count recorded (record): the capture time', () => {
  // The server's clock when the count arrives.
  const ARRIVAL = Date.parse('2026-10-24T18:00:00.000Z');

  it('is measured against the clock read before the gate, so a slow context step does not move it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(ARRIVAL);
      const write = spyOnWrite(ROUTES.find((r) => r.method === 'recordCount')!).mockResolvedValue(
        undefined,
      );
      const stub = makeSupabaseStub();
      const ctx = {
        ...makeServiceContext(stub.client, { role: 'staff', enabledModules: MODULES_ON }),
        mfaEnrolled: false,
      };
      // Building the context takes five seconds.
      vi.mocked(withApiContext).mockImplementation(async () => {
        vi.setSystemTime(ARRIVAL + 5_000);
        return ctx as never;
      });

      const res = await sendCount();

      expect(res.status).toBe(200);
      // Sent 40 minutes after it was taken, so it was taken 40 minutes before it arrived.
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({ countedQuantity: 3, capturedAt: '2026-10-24T17:20:00.000Z' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
