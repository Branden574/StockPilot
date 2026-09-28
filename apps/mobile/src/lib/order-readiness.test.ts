/**
 * The phone's one caller of order_readiness_facts (0377), and the decisions
 * the order screen makes from its answer. What must hold, each pinned below:
 *   • the RPC gets the order id and nothing else (never an org);
 *   • any failure (an error, a rejection, an answer the parser refuses, an
 *     answer about another order) is `failed`: "Couldn't check readiness",
 *     Approve partial and Resume disabled, never green, empty or zeros;
 *   • a success is core's own assessment of the same facts (the web server
 *     runs the same functions);
 *   • who reads and who sees follow core readinessAudience, plus a manager's
 *     gates;
 *   • the facts and the order on screen describe the same order, or the
 *     answer is `failed`;
 *   • the gates the phone used to compute itself (lib/order-stock-check.ts,
 *     deleted) now come from core, and keep every old expectation;
 *   • offline, the last view is remembered in memory for the session only.
 */
import {
  approveShortNotice,
  describeReadinessRollup,
  orderStockGates,
  READINESS_READ_FAILED_COPY,
  readinessStockFlags,
  readinessSummaryForRequester,
  REQUESTER_CHECK_FAILED_COPY,
  type OrderReadinessResult,
  type Permission,
} from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
import {
  forgetRememberedOrderViews,
  orderReadinessAudience,
  orderStockCheckFor,
  orderViewAsOf,
  READINESS_FORBIDDEN_COPY,
  READINESS_MODULE_OFF_COPY,
  READINESS_NOT_CHECKED_COPY,
  READINESS_ORDER_CHANGED_COPY,
  READINESS_ORDER_NOT_FOUND_COPY,
  READINESS_UNREADABLE_COPY,
  readOrderReadiness,
  readOrgTimeZone,
  readinessPermissionsFor,
  recalledOrderView,
  reconcileReadiness,
  REMEMBERED_ORDER_VIEWS_MAX,
  rememberOrderView,
  shouldReadReadiness,
  type OrgZoneClient,
  type ReadinessRpcClient,
} from './order-readiness';

const ORDER = '0a000000-0000-0000-0000-00000000f201';
const OTHER_ORDER = '0a000000-0000-0000-0000-00000000f202';
const WH = '0a000000-0000-0000-0000-0000000000a1';
const ITEM_A = '0a000000-0000-0000-0000-0000000000e1';
const ITEM_B = '0a000000-0000-0000-0000-0000000000e2';
const NOW = new Date('2026-09-28T18:00:00Z');

/** One visible item, as the function answers it (JSON numbers). */
function visibleItem(itemId: string, over: Record<string, unknown> = {}) {
  return {
    itemId,
    visible: true,
    name: itemId === ITEM_A ? 'Pens' : 'Notebooks',
    sku: itemId === ITEM_A ? 'PEN-1' : 'NB-1',
    supplierId: null,
    itemWarehouseId: WH,
    deleted: false,
    archived: false,
    isBundle: false,
    onHand: 10,
    heldOwn: 0,
    heldOtherOrders: 0,
    heldRentals: 0,
    here: { rack: 10, site: 0, unplaced: 0, staging: 0 },
    elsewhere: { pickable: 0, staging: 0 },
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: null,
    committedOtherShortfall: 0,
    inbound: null,
    drafts: null,
    ...over,
  };
}

/** The function's answer for a pending order with two lines. */
function factsFor(
  over: {
    status?: string;
    phase?: string;
    orderId?: string;
    items?: unknown[];
    lines?: unknown[];
    linesCapped?: boolean;
    v?: number;
  } = {},
) {
  return {
    v: over.v ?? 1,
    observedAt: '2026-09-28T17:59:58.123456+00:00',
    phase: over.phase ?? 'to_pick',
    linesCapped: over.linesCapped ?? false,
    order: {
      id: over.orderId ?? ORDER,
      orderNumber: 17,
      status: over.status ?? 'pending_approval',
      warehouseId: WH,
      neededBy: null,
      fulfillmentType: 'pickup',
    },
    lines: over.lines ?? [
      {
        lineId: 'line-1',
        itemId: ITEM_A,
        requested: 4,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-27T10:00:00Z',
      },
      {
        lineId: 'line-2',
        itemId: ITEM_B,
        requested: 12,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-27T10:00:01Z',
      },
    ],
    items: over.items ?? [visibleItem(ITEM_A), visibleItem(ITEM_B)],
  };
}

type Answer = {
  data: unknown;
  error: { message?: string; code?: string; hint?: string } | null;
  status?: number;
};

/** A fake RPC client: records each call, answers through `handler`. */
function fakeRpc(handler: () => Answer | Promise<Answer>) {
  const calls: { fn: string; args: Record<string, unknown> | undefined }[] = [];
  const client: ReadinessRpcClient & { calls: typeof calls } = {
    calls,
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve().then(handler);
    },
  };
  return client;
}

const ok = (data: unknown): Answer => ({ data, error: null, status: 200 });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  forgetRememberedOrderViews();
});

describe('readOrderReadiness', () => {
  it('calls order_readiness_facts with the order id only, and assesses the answer in core', async () => {
    const client = fakeRpc(() => ok(factsFor()));
    const r = await readOrderReadiness(client, ORDER, () => NOW);
    expect(client.calls).toEqual([{ fn: 'order_readiness_facts', args: { p_order_id: ORDER } }]);
    expect(r.state).toBe('ok');
    if (r.state !== 'ok' || r.assessment.phase !== 'to_pick') throw new Error('expected to_pick');
    expect(r.assessment.order.id).toBe(ORDER);
    expect(r.assessment.lines.map((l) => [l.lineId, l.state])).toEqual([
      ['line-1', 'ready'],
      ['line-2', 'short'],
    ]);
    // Core's own words for the same facts.
    expect(describeReadinessRollup(r)?.headline).toBe('1 line short');
  });

  it('never asks for something that is not an order id', async () => {
    const client = fakeRpc(() => ok(factsFor()));
    expect(await readOrderReadiness(client, 'not-a-uuid')).toEqual({
      state: 'failed',
      message: READINESS_ORDER_NOT_FOUND_COPY,
    });
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    [
      'P0002 (missing, or another organization)',
      { code: 'P0002', message: 'order_request_not_found' },
      404,
      READINESS_ORDER_NOT_FOUND_COPY,
    ],
    [
      '42501 (signed out)',
      { code: '42501', message: 'unauthenticated' },
      403,
      READINESS_FORBIDDEN_COPY,
    ],
    [
      'module_disabled',
      { code: 'P0001', message: 'module_disabled', hint: 'module_disabled' },
      400,
      READINESS_MODULE_OFF_COPY,
    ],
    [
      'no answer at all (offline: no code, status 0)',
      { code: '', message: 'TypeError: Network request failed' },
      0,
      CONNECTION_FAILURE_COPY,
    ],
    ['a server error', { code: 'XX000', message: 'boom' }, 500, "Couldn't check readiness."],
  ])('%s is failed, with its sentence', async (_name, error, status, message) => {
    const client = fakeRpc(() => ({ data: null, error, status }));
    expect(await readOrderReadiness(client, ORDER)).toEqual({ state: 'failed', message });
  });

  it('a rejected request is failed with the connection sentence, never the network text', async () => {
    const client: ReadinessRpcClient = {
      rpc: () =>
        Promise.reject(
          new Error('fetch failed: UnexpectedException: Could not connect to the server.'),
        ),
    };
    expect(await readOrderReadiness(client, ORDER)).toEqual({
      state: 'failed',
      message: CONNECTION_FAILURE_COPY,
    });
  });

  it('no response at all is failed', async () => {
    const client: ReadinessRpcClient = { rpc: () => Promise.resolve(null) };
    expect((await readOrderReadiness(client, ORDER)).state).toBe('failed');
  });

  it.each([
    ['another version', factsFor({ v: 2 })],
    ['a missing field', { ...factsFor(), order: undefined }],
    [
      'a string number',
      factsFor({ items: [visibleItem(ITEM_A, { onHand: '10' }), visibleItem(ITEM_B)] }),
    ],
    ['a line whose item has no facts', factsFor({ items: [visibleItem(ITEM_A)] })],
    ['a phase that disagrees with the status', factsFor({ status: 'approved', phase: 'picked' })],
    ['nothing', null],
  ])(
    'an answer the parser refuses (%s) is failed, never an empty or green panel',
    async (_n, data) => {
      const r = await readOrderReadiness(
        fakeRpc(() => ok(data)),
        ORDER,
      );
      expect(r).toEqual({ state: 'failed', message: READINESS_UNREADABLE_COPY });
    },
  );

  it('an order id in upper case is the same order: asked in lower case, the answer accepted', async () => {
    // ORDER is lower case hex; the database answers in lower case.
    const client = fakeRpc(() => ok(factsFor()));
    const r = await readOrderReadiness(client, ORDER.toUpperCase(), () => NOW);
    expect(ORDER.toUpperCase()).not.toBe(ORDER);
    expect(r.state).toBe('ok');
    expect(client.calls).toEqual([{ fn: 'order_readiness_facts', args: { p_order_id: ORDER } }]);
  });

  it('a missing EXECUTE grant (42501 "permission denied") is a failure, never "not allowed"', async () => {
    const client = fakeRpc(() => ({
      data: null,
      error: { code: '42501', message: 'permission denied for function order_readiness_facts' },
      status: 403,
    }));
    const r = await readOrderReadiness(client, ORDER);
    expect(r).toEqual({ state: 'failed', message: "Couldn't check readiness." });
    expect(r.state === 'failed' && r.message).not.toBe(READINESS_FORBIDDEN_COPY);
    // Shown as the headline alone (no "not allowed" under it).
    expect(describeReadinessRollup(r)).toMatchObject({ headline: READINESS_READ_FAILED_COPY, detail: null });
  });

  it('shows under the headline only the reasons the web page shows too (core readinessFailureDetail)', async () => {
    const notFound = await readOrderReadiness(
      fakeRpc(() => ({ data: null, error: { code: 'P0002', message: 'order_request_not_found' }, status: 404 })),
      ORDER,
    );
    expect(describeReadinessRollup(notFound)?.detail).toBe('Order not found.');
    // No answer at all: the headline alone on both platforms.
    const offline = await readOrderReadiness(
      fakeRpc(() => ({ data: null, error: { code: '', message: 'TypeError: Network request failed' }, status: 0 })),
      ORDER,
    );
    expect(describeReadinessRollup(offline)?.detail).toBeNull();
    const unreadable = await readOrderReadiness(fakeRpc(() => ok(null)), ORDER);
    expect(describeReadinessRollup(unreadable)?.detail).toBeNull();
  });

  it('an answer about another order is failed', async () => {
    const r = await readOrderReadiness(
      fakeRpc(() => ok(factsFor({ orderId: OTHER_ORDER }))),
      ORDER,
    );
    expect(r).toEqual({ state: 'failed', message: READINESS_UNREADABLE_COPY });
  });

  it('a failure is reported to the device log, not swallowed', async () => {
    await readOrderReadiness(
      fakeRpc(() => ({ data: null, error: { code: 'XX000', message: 'boom' }, status: 500 })),
      ORDER,
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[order-readiness] readiness could not be checked',
      'XX000: boom',
    );
  });

  it('a failed result reads as "Couldn\'t check readiness" and disables the gates (never green, never zeros)', async () => {
    const r = await readOrderReadiness(
      fakeRpc(() => Promise.reject(new Error('offline'))),
      ORDER,
    );
    expect(describeReadinessRollup(r)?.headline).toBe(READINESS_READ_FAILED_COPY);
    // The requester is told it could not be checked, never that it is being checked.
    expect(readinessSummaryForRequester(r)).toBe(REQUESTER_CHECK_FAILED_COPY);
    expect(readinessStockFlags(r)).toMatchObject({ state: 'failed', reason: 'read' });
    expect(
      orderStockGates('pending_approval', orderStockCheckFor('pending_approval', r)),
    ).toMatchObject({
      approvePartial: 'disabled',
      canRetry: true,
    });
    expect(orderStockGates('backordered', orderStockCheckFor('backordered', r))).toMatchObject({
      resume: 'disabled',
      canRetry: true,
    });
  });
});

describe('readOrgTimeZone', () => {
  function zoneClient(answer: () => Promise<{ data: unknown; error: unknown }>) {
    const seen: string[] = [];
    const chain = {
      select(c: string) {
        seen.push(`select:${c}`);
        return chain;
      },
      eq(c: string, v: string) {
        seen.push(`eq:${c}=${v}`);
        return chain;
      },
      maybeSingle: answer,
    };
    const client: OrgZoneClient & { seen: string[] } = {
      seen,
      from(t: string) {
        seen.push(`from:${t}`);
        return chain;
      },
    };
    return client;
  }

  it("reads the organization's zone", async () => {
    const c = zoneClient(async () => ({ data: { timezone: 'America/Chicago' }, error: null }));
    expect(await readOrgTimeZone(c, 'org-1')).toBe('America/Chicago');
    expect(c.seen).toEqual(['from:organizations', 'select:timezone', 'eq:id=org-1']);
  });

  it('is null (core then uses its default zone) when unset, refused or rejected', async () => {
    expect(
      await readOrgTimeZone(
        zoneClient(async () => ({ data: { timezone: null }, error: null })),
        'o',
      ),
    ).toBeNull();
    expect(
      await readOrgTimeZone(
        zoneClient(async () => ({ data: null, error: { message: 'x' } })),
        'o',
      ),
    ).toBeNull();
    expect(
      await readOrgTimeZone(
        zoneClient(() => Promise.reject(new Error('offline'))),
        'o',
      ),
    ).toBeNull();
  });
});

describe('who reads and who sees', () => {
  const perms = (...p: string[]) => new Set(p as Permission[]);

  const audience = (
    role: string | null,
    permissions: Set<Permission> | undefined,
    viewerUserId: string | null,
    requesterUserId: string | null,
  ) =>
    orderReadinessAudience(
      readinessPermissionsFor(role, permissions),
      viewerUserId,
      requesterUserId,
    );

  it('the full panel for approvers, pickers and buyers (static defaults while loading)', () => {
    for (const role of ['owner', 'admin', 'manager', 'staff']) {
      expect(audience(role, undefined, 'u', 'x')).toBe('full');
    }
    expect(readinessPermissionsFor('manager', undefined)).toEqual({
      canApproveOrders: true,
      canUpdateItems: true,
      canManagePurchaseOrders: true,
    });
  });

  it('one sentence for a requester without those permissions; nothing for anyone else', () => {
    expect(audience('viewer', undefined, 'u', 'u')).toBe('requester');
    expect(audience('viewer', undefined, 'u', 'x')).toBe('none');
    // An order placed on someone's behalf has no requester id: nobody is its
    // requester (a null never equals a null).
    expect(audience('viewer', undefined, null, null)).toBe('none');
  });

  it('overrides apply: a viewer granted orders:approve sees the panel; staff with items:update revoked does not', () => {
    expect(audience('viewer', perms('orders:approve'), 'u', 'x')).toBe('full');
    expect(audience('staff', perms('orders:request'), 'u', 'x')).toBe('none');
    expect(audience('viewer', perms('purchase_orders:manage'), 'u', 'x')).toBe('full');
  });

  it('an unknown or missing role holds none of the permissions (still the requester sentence)', () => {
    expect(readinessPermissionsFor(null, undefined)).toEqual({
      canApproveOrders: false,
      canUpdateItems: false,
      canManagePurchaseOrders: false,
    });
    expect(audience(null, undefined, 'u', 'u')).toBe('requester');
    expect(audience('wizard', undefined, 'u', 'x')).toBe('none');
  });

  it('reads only at a to_pick status, and only for someone who sees it or a manager', () => {
    for (const status of [
      'pending_approval',
      'approved',
      'pick_slip_generated',
      'picking_in_progress',
      'backordered',
    ]) {
      expect(shouldReadReadiness({ status, audience: 'full', role: 'staff' })).toBe(true);
      expect(shouldReadReadiness({ status, audience: 'requester', role: 'viewer' })).toBe(true);
      for (const role of ['owner', 'admin', 'manager']) {
        expect(shouldReadReadiness({ status, audience: 'none', role })).toBe(true);
      }
      for (const role of ['staff', 'viewer', null, '', 'wizard']) {
        expect(shouldReadReadiness({ status, audience: 'none', role })).toBe(false);
      }
    }
    for (const status of [
      'picking_complete',
      'in_transit',
      'completed',
      'cancelled',
      'denied',
      null,
      'mystery',
    ]) {
      expect(shouldReadReadiness({ status, audience: 'full', role: 'owner' })).toBe(false);
    }
  });
});

describe('reconcileReadiness: the facts and the screen describe the same order', () => {
  async function okResult(data = factsFor()): Promise<OrderReadinessResult> {
    return readOrderReadiness(
      fakeRpc(() => ok(data)),
      ORDER,
      () => NOW,
    );
  }

  it('the same status and lines: the answer as is', async () => {
    const r = await okResult();
    expect(
      reconcileReadiness(r, { status: 'pending_approval', lineIds: ['line-2', 'line-1'] }),
    ).toBe(r);
  });

  it('another status (approved between the two reads) is failed', async () => {
    const r = await okResult();
    expect(reconcileReadiness(r, { status: 'approved', lineIds: ['line-1', 'line-2'] })).toEqual({
      state: 'failed',
      message: READINESS_ORDER_CHANGED_COPY,
    });
  });

  it('a line added or removed between the two reads is failed', async () => {
    const r = await okResult();
    for (const lineIds of [['line-1'], ['line-1', 'line-2', 'line-3'], ['line-1', 'line-9']]) {
      expect(reconcileReadiness(r, { status: 'pending_approval', lineIds })).toEqual({
        state: 'failed',
        message: READINESS_ORDER_CHANGED_COPY,
      });
    }
  });

  it('a capped order has no lines to compare; a failed answer passes through', async () => {
    const capped = await okResult(factsFor({ linesCapped: true, lines: [], items: [] }));
    expect(reconcileReadiness(capped, { status: 'pending_approval', lineIds: ['x'] })).toBe(capped);
    const failed: OrderReadinessResult = { state: 'failed', message: 'x' };
    expect(reconcileReadiness(failed, { status: 'approved', lineIds: [] })).toBe(failed);
  });
});

// ── The gates, fed by readiness (ported from lib/order-stock-check.test.ts) ──
// The phone's old loader read on hand and reservations itself. Its fetch
// rules are gone with it; its DECISIONS are kept here against the new source,
// and core order-stock-gates.test.ts holds the gates' own table.
describe('orderStockCheckFor + core orderStockGates', () => {
  async function check(status: string, data: unknown) {
    const r = await readOrderReadiness(
      fakeRpc(() => ok(data)),
      ORDER,
      () => NOW,
    );
    return orderStockCheckFor(status, r);
  }

  it('is not needed outside pending_approval and backordered', () => {
    for (const status of ['approved', 'picking_in_progress', 'completed', null, undefined]) {
      expect(orderStockCheckFor(status, null)).toEqual({ state: 'not_needed' });
    }
  });

  it('a manager whose check was not read gets a failed check, never "not needed" or zeros', () => {
    expect(orderStockCheckFor('pending_approval', null)).toEqual({
      state: 'failed',
      reason: 'read',
      message: READINESS_NOT_CHECKED_COPY,
    });
    expect(
      orderStockGates('pending_approval', orderStockCheckFor('pending_approval', null)),
    ).toMatchObject({
      approvePartial: 'disabled',
    });
  });

  it('sums duplicate-item lines before judging a pending order short (3 + 3 against 5)', async () => {
    const lines = [
      {
        lineId: 'line-1',
        itemId: ITEM_A,
        requested: 3,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-27T10:00:00Z',
      },
      {
        lineId: 'line-2',
        itemId: ITEM_A,
        requested: 3,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-27T10:00:01Z',
      },
    ];
    const items = [
      visibleItem(ITEM_A, { onHand: 5, here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
    ];
    const c = await check('pending_approval', factsFor({ lines, items }));
    expect(c).toMatchObject({ state: 'ok', isShortStock: true, shortLineCount: 2 });
    expect(orderStockGates('pending_approval', c)).toMatchObject({
      approvePartial: 'enabled',
      notice: null,
    });
    expect(approveShortNotice(c)).toBe(
      '2 lines ask for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
    );
  });

  it('available is on hand minus every hold (4 of 10 with 6 held is fine; 5 is short)', async () => {
    const held = visibleItem(ITEM_A, { heldOtherOrders: 4, heldRentals: 2 });
    const line = (requested: number) => [
      {
        lineId: 'line-1',
        itemId: ITEM_A,
        requested,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-27T10:00:00Z',
      },
    ];
    expect(
      await check('pending_approval', factsFor({ lines: line(4), items: [held] })),
    ).toMatchObject({
      state: 'ok',
      isShortStock: false,
    });
    expect(
      await check('pending_approval', factsFor({ lines: line(5), items: [held] })),
    ).toMatchObject({
      state: 'ok',
      isShortStock: true,
    });
  });

  it('a backorder is fulfillable only when an item still owed has stock', async () => {
    const lines = [
      {
        lineId: 'line-1',
        itemId: ITEM_A,
        requested: 5,
        fulfilled: 5,
        picked: null,
        createdAt: '2026-09-27T10:00:00Z',
      },
      {
        lineId: 'line-2',
        itemId: ITEM_B,
        requested: 4,
        fulfilled: 1,
        picked: null,
        createdAt: '2026-09-27T10:00:01Z',
      },
    ];
    const empty = { onHand: 0, here: { rack: 0, site: 0, unplaced: 0, staging: 0 } };
    const one = { onHand: 1, here: { rack: 1, site: 0, unplaced: 0, staging: 0 } };
    const waiting = await check(
      'backordered',
      factsFor({
        status: 'backordered',
        lines,
        items: [visibleItem(ITEM_A), visibleItem(ITEM_B, empty)],
      }),
    );
    expect(orderStockGates('backordered', waiting)).toMatchObject({
      resume: 'waiting',
      notice: null,
    });
    const fulfillable = await check(
      'backordered',
      factsFor({
        status: 'backordered',
        lines,
        items: [visibleItem(ITEM_A, empty), visibleItem(ITEM_B, one)],
      }),
    );
    expect(orderStockGates('backordered', fulfillable)).toMatchObject({
      resume: 'enabled',
      notice: null,
    });
  });

  it('an item the viewer cannot read fails the check without a retry that cannot help (it is not 0 on hand)', async () => {
    const c = await check(
      'pending_approval',
      factsFor({ items: [visibleItem(ITEM_A), { itemId: ITEM_B, visible: false }] }),
    );
    expect(c).toEqual({
      state: 'failed',
      reason: 'hidden_items',
      message: '1 item on this order did not load.',
    });
    expect(orderStockGates('pending_approval', c)).toEqual({
      approvePartial: 'disabled',
      resume: 'waiting',
      notice:
        'Some items on this order are not visible to you, so stock could not be checked. Approve partial is unavailable.',
      canRetry: false,
    });
  });

  it('a moved item disables Approve partial and Resume (both RPCs refuse it)', async () => {
    const moved = visibleItem(ITEM_B, { itemWarehouseId: '0a000000-0000-0000-0000-0000000000a2' });
    const c = await check('pending_approval', factsFor({ items: [visibleItem(ITEM_A), moved] }));
    expect(orderStockGates('pending_approval', c)).toMatchObject({
      approvePartial: 'disabled',
      canRetry: false,
    });
  });
});

describe('offline: the last view, in memory for this session', () => {
  it('is kept per account, workspace and order', () => {
    rememberOrderView('u1', 'org-1', ORDER, { n: 1 }, new Date('2026-09-28T17:00:00Z'));
    expect(recalledOrderView('u1', 'org-1', ORDER)).toEqual({
      view: { n: 1 },
      receivedAt: '2026-09-28T17:00:00.000Z',
    });
    expect(recalledOrderView('u2', 'org-1', ORDER)).toBeNull();
    expect(recalledOrderView('u1', 'org-2', ORDER)).toBeNull();
    expect(recalledOrderView('u1', 'org-1', OTHER_ORDER)).toBeNull();
    expect(recalledOrderView(null, 'org-1', ORDER)).toBeNull();
  });

  it('a newer load replaces the older one', () => {
    rememberOrderView('u1', 'org-1', ORDER, { n: 1 });
    rememberOrderView('u1', 'org-1', ORDER, { n: 2 });
    expect(recalledOrderView<{ n: number }>('u1', 'org-1', ORDER)?.view.n).toBe(2);
  });

  it('nothing is kept without an account, a workspace or an order', () => {
    rememberOrderView(null, 'org-1', ORDER, { n: 1 });
    rememberOrderView('u1', null, ORDER, { n: 1 });
    rememberOrderView('u1', 'org-1', null, { n: 1 });
    expect(recalledOrderView('u1', 'org-1', ORDER)).toBeNull();
  });

  it(`keeps the newest ${REMEMBERED_ORDER_VIEWS_MAX} orders`, () => {
    const id = (i: number) => `order-${i}`;
    for (let i = 0; i < REMEMBERED_ORDER_VIEWS_MAX + 5; i += 1)
      rememberOrderView('u1', 'o', id(i), i);
    expect(recalledOrderView('u1', 'o', id(0))).toBeNull();
    expect(recalledOrderView('u1', 'o', id(4))).toBeNull();
    expect(recalledOrderView('u1', 'o', id(5))?.view).toBe(5);
    // Loading an old one again makes it the newest.
    rememberOrderView('u1', 'o', id(5), 'again');
    rememberOrderView('u1', 'o', 'order-new', 'new');
    expect(recalledOrderView('u1', 'o', id(5))?.view).toBe('again');
    expect(recalledOrderView('u1', 'o', id(6))).toBeNull();
  });

  it('the banner names when readiness was checked, else when the order was received', async () => {
    const r = await readOrderReadiness(
      fakeRpc(() => ok(factsFor())),
      ORDER,
      () => NOW,
    );
    expect(orderViewAsOf(r, '2026-09-28T18:00:05Z')).toBe('2026-09-28T17:59:58.123456+00:00');
    expect(orderViewAsOf(null, '2026-09-28T18:00:05Z')).toBe('2026-09-28T18:00:05Z');
    expect(orderViewAsOf({ state: 'failed', message: 'x' }, '2026-09-28T18:00:05Z')).toBe(
      '2026-09-28T18:00:05Z',
    );
  });
});
