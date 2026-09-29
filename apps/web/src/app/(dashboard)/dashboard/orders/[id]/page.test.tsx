import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SHORT_LINE_FINAL_NOTE, type OrderReadinessResult } from '@stockpilot/core';

import {
  hiddenItemFacts,
  orderReadinessFacts,
  READINESS_FAILED,
  readinessOk,
  visibleItemFacts,
} from '@/test/order-readiness-facts';

/**
 * I1 (fix wave 2, security review sibling of C1's cross-org attach fix):
 * this HOST computes `maintenanceGate` from `can(ctx, 'maintenance_requests
 * :submit')` (page.tsx:221) and `maintenanceModuleEnabled` from a
 * Tier-2-batched `checkModuleAccess('maintenance_requests')` call
 * (page.tsx:427,449), then wires them into `ReportProblemButton`'s
 * `canSubmit` / `moduleEnabled` props (page.tsx:593-597).
 * `ReportProblemButton`'s OWN unit tests only prove the component obeys
 * whatever two booleans it is handed — nothing proves this HOST derives or
 * wires them correctly. A prop SWAP (`moduleEnabled={maintenanceGate}
 * canSubmit={maintenanceModuleEnabled}`) would pass every existing test in
 * this codebase.
 *
 * These tests drive the real page through all four (module x permission)
 * combinations and assert the EXACT two booleans `ReportProblemButton`
 * received — a swap fails because module-enabled and permission-granted are
 * independently toggled, never in lockstep. The fixture's order status
 * ('approved', pickup fulfillment) deliberately keeps every OTHER Tier-2
 * gate (picking, stock-check, live-tracking, drivers, shipping, returns)
 * false, so `checkModuleAccess` is called for exactly one module in the
 * default scenario — this file cares about maintenance_requests only, every
 * other surface on this huge page is out of scope.
 */

const orderGet = vi.fn();
const attachmentsList = vi.fn(async () => []);
const returnableLinesForOrder = vi.fn(async () => []);
const checkModuleAccessMock = vi.fn();
const getWarehouseAccessMock = vi.fn(async (_ctx?: unknown) => ({ hasAllAccess: true, writableIds: [] as string[] }));
const reportProblemButtonProps = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  // The readiness strip's "Check again" (a client component, rendered for real).
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

// Every OTHER child component on this page — stubbed to null. This file
// only cares about ReportProblemButton's props; what the rest of the page
// renders is covered elsewhere (or not this task's concern).
vi.mock('@/components/orders/add-items-dialog', () => ({ AddItemsDialog: () => null }));
vi.mock('@/components/orders/cancel-order-button', () => ({ CancelOrderButton: () => null }));
vi.mock('@/components/orders/manager-actions-panel', () => ({
  ManagerActionsPanel: (props: Record<string, unknown>) => {
    managerActionsProps(props);
    return null;
  },
}));
// A recording spy: the row's edit / remove controls name the line's item.
const orderLineActionsProps = vi.fn();
// F2-2: the one-tap fixes on a short line, recorded the same way.
const shortLineFixesProps = vi.fn();
vi.mock('@/components/orders/order-line-actions', () => ({
  OrderLineActions: (props: Record<string, unknown>) => {
    orderLineActionsProps(props);
    return null;
  },
  ShortLineFixes: (props: Record<string, unknown>) => {
    shortLineFixesProps(props);
    return null;
  },
}));
// The readiness strip (rendered for real) offers "Hold available stock"
// through this server action (F2-2).
vi.mock('@/server/actions/order-requests', () => ({ holdOrderStockAction: vi.fn() }));
vi.mock('@/components/orders/delivery-location-share', () => ({ DeliveryLocationShare: () => null }));
vi.mock('@/components/returns/create-return-dialog', () => ({ CreateReturnDialog: () => null }));
vi.mock('@/components/orders/order-attachments-panel', () => ({ OrderAttachmentsPanel: () => null }));
vi.mock('@/components/orders/order-realtime-refresh', () => ({ OrderRealtimeRefresh: () => null }));
vi.mock('@/components/orders/order-timeline', () => ({ OrderTimeline: () => null }));
vi.mock('@/components/orders/shipping-panel', () => ({ ShippingPanel: () => null }));
vi.mock('@/components/orders/status-badge', () => ({ OrderStatusBadge: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/onboarding/help-tip', () => ({ HelpTip: () => null }));

// The ONE component under test in this file — a recording spy, never the
// real implementation (that component's own render/visibility logic is
// covered by report-problem-button.test.tsx).
vi.mock('@/components/maintenance/report-problem-button', () => ({
  ReportProblemButton: (props: Record<string, unknown>) => {
    reportProblemButtonProps(props);
    return null;
  },
}));

// Delivery-request re-entry — a recording spy like ReportProblemButton
// above: the wrapper's own dialog/assistant wiring is covered by
// send-delivery-request-button.test.tsx; THIS file pins the host's gating
// (requester-only, delivery-only, non-terminal status) and the exact props
// it derives from the order detail.
const sendDeliveryRequestProps = vi.fn();
vi.mock('@/components/orders/send-delivery-request-button', () => ({
  SendDeliveryRequestButton: (props: Record<string, unknown>) => {
    sendDeliveryRequestProps(props);
    return null;
  },
}));

const getCachedOrgTimezoneMock = vi.fn(async (_orgId: string) => 'America/Chicago');
// Per-org email routing (migration 0337): resolves 'valid' with the compiled
// pair by default (the L4L seed's state); individual tests override to pin
// the hidden states.
const getOrgEmailRoutingMock = vi.fn(async (_orgId: string, _feature: string) => ({
  state: 'valid' as const,
  recipients: {
    to: 'dc4@learn4life.org',
    cc: 'arosas@cvwest.org',
    toName: 'Fresno Warehouse DC4',
    ccName: 'Andrew Rosas',
  },
}));
vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: (orgId: string) => getCachedOrgTimezoneMock(orgId),
  getOrgEmailRouting: (orgId: string, feature: string) => getOrgEmailRoutingMock(orgId, feature),
}));

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: new Set<string>(['orders:read']),
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
  })),
}));

// The page starts the service context itself (beside the request context);
// the real ServiceError is kept so the page's not-found test is the real one.
const withContextMock = vi.hoisted(() => vi.fn(async () => ({ organizationId: 'org-1' })));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: (ctx: unknown) => getWarehouseAccessMock(ctx),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: (...args: unknown[]) => checkModuleAccessMock(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
        }
        return () => self;
      },
    });
    return { from: () => self };
  }),
}));

vi.mock('@/server/services/order-attachments', () => ({
  ATTACHABLE_ORDER_STATUSES: [
    'staged_for_pickup',
    'staged_for_delivery',
    'in_transit',
    'signature_requested',
    'completed',
  ],
  OrderAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: attachmentsList })) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ get: orderGet })) },
}));
// Order readiness (F2-1): the service's settled result. The default is a
// failed read, so a test that does not care about readiness never sees a
// green answer by accident.
const readinessResult = vi.fn(async (_orderId: string): Promise<OrderReadinessResult> => READINESS_FAILED);
const readinessForCurrentUser = vi.fn(async () => ({ result: readinessResult }));
vi.mock('@/server/services/order-readiness', () => ({
  OrderReadinessService: { forCurrentUser: () => readinessForCurrentUser() },
}));
// "Count this item" on a line whose records disagree: the item page's rule
// (canStartCount) and its button, both recorded here.
const canStartCountMock = vi.fn((_ctx: unknown) => false);
vi.mock('@/server/services/lib/count-start-preflight', () => ({
  canStartCount: (ctx: unknown) => canStartCountMock(ctx),
}));
const countThisItemProps = vi.fn();
vi.mock('@/components/exceptions/count-this-item-button', async () => {
  const React = await import('react');
  return {
    CountThisItemButton: (props: Record<string, unknown>) => {
      countThisItemProps(props);
      return React.createElement('button', { type: 'button' }, 'Count this item');
    },
  };
});
const managerActionsProps = vi.fn();

vi.mock('@/server/services/returns', () => ({
  RMAService: { forCurrentUser: vi.fn(async () => ({ returnableLinesForOrder })) },
  // The order page's returns read (fired only on completed / legacy delivered
  // orders). Out of scope here — resolves to "no returns"; page.returns.test.tsx
  // drives it.
  loadOrderReturns: vi.fn(async () => []),
}));

import OrderDetailPage from './page';

const ORDER_ID = '11111111-1111-1111-1111-111111111111';

/** A full OrderRequestRow — every field the page reads directly off
 *  `request` (TIMELINE_FIELDS iterates 10 of these by key, plus several
 *  more read individually), status/fulfillment chosen so every Tier-2 gate
 *  OTHER than maintenance stays false (see file doc comment). */
function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    order_number: 42,
    needed_by: null,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'approved',
    requester_user_id: 'other-user',
    requester_email: null,
    requester_name: 'Jane Smith',
    requester_org_label: null,
    approved_by: null,
    approved_at: '2026-08-01T12:00:00Z',
    denied_reason: null,
    packaging_at: null,
    ready_at: null,
    delivered_at: null,
    cancelled_at: null,
    cancelled_by: null,
    notes: null,
    internal_notes: null,
    source: 'internal',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T12:00:00Z',
    fulfillment_type: 'pickup',
    delivery_charter_id: null,
    pickup_location_notes: null,
    requester_phone: null,
    assigned_picker_id: null,
    pick_slip_generated_at: null,
    pick_slip_generated_by: null,
    picking_completed_at: null,
    picking_completed_by: null,
    packing_slip_generated_at: null,
    packing_slip_generated_by: null,
    staged_at: null,
    staged_by: null,
    assigned_delivery_user_id: null,
    assigned_delivery_by: null,
    assigned_delivery_at: null,
    in_transit_at: null,
    in_transit_by: null,
    signature_token: null,
    signature_token_expires_at: null,
    signed_by_name: null,
    signed_by_email: null,
    signature_data_url: null,
    signed_at: null,
    completed_at: null,
    completed_by: null,
    return_token: null,
    return_prompt_sent_at: null,
    ...overrides,
  };
}

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    request: requestFixture(overrides.request as Record<string, unknown>),
    lines: [],
    reservations: [],
    warehouseName: 'Main DC',
    requesterDisplay: 'Jane Smith',
    requesterName: 'Jane Smith',
    requesterEmail: null,
    assignedPickerName: null,
    ...overrides,
  };
}

function setPermissions(hasSubmit: boolean) {
  const perms = new Set<string>(['orders:read']);
  if (hasSubmit) perms.add('maintenance_requests:submit');
  ctxHolder.current = { role: 'staff', permissions: perms };
}

async function renderPage() {
  return render(await OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  orderGet.mockResolvedValue(detailFixture());
  attachmentsList.mockResolvedValue([]);
  returnableLinesForOrder.mockResolvedValue([]);
  getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: true, writableIds: [] });
  setPermissions(true);
  checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
  readinessResult.mockImplementation(async () => READINESS_FAILED);
  canStartCountMock.mockReturnValue(false);
});

describe('orders/[id]: the order read', () => {
  it('starts the service context (its GoTrue factors read) with the request context', async () => {
    await renderPage();
    expect(withContextMock).toHaveBeenCalled();
  });

  it('a missing order is the not-found page', async () => {
    const { ServiceError } = await import('@/server/services/context');
    orderGet.mockRejectedValue(new ServiceError('not_found', 'Order request not found'));
    await expect(renderPage()).rejects.toThrow('notFound');
  });

  it('a FAILED order read is not a 404: it reaches the error boundary as itself', async () => {
    const { ServiceError } = await import('@/server/services/context');
    const failure = new ServiceError('internal_error', 'gateway timeout');
    orderGet.mockRejectedValue(failure);
    await expect(renderPage()).rejects.toBe(failure);
  });
});

describe('orders/[id] host — ReportProblemButton gating (I1, fix wave 2)', () => {
  it('permission GRANTED + module ENABLED -> canSubmit=true, moduleEnabled=true, prefill.orderRequestId=this order', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockImplementation(async (moduleId: string) =>
      moduleId === 'maintenance_requests' ? { enabled: true, canManage: false } : { enabled: false, canManage: false },
    );
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: true, prefill: { orderRequestId: ORDER_ID } }),
    );
  });

  it('permission GRANTED + module DISABLED -> canSubmit=true, moduleEnabled=false (SWAP GUARD: a props swap here would report canSubmit=false, moduleEnabled=true)', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockImplementation(async () => ({ enabled: false, canManage: false }));
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: false }),
    );
  });

  it('permission DENIED + module ENABLED -> canSubmit=false, moduleEnabled=false — the sync-gate-first short circuit never calls checkModuleAccess for maintenance_requests (SWAP GUARD: a swap would report canSubmit=false, moduleEnabled=true here)', async () => {
    setPermissions(false);
    checkModuleAccessMock.mockImplementation(async () => ({ enabled: true, canManage: false }));
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
    expect(checkModuleAccessMock).not.toHaveBeenCalledWith('maintenance_requests');
  });

  it('permission DENIED + module DISABLED -> canSubmit=false, moduleEnabled=false', async () => {
    setPermissions(false);
    checkModuleAccessMock.mockImplementation(async () => ({ enabled: false, canManage: false }));
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
  });

  it('queries checkModuleAccess with the maintenance_requests module id — proves moduleEnabled is sourced from the MODULE check, not reused from the permission check', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockImplementation(async () => ({ enabled: true, canManage: false }));
    await renderPage();
    expect(checkModuleAccessMock).toHaveBeenCalledWith('maintenance_requests');
  });
});

/** A line with an item row, as OrderRequestsService.get returns them —
 *  exactly the fields the page reads plus what the delivery-request
 *  re-entry flattens (item id/name/sku + quantity_requested). */
const DELIVERY_LINE = {
  id: 'L1',
  order_request_id: ORDER_ID,
  item_id: 'i1',
  quantity_requested: 3,
  quantity_fulfilled: 0,
  quantity_picked: 0,
  unit_cost_at_request: 0,
  notes: null,
  item: {
    id: 'i1',
    name: 'Google Chrome Book',
    sku: 'SP-BVK31-LH9',
    quantity_on_hand: 50,
    charter_name: null,
    charter_code: null,
  },
};

/** An eligible delivery order owned by the VIEWER (requester_user_id 'u1'
 *  matches the mocked session's userId) — the exact principal the
 *  post-placement success dialog rendered the assistant for. */
function ownDeliveryDetail(requestOverrides: Record<string, unknown> = {}) {
  return detailFixture({
    request: requestFixture({
      fulfillment_type: 'delivery',
      requester_user_id: 'u1',
      notes: 'Front office, ask for Jane',
      needed_by: '2026-08-20T17:00:00Z',
      ...requestOverrides,
    }),
    lines: [DELIVERY_LINE],
    requesterEmail: 'jane@example.org',
  });
}

describe('orders/[id] host — delivery-request assistant re-entry gating + props', () => {
  it('own delivery order in an active state -> renders the action with the exact props the dialog path passes (timezone from getCachedOrgTimezone, lines flattened from the detail)', async () => {
    orderGet.mockResolvedValue(ownDeliveryDetail());
    await renderPage();
    expect(sendDeliveryRequestProps).toHaveBeenCalledTimes(1);
    expect(sendDeliveryRequestProps).toHaveBeenCalledWith({
      // The org's resolved routing (per-org email routing, migration 0337),
      // flattened to plain strings for the RSC boundary.
      recipients: {
        to: 'dc4@learn4life.org',
        cc: 'arosas@cvwest.org',
        toName: 'Fresno Warehouse DC4',
        ccName: 'Andrew Rosas',
      },
      orderId: ORDER_ID,
      orderNumber: 42,
      warehouseName: 'Main DC',
      destination: null,
      requestedFor: 'Jane Smith',
      requesterEmail: 'jane@example.org',
      neededBy: '2026-08-20T17:00:00Z',
      orgTimezone: 'America/Chicago',
      notes: 'Front office, ask for Jane',
      lines: [
        { itemId: 'i1', quantity: 3, name: 'Google Chrome Book', sku: 'SP-BVK31-LH9' },
      ],
    });
    expect(getCachedOrgTimezoneMock).toHaveBeenCalledWith('org-1');
    expect(getOrgEmailRoutingMock).toHaveBeenCalledWith('org-1', 'delivery_request');
  });

  it("UNSET routing hides the button even on the requester's own active delivery order (fallback matrix state B)", async () => {
    orderGet.mockResolvedValue(ownDeliveryDetail());
    getOrgEmailRoutingMock.mockResolvedValueOnce({ state: 'unset' } as never);
    await renderPage();
    expect(sendDeliveryRequestProps).not.toHaveBeenCalled();
  });

  it('INVALID routing fails CLOSED — button hidden, never the compiled constants (state D)', async () => {
    orderGet.mockResolvedValue(ownDeliveryDetail());
    getOrgEmailRoutingMock.mockResolvedValueOnce({
      state: 'invalid',
      reason: 'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.',
    } as never);
    await renderPage();
    expect(sendDeliveryRequestProps).not.toHaveBeenCalled();
  });

  it("FALLBACK (pre-migration deploy window) keeps today's behavior — the compiled pair reaches the button", async () => {
    orderGet.mockResolvedValue(ownDeliveryDetail());
    getOrgEmailRoutingMock.mockResolvedValueOnce({ state: 'fallback' } as never);
    await renderPage();
    expect(sendDeliveryRequestProps).toHaveBeenCalledTimes(1);
    expect(sendDeliveryRequestProps.mock.calls[0]![0]).toMatchObject({
      recipients: { to: 'dc4@learn4life.org', cc: 'arosas@cvwest.org' },
    });
  });

  it('a PICKUP order never shows the action, even for its own requester in an active state', async () => {
    orderGet.mockResolvedValue(ownDeliveryDetail({ fulfillment_type: 'pickup' }));
    await renderPage();
    expect(sendDeliveryRequestProps).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'denied', 'completed'] as const)(
    'a %s delivery order never shows the action — nothing left to deliver',
    async (status) => {
      orderGet.mockResolvedValue(ownDeliveryDetail({ status }));
      await renderPage();
      expect(sendDeliveryRequestProps).not.toHaveBeenCalled();
    },
  );

  it("someone ELSE's delivery order never shows the action — the re-entry belongs to the order placer, same principal the success dialog rendered for", async () => {
    orderGet.mockResolvedValue(ownDeliveryDetail({ requester_user_id: 'other-user' }));
    await renderPage();
    expect(sendDeliveryRequestProps).not.toHaveBeenCalled();
    // And the gated timezone read is not paid for a viewer who gets no button.
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
  });
});


/**
 * ORDER READINESS (F2-1). The page's own stock check (on hand minus a
 * reservations read, which threw into the error boundary when the read
 * failed) is gone: readiness is one read in the Tier-2 batch, for the
 * audience core names, and the same result feeds the strip, the Readiness
 * column and the Approve partial / Resume gates. A failed read is rendered as
 * "Couldn't check readiness" and disables the actions with the reason; the
 * page never throws for it.
 */
describe('orders/[id]: order readiness (F2-1)', () => {
  function orderLine(id: string, itemId: string, requested: number, over: Record<string, unknown> = {}) {
    return {
      id,
      order_request_id: ORDER_ID,
      item_id: itemId,
      quantity_requested: requested,
      quantity_fulfilled: 0,
      quantity_picked: null,
      returned_quantity: 0,
      unit_cost_at_request: 0,
      notes: null,
      item: {
        id: itemId,
        name: `Item ${itemId}`,
        sku: `SKU-${itemId}`,
        quantity_on_hand: 40,
        charter_name: null,
        charter_code: null,
      },
      ...over,
    };
  }
  const LINE_A = orderLine('LA', 'iA', 20);
  const LINE_B = orderLine('LB', 'iB', 25);

  function orderAt(status: string, lines: unknown[], request: Record<string, unknown> = {}) {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status, ...request }), lines }));
  }
  function as(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer', perms: string[]) {
    ctxHolder.current = { role, permissions: new Set(['orders:read', ...perms]) };
  }
  const asManager = () => as('manager', ['orders:approve']);

  /** A ready (40 on a rack) and B needs put-away (10 rack + 30 Staging, 25 asked). */
  const mixedFacts = (status: string) =>
    orderReadinessFacts(
      ORDER_ID,
      status,
      [
        { lineId: 'LA', itemId: 'iA', requested: 20 },
        { lineId: 'LB', itemId: 'iB', requested: 25 },
      ],
      [visibleItemFacts('iA', { here: { rack: 40 } }), visibleItemFacts('iB', { here: { rack: 10, staging: 30 } })],
    );

  const lastPanelProps = () => managerActionsProps.mock.calls.at(-1)![0] as Record<string, unknown>;

  it('a manager on a pending order: one read of THIS order, the strip, each line under its item, and gates from the same result', async () => {
    asManager();
    orderAt('pending_approval', [LINE_A, LINE_B]);
    readinessResult.mockResolvedValue(readinessOk(mixedFacts('pending_approval')));

    await renderPage();

    expect(readinessForCurrentUser).toHaveBeenCalledTimes(1);
    expect(readinessResult).toHaveBeenCalledWith(ORDER_ID);
    const strip = screen.getByTestId('readiness-strip');
    expect(strip).toHaveAttribute('data-mode', 'full');
    expect(within(strip).getByTestId('readiness-headline')).toHaveTextContent('1 line needs put-away');
    expect(within(strip).getByTestId('readiness-details')).toHaveTextContent('1 of 2 lines ready to pick');
    // The org's zone as the facts carry it (America/Los_Angeles here): 17:42Z
    // is 10:42 AM.
    expect(within(strip).getByTestId('readiness-checked-at')).toHaveTextContent(
      'Checked at 10:42 AM. Stock can change after this.',
    );
    expect(within(strip).getByTestId('readiness-recheck')).toHaveTextContent('Check again');
    // Each line's readiness is in its Item cell, not a column of its own.
    expect(screen.queryByRole('columnheader', { name: 'Readiness' })).toBeNull();
    const cells = screen.getAllByTestId('readiness-line');
    expect(cells.map((c) => c.closest('td')!.cellIndex)).toEqual([0, 0]);
    expect(cells.map((c) => c.getAttribute('data-state'))).toEqual(['ready', 'needs_put_away']);
    expect(within(cells[0]!).getByTestId('readiness-sentence')).toHaveTextContent('20 on the shelf for this order.');
    expect(within(cells[1]!).getByTestId('readiness-sentence')).toHaveTextContent(
      '10 on the shelf. 15 more are in Staging and must be put away before picking can take them.',
    );
    // Nothing is short, so Approve partial stays hidden and nothing is noted.
    expect(lastPanelProps()).toMatchObject({
      stockGates: { approvePartial: 'hidden', resume: 'waiting', notice: null, canRetry: false },
      approveNotice: null,
    });
  });

  it('a short pending order offers Approve partial and the note under Approve', async () => {
    asManager();
    orderAt('pending_approval', [LINE_A]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(ORDER_ID, 'pending_approval', [{ lineId: 'LA', itemId: 'iA', requested: 20 }], [
          visibleItemFacts('iA', { here: { rack: 5 } }),
        ]),
      ),
    );

    await renderPage();

    expect(screen.getByTestId('readiness-headline')).toHaveTextContent('1 line short');
    expect(screen.getByTestId('readiness-line')).toHaveAttribute('data-state', 'short');
    expect(lastPanelProps()).toMatchObject({
      stockGates: { approvePartial: 'enabled', notice: null },
      approveNotice: '1 line asks for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
    });
  });

  it("a FAILED read says \"Couldn't check readiness\" with Try again, disables Approve partial with the reason, and never throws", async () => {
    asManager();
    orderAt('pending_approval', [LINE_A, LINE_B]);
    readinessResult.mockResolvedValue(READINESS_FAILED);

    await renderPage();

    const strip = screen.getByTestId('readiness-strip');
    expect(strip).toHaveAttribute('data-failed', 'true');
    expect(within(strip).getByTestId('readiness-headline')).toHaveTextContent("Couldn't check readiness. Try again.");
    expect(within(strip).getByTestId('readiness-recheck')).toHaveTextContent('Try again');
    expect(within(strip).queryByTestId('readiness-checked-at')).toBeNull();
    expect(strip.textContent).not.toMatch(/Ready|in stock/);
    // No per-line claims from a read that failed.
    expect(screen.queryAllByTestId('readiness-line')).toEqual([]);
    expect(screen.queryByRole('columnheader', { name: 'Readiness' })).toBeNull();
    // DISABLED with the reason, never flags defaulted to false (hidden).
    expect(lastPanelProps()).toMatchObject({
      stockGates: {
        approvePartial: 'disabled',
        notice: 'Could not check stock for this order. Approve partial is unavailable until it loads.',
        canRetry: true,
      },
      approveNotice: null,
    });
  });

  it('a failed read on a backordered order disables Resume with the reason', async () => {
    asManager();
    orderAt('backordered', [orderLine('LA', 'iA', 20, { quantity_fulfilled: 5 })]);
    readinessResult.mockResolvedValue(READINESS_FAILED);

    await renderPage();

    expect(lastPanelProps()).toMatchObject({
      stockGates: {
        approvePartial: 'hidden',
        resume: 'disabled',
        notice: 'Could not check stock for this order. Resume fulfillment is unavailable until it loads.',
        canRetry: true,
      },
    });
  });

  it('a backordered order with stock free again offers Resume', async () => {
    asManager();
    orderAt('backordered', [orderLine('LA', 'iA', 20, { quantity_fulfilled: 5 })]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(ORDER_ID, 'backordered', [{ lineId: 'LA', itemId: 'iA', requested: 20, fulfilled: 5 }], [
          visibleItemFacts('iA', { here: { rack: 3 } }),
        ]),
      ),
    );

    await renderPage();

    expect(lastPanelProps()).toMatchObject({ stockGates: { resume: 'enabled', notice: null } });
    expect(screen.getByTestId('readiness-headline')).toHaveTextContent('1 line short');
  });

  it("an item the viewer cannot read is \"Can't confirm\" on its line, and Approve partial is disabled with why", async () => {
    asManager();
    orderAt('pending_approval', [LINE_A, LINE_B]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(
          ORDER_ID,
          'pending_approval',
          [
            { lineId: 'LA', itemId: 'iA', requested: 20 },
            { lineId: 'LB', itemId: 'iB', requested: 25 },
          ],
          [visibleItemFacts('iA', { here: { rack: 40 } }), hiddenItemFacts('iB')],
        ),
      ),
    );

    await renderPage();

    const cells = screen.getAllByTestId('readiness-line');
    expect(cells[1]).toHaveAttribute('data-state', 'unknown');
    expect(within(cells[1]!).getByTestId('readiness-sentence')).toHaveTextContent(
      "This item isn't visible to you, so its stock can't be checked.",
    );
    // No numbers, no Why, no link for an item the viewer cannot read.
    expect(within(cells[1]!).queryByTestId('readiness-why')).toBeNull();
    expect(screen.getByTestId('readiness-headline')).toHaveTextContent("1 line can't be confirmed");
    expect(lastPanelProps()).toMatchObject({
      stockGates: {
        approvePartial: 'disabled',
        notice:
          'Some items on this order are not visible to you, so stock could not be checked. Approve partial is unavailable.',
        canRetry: false,
      },
    });
  });

  it('a staff picker (items:update) sees the full panel on a picking order, with the hold on each line', async () => {
    as('staff', ['items:update']);
    orderAt('picking_in_progress', [LINE_A]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(ORDER_ID, 'picking_in_progress', [{ lineId: 'LA', itemId: 'iA', requested: 20 }], [
          visibleItemFacts('iA', { here: { rack: 40 }, heldOwn: 20 }),
        ]),
      ),
    );

    await renderPage();

    expect(screen.getByTestId('readiness-strip')).toHaveAttribute('data-mode', 'full');
    expect(screen.getByTestId('readiness-headline')).toHaveTextContent('Ready to pick (1 of 1 line)');
    const cell = screen.getByTestId('readiness-line');
    expect(within(cell).getByTestId('readiness-hold')).toHaveTextContent('Held for this order');
    expect(within(cell).getByTestId('readiness-why')).toHaveTextContent('Held for this order 20');
    // next/link is stubbed to a bare anchor here, so the link is found by its words.
    expect(within(cell).getByText('Last physical count').closest('a')).toHaveAttribute(
      'href',
      '/dashboard/inventory/iA#physical-count',
    );
  });

  it('the requester (no approve, pick or buy permission) gets one sentence: no numbers, no column', async () => {
    as('viewer', ['orders:request']);
    orderAt('pending_approval', [LINE_A, LINE_B], { requester_user_id: 'u1' });
    readinessResult.mockResolvedValue(readinessOk(mixedFacts('pending_approval')));

    await renderPage();

    const strip = screen.getByTestId('readiness-strip');
    expect(strip).toHaveAttribute('data-mode', 'requester');
    expect(within(strip).getByTestId('readiness-headline')).toHaveTextContent('All items are in stock.');
    expect(strip.textContent).not.toMatch(/\d+ (on the shelf|lines?)/);
    expect(screen.queryAllByTestId('readiness-line')).toEqual([]);
    expect(screen.queryByRole('columnheader', { name: 'Readiness' })).toBeNull();
  });

  it("the requester's failed read says it could not be checked, never that it is in stock or being checked", async () => {
    as('viewer', ['orders:request']);
    orderAt('approved', [LINE_A], { requester_user_id: 'u1' });
    readinessResult.mockResolvedValue(READINESS_FAILED);

    await renderPage();

    expect(screen.getByTestId('readiness-headline')).toHaveTextContent("Stock couldn't be checked just now.");
    expect(screen.getByTestId('readiness-recheck')).toHaveTextContent('Try again');
    expect(screen.queryByTestId('readiness-checked-at')).toBeNull();
  });

  it('anyone else (not in the audience, not the requester) gets nothing: the read started beside the order read is dropped', async () => {
    as('staff', []);
    orderAt('pending_approval', [LINE_A]);
    readinessResult.mockResolvedValue(readinessOk(mixedFacts('pending_approval')));

    await renderPage();

    // Started before the order said whose it is (it answers any member, who
    // could call it directly), and never shown.
    expect(readinessResult).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('readiness-strip')).toBeNull();
    expect(screen.queryAllByTestId('readiness-line')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/on the shelf|Ready to pick|put-away/);
  });

  it.each(['picking_complete', 'staged_for_pickup', 'in_transit', 'pending_confirmation', 'completed', 'cancelled', 'denied'])(
    'nothing at %s (readiness is for orders still to be picked): the early read is dropped',
    async (status) => {
      asManager();
      orderAt(status, [LINE_A]);
      await renderPage();
      expect(screen.queryByTestId('readiness-strip')).toBeNull();
      expect(screen.queryAllByTestId('readiness-line')).toEqual([]);
      // The dropped answer (the default mock's failed read) disables nothing.
      const panel = managerActionsProps.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
      if (panel) {
        expect(panel).toMatchObject({ stockGates: { approvePartial: 'hidden', notice: null } });
      }
    },
  );

  it('nothing for an order with no lines (the early read is dropped)', async () => {
    asManager();
    orderAt('pending_approval', []);
    await renderPage();
    expect(screen.queryByTestId('readiness-strip')).toBeNull();
    expect(lastPanelProps()).toMatchObject({ stockGates: { approvePartial: 'hidden' }, approveNotice: null });
  });

  it('a service that cannot even start is a failed read in the strip, not a thrown page', async () => {
    asManager();
    orderAt('pending_approval', [LINE_A]);
    readinessForCurrentUser.mockRejectedValueOnce(new Error('context failed'));

    await renderPage();

    expect(screen.getByTestId('readiness-headline')).toHaveTextContent("Couldn't check readiness. Try again.");
    expect(lastPanelProps()).toMatchObject({ stockGates: { approvePartial: 'disabled' } });
  });

  describe('Count this item where on record and the locations disagree', () => {
    const disagreeFacts = () =>
      orderReadinessFacts(ORDER_ID, 'pending_approval', [{ lineId: 'LA', itemId: 'iA', requested: 5 }], [
        visibleItemFacts('iA', { here: { rack: 7 }, onHand: 10 }),
      ]);

    it('a viewer who can start a count gets the button on that line', async () => {
      asManager();
      canStartCountMock.mockReturnValue(true);
      orderAt('pending_approval', [LINE_A]);
      readinessResult.mockResolvedValue(readinessOk(disagreeFacts()));

      await renderPage();

      const cell = screen.getByTestId('readiness-line');
      expect(cell).toHaveAttribute('data-state', 'unknown');
      expect(within(cell).getByTestId('readiness-sentence')).toHaveTextContent(
        'On record: 10, but its locations account for 7. A count will settle it.',
      );
      expect(within(cell).getByRole('button', { name: 'Count this item' })).toBeInTheDocument();
      // The org's zone as the facts carry it.
      expect(countThisItemProps).toHaveBeenCalledWith({ itemId: 'iA', timeZone: 'America/Los_Angeles' });
    });

    it('a viewer who cannot start a count does not', async () => {
      asManager();
      canStartCountMock.mockReturnValue(false);
      orderAt('pending_approval', [LINE_A]);
      readinessResult.mockResolvedValue(readinessOk(disagreeFacts()));

      await renderPage();

      expect(screen.getByTestId('readiness-line')).toHaveAttribute('data-state', 'unknown');
      expect(screen.queryByRole('button', { name: 'Count this item' })).toBeNull();
    });

    it('never on a kit (a count cannot include one)', async () => {
      asManager();
      canStartCountMock.mockReturnValue(true);
      orderAt('pending_approval', [LINE_A]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(ORDER_ID, 'pending_approval', [{ lineId: 'LA', itemId: 'iA', requested: 5 }], [
            visibleItemFacts('iA', { here: { rack: 7 }, onHand: 10, isBundle: true }),
          ]),
        ),
      );

      await renderPage();

      expect(screen.queryByRole('button', { name: 'Count this item' })).toBeNull();
    });
  });

  it('a line added between the order read and the readiness read: "the order changed", never a mix of two orders (as the phone)', async () => {
    asManager();
    orderAt('pending_approval', [LINE_A, LINE_B]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(ORDER_ID, 'pending_approval', [{ lineId: 'LA', itemId: 'iA', requested: 20 }], [
          visibleItemFacts('iA', { here: { rack: 40 } }),
        ]),
      ),
    );

    await renderPage();

    const strip = screen.getByTestId('readiness-strip');
    expect(strip).toHaveAttribute('data-failed', 'true');
    expect(within(strip).getByTestId('readiness-headline')).toHaveTextContent("Couldn't check readiness. Try again.");
    expect(within(strip).getByTestId('readiness-detail')).toHaveTextContent(
      'The order changed while it was being checked. Check again.',
    );
    expect(screen.queryAllByTestId('readiness-line')).toEqual([]);
  });

  it('the order moved on between the two reads (pending on the page, approved in the facts): failed, and Approve partial says why', async () => {
    asManager();
    orderAt('pending_approval', [LINE_A]);
    // The facts say approved and fully picked-ready: shown as-is, the strip
    // would describe an approved order above a header that still says pending.
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(ORDER_ID, 'approved', [{ lineId: 'LA', itemId: 'iA', requested: 20 }], [
          visibleItemFacts('iA', { here: { rack: 5 }, heldOwn: 5 }),
        ]),
      ),
    );

    await renderPage();

    const strip = screen.getByTestId('readiness-strip');
    expect(strip).toHaveAttribute('data-failed', 'true');
    expect(within(strip).getByTestId('readiness-detail')).toHaveTextContent(
      'The order changed while it was being checked. Check again.',
    );
    expect(strip.textContent).not.toMatch(/Held|short|Ready/);
    expect(lastPanelProps()).toMatchObject({
      stockGates: { approvePartial: 'disabled', canRetry: true },
      approveNotice: null,
    });
  });

  it("the screen-reader \"Line N\" is the row's place on the page, whatever order core numbered the lines in", async () => {
    asManager();
    // The page lists LB first; core numbers the lines by (created_at, id), LA first.
    orderAt('pending_approval', [LINE_B, LINE_A]);
    readinessResult.mockResolvedValue(readinessOk(mixedFacts('pending_approval')));

    await renderPage();

    const cells = screen.getAllByTestId('readiness-line');
    expect(cells.map((c) => c.getAttribute('data-state'))).toEqual(['needs_put_away', 'ready']);
    expect(within(cells[0]!).getByTestId('readiness-sr-label')).toHaveTextContent(
      'Line 1, Needs put-away, 15 in Staging.',
    );
    expect(within(cells[1]!).getByTestId('readiness-sr-label')).toHaveTextContent('Line 2, Ready to pick, 20 on the shelf.');
  });

  it('a backordered order: a handed-over line says so and is not counted as ready', async () => {
    asManager();
    orderAt('backordered', [
      orderLine('LA', 'iA', 20, { quantity_fulfilled: 20 }),
      orderLine('LB', 'iB', 25, { quantity_fulfilled: 5 }),
    ]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(
          ORDER_ID,
          'backordered',
          [
            { lineId: 'LA', itemId: 'iA', requested: 20, fulfilled: 20 },
            { lineId: 'LB', itemId: 'iB', requested: 25, fulfilled: 5 },
          ],
          [visibleItemFacts('iA', { here: { rack: 3 } }), visibleItemFacts('iB')],
        ),
      ),
    );

    await renderPage();

    const cells = screen.getAllByTestId('readiness-line');
    expect(cells.map((c) => c.getAttribute('data-state'))).toEqual(['handed_over', 'short']);
    expect(within(cells[0]!).getByTestId('readiness-chip')).toHaveTextContent('Handed over');
    expect(screen.getByTestId('readiness-details')).toHaveTextContent('0 of 1 line ready to pick · 1 line handed over');
  });

  // F2-1 local walk D-1: a Readiness column (13rem floor) made the lines
  // table 705 px inside a 641 px card at every viewport from 1280 to 2560,
  // so a manager had to scroll the table sideways to reach a line's edit and
  // remove buttons. Widths are measured in a real browser
  // (stockpilot-work/f2-1/fix/measure-cols.mjs); this pins the structure the
  // fix rests on: readiness adds no column and no width floor.
  it("readiness adds no column: the table keeps the order's columns, Line actions last, and each line's readiness sits under its item", async () => {
    asManager();
    orderAt('pending_approval', [LINE_A, LINE_B]);
    readinessResult.mockResolvedValue(readinessOk(mixedFacts('pending_approval')));

    await renderPage();

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Item', 'Requested', 'Fulfilled', 'Owed', 'On hand', 'Line actions']);
    const cells = screen.getAllByTestId('readiness-line');
    expect(cells).toHaveLength(2);
    for (const [i, cell] of cells.entries()) {
      const td = cell.closest('td')!;
      // The Item cell of the line's own row.
      expect(td.cellIndex).toBe(0);
      expect(within(td).getByText(`Item ${['iA', 'iB'][i]}`)).toBeInTheDocument();
      expect(td.closest('tr')!.cells).toHaveLength(headers.length);
    }
    // No cell sets a minimum width that could push Line actions off the card.
    expect(document.querySelector('td[class*="min-w-"], th[class*="min-w-"]')).toBeNull();
  });

  // F2-1 local walk, speed: at approved, pick_slip_generated and
  // picking_in_progress the readiness read was a round trip AFTER the order
  // read (production build: +11 ms SO-4, +18 ms SO-3 to the lines table). It
  // needs only the order id, so it starts with the order read.
  it('the readiness read starts with the order read, while the order is still being read', async () => {
    asManager();
    let releaseOrder!: () => void;
    orderGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOrder = () =>
            resolve(detailFixture({ request: requestFixture({ status: 'approved' }), lines: [LINE_A] }));
        }),
    );
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(ORDER_ID, 'approved', [{ lineId: 'LA', itemId: 'iA', requested: 20 }], [
          visibleItemFacts('iA', { here: { rack: 40 }, heldOwn: 20 }),
        ]),
      ),
    );

    const page = OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) });
    await vi.waitFor(() => expect(orderGet).toHaveBeenCalledWith(ORDER_ID));
    // The order read has not answered, and readiness is already asked for.
    await vi.waitFor(() => expect(readinessResult).toHaveBeenCalledWith(ORDER_ID));
    releaseOrder();
    render(await page);

    expect(readinessForCurrentUser).toHaveBeenCalledTimes(1);
    expect(readinessResult).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('readiness-headline')).toHaveTextContent('Ready to pick (1 of 1 line)');
  });

  it("no organizations read for readiness: its times are in the zone the facts carry (0377's order.timeZone)", async () => {
    asManager();
    canStartCountMock.mockReturnValue(true);
    orderAt('pending_approval', [LINE_A]);
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(
          ORDER_ID,
          'pending_approval',
          [{ lineId: 'LA', itemId: 'iA', requested: 5 }],
          [visibleItemFacts('iA', { here: { rack: 7 }, onHand: 10 })],
          { timeZone: 'America/New_York' },
        ),
      ),
    );

    await renderPage();

    // Not the requester's delivery order, so nothing else needs the zone.
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
    // 17:42Z is 1:42 PM in New York (the facts' zone), not 12:42 PM (Chicago,
    // what the organizations read would have said here).
    expect(screen.getByTestId('readiness-checked-at')).toHaveTextContent(
      'Checked at 1:42 PM. Stock can change after this.',
    );
    expect(countThisItemProps).toHaveBeenCalledWith({ itemId: 'iA', timeZone: 'America/New_York' });
  });

  // F2-1 local walk O-5 / phone O4: a line whose item the viewer cannot read
  // said "Deleted item" here and "Unknown item" on the phone. A line's item
  // cannot be deleted (order_request_lines.item_id is ON DELETE RESTRICT), so
  // a missing item is one the viewer's access hides: core's one label says so.
  it("a line whose item the viewer cannot read says \"An item you can't see\", in the row and to its edit controls", async () => {
    as('staff', ['items:update']);
    orderAt('pending_approval', [LINE_A, orderLine('LB', 'iB', 25, { item: null })], { requester_user_id: 'u1' });
    readinessResult.mockResolvedValue(
      readinessOk(
        orderReadinessFacts(
          ORDER_ID,
          'pending_approval',
          [
            { lineId: 'LA', itemId: 'iA', requested: 20 },
            { lineId: 'LB', itemId: 'iB', requested: 25 },
          ],
          [visibleItemFacts('iA', { here: { rack: 40 } }), hiddenItemFacts('iB')],
        ),
      ),
    );

    await renderPage();

    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[1]!).getByText("An item you can't see")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Deleted item|Unknown item/);
    expect(orderLineActionsProps).toHaveBeenCalledWith(
      expect.objectContaining({ lineId: 'LB', itemName: "An item you can't see" }),
    );
    // Its readiness says the same thing in its own words.
    expect(within(rows[1]!).getByTestId('readiness-sentence')).toHaveTextContent(
      "This item isn't visible to you, so its stock can't be checked.",
    );
  });
});

describe('orders/[id]: one stock check, one definition of owed (pattern #26)', () => {
  const src = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');

  it("the page's own stock check is gone: no reservations read, no inline availability sum", () => {
    expect(src).not.toContain('reservedQuantityByItemIds');
    expect(src).not.toContain('needsStockCheck');
    expect(src).not.toContain('InventoryService');
    expect(src).not.toMatch(/d\.requested > available/);
    expect(src).not.toMatch(/d\.owed > 0 && available > 0/);
  });

  it('the readiness read is started once, beside the order read, and awaited in the Tier-2 batch only behind its gate', () => {
    expect(src.match(/OrderReadinessService\.forCurrentUser\(\)/g)).toHaveLength(1);
    const start = src.indexOf(
      'const readinessRead = OrderReadinessService.forCurrentUser().then((svc) => svc.result(id));',
    );
    const orderRead = src.indexOf('OrderRequestsService.forCurrentUser().then((svc) => svc.get(id))');
    expect(start).toBeGreaterThan(0);
    // Started before the order read is awaited (so before its gate is known),
    // and observed at once so a dropped read never rejects unhandled.
    expect(start).toBeLessThan(src.indexOf('await Promise.allSettled([', start));
    expect(src.indexOf('await Promise.allSettled([')).toBeLessThan(orderRead);
    expect(src).toContain('readinessRead.catch(() => {});');
    const batchStart = src.indexOf('] = await Promise.all([', src.indexOf('warehouseAccess,'));
    const batchEnd = src.indexOf('\n  ]);\n', batchStart);
    expect(batchStart).toBeGreaterThan(0);
    const batch = src.slice(batchStart, batchEnd);
    expect(batch).toMatch(/readinessGate\s*\? readinessRead\.catch\(/);
    // Its gate is decided before the batch, from the phase and the audience.
    expect(src.indexOf('const readinessGate')).toBeLessThan(batchStart);
    // The org's zone comes with the facts; the organizations read is the
    // delivery draft's alone.
    expect(batch).toMatch(/showDeliveryRequest\s*\? getCachedOrgTimezone\(ctx\.organizationId\)/);
    expect(batch).not.toMatch(/readinessGate\s*\?\s*getCachedOrgTimezone|\|\| readinessGate/);
  });

  it("a line's Owed cell comes from core lineOwedUnits, not an inline copy", () => {
    expect(src).toContain('lineOwedUnits({');
    expect(src).not.toMatch(
      /Math\.max\(\s*0\s*,\s*\(Number\(l\.quantity_requested\) \|\| 0\) - \(Number\(l\.quantity_fulfilled\) \|\| 0\)/,
    );
  });
});

// ── F2-2: held, and caught before it leaves ─────────────────────────────────
//
// The page's wiring of what it already read (the order, its lines, the
// readiness result) into the hold button, the two confirms and the short-line
// fixes. The components' own behaviour (the confirm opening instead of the
// action, the fixes calling the line edits) is pinned in their own tests.

describe('orders/[id]: held, and caught before it leaves (F2-2)', () => {
  const PENS = 'L4L - Pen Black & Rose Gold';
  function orderLine(id: string, itemId: string, requested: number, over: Record<string, unknown> = {}) {
    return {
      id,
      order_request_id: ORDER_ID,
      item_id: itemId,
      quantity_requested: requested,
      quantity_fulfilled: 0,
      quantity_picked: null,
      returned_quantity: 0,
      unit_cost_at_request: 0,
      notes: null,
      item: {
        id: itemId,
        name: itemId === 'iP' ? PENS : `Item ${itemId}`,
        sku: `SKU-${itemId}`,
        quantity_on_hand: 60,
        charter_name: null,
        charter_code: null,
      },
      ...over,
    };
  }
  function orderAt(status: string, lines: unknown[], request: Record<string, unknown> = {}) {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status, ...request }), lines }));
  }
  function as(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer', perms: string[]) {
    ctxHolder.current = { role, permissions: new Set(['orders:read', ...perms]) };
  }
  const asManager = () => as('manager', ['orders:approve']);
  const lastPanelProps = () => managerActionsProps.mock.calls.at(-1)![0] as Record<string, unknown>;
  const fixesFor = (lineId: string) =>
    shortLineFixesProps.mock.calls.map((c) => c[0] as Record<string, unknown>).find((p) => p.lineId === lineId);

  /** SO-000100 at picking: notebooks held and on the rack, the pens gone. */
  const so100Facts = (status: string) =>
    orderReadinessFacts(
      ORDER_ID,
      status,
      [
        { lineId: 'LN', itemId: 'iN', requested: 60 },
        { lineId: 'LP', itemId: 'iP', requested: 60 },
      ],
      [
        visibleItemFacts('iN', { here: { rack: 60 }, heldOwn: 60 }),
        visibleItemFacts('iP', { name: PENS, here: { rack: 0 } }),
      ],
    );
  const SO100_LINES = [orderLine('LN', 'iN', 60), orderLine('LP', 'iP', 60)];

  describe('Hold available stock', () => {
    it('is offered to an approver on an approved order with a line not held', async () => {
      asManager();
      orderAt('approved', SO100_LINES);
      readinessResult.mockResolvedValue(readinessOk(so100Facts('approved')));

      await renderPage();

      expect(within(screen.getByTestId('readiness-strip')).getByTestId('readiness-hold-stock')).toHaveTextContent(
        'Hold available stock',
      );
    });

    it('never when every line is held, to a picker who may not approve, or on a failed read', async () => {
      asManager();
      orderAt('approved', [orderLine('LN', 'iN', 60)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(ORDER_ID, 'approved', [{ lineId: 'LN', itemId: 'iN', requested: 60 }], [
            visibleItemFacts('iN', { here: { rack: 60 }, heldOwn: 60 }),
          ]),
        ),
      );
      const held = await renderPage();
      expect(screen.queryByTestId('readiness-hold-stock')).toBeNull();
      held.unmount();

      as('staff', ['items:update']);
      orderAt('approved', SO100_LINES);
      readinessResult.mockResolvedValue(readinessOk(so100Facts('approved')));
      const picker = await renderPage();
      expect(screen.getByTestId('readiness-strip')).toBeInTheDocument();
      expect(screen.queryByTestId('readiness-hold-stock')).toBeNull();
      picker.unmount();

      asManager();
      readinessResult.mockResolvedValue(READINESS_FAILED);
      await renderPage();
      expect(screen.getByTestId('readiness-strip')).toHaveAttribute('data-failed', 'true');
      expect(screen.queryByTestId('readiness-hold-stock')).toBeNull();
    });
  });

  describe('the confirm before Mark picking complete (SO-000100)', () => {
    it('names the short line from the projection of complete_picking, and points at it', async () => {
      asManager();
      orderAt('picking_in_progress', SO100_LINES);
      readinessResult.mockResolvedValue(readinessOk(so100Facts('picking_in_progress')));

      await renderPage();

      expect(lastPanelProps().completionConfirm).toEqual({
        title: 'Before you complete picking',
        paragraphs: [
          `Not everything will be picked. ${PENS}: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.`,
        ],
        reviewLabel: 'Review short lines',
        confirmLabel: 'Complete picking',
        focusLineId: 'LP',
      });
    });

    it('is never skipped when readiness failed: the confirm says stock could not be checked', async () => {
      asManager();
      orderAt('picking_in_progress', SO100_LINES);
      readinessResult.mockResolvedValue(READINESS_FAILED);

      await renderPage();

      expect(lastPanelProps().completionConfirm).toMatchObject({
        paragraphs: ["Stock couldn't be checked. Picking may come up short."],
        focusLineId: null,
      });
    });

    it('with everything covered there is nothing to confirm', async () => {
      asManager();
      orderAt('pick_slip_generated', [orderLine('LN', 'iN', 60)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(ORDER_ID, 'pick_slip_generated', [{ lineId: 'LN', itemId: 'iN', requested: 60 }], [
            visibleItemFacts('iN', { here: { rack: 60 }, heldOwn: 60 }),
          ]),
        ),
      );

      await renderPage();

      expect(lastPanelProps().completionConfirm).toBeNull();
    });

    it('carries no stock numbers to a viewer who cannot pick, and none outside picking', async () => {
      as('staff', []);
      orderAt('picking_in_progress', SO100_LINES);
      await renderPage();
      expect(lastPanelProps().completionConfirm).toBeNull();

      asManager();
      orderAt('approved', SO100_LINES);
      readinessResult.mockResolvedValue(readinessOk(so100Facts('approved')));
      await renderPage();
      expect(lastPanelProps().completionConfirm).toBeNull();
    });
  });

  describe('the lines the departure confirm reads', () => {
    it('once picking is settled: each line with its name and its numbers, as the table shows them', async () => {
      asManager();
      orderAt('packing_slip_generated', [
        orderLine('LN', 'iN', 60, { quantity_picked: 60 }),
        orderLine('LP', 'iP', 60, { quantity_picked: 0 }),
      ]);

      await renderPage();

      expect(lastPanelProps().departureLines).toEqual([
        { lineId: 'LN', itemName: 'Item iN', quantityRequested: 60, quantityFulfilled: 0, quantityPicked: 60 },
        { lineId: 'LP', itemName: PENS, quantityRequested: 60, quantityFulfilled: 0, quantityPicked: 0 },
      ]);
    });

    it('none before picking is settled (the confirm cannot speak there)', async () => {
      asManager();
      orderAt('approved', SO100_LINES);
      await renderPage();
      expect(lastPanelProps().departureLines).toEqual([]);
    });
  });

  describe('the one-tap fixes on a short line', () => {
    it('to pick: a Short line offers "Lower to N" (what stock covers) and "Remove line"; a ready line nothing', async () => {
      asManager();
      orderAt('pending_approval', [orderLine('LA', 'iA', 20), orderLine('LB', 'iB', 25)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(
            ORDER_ID,
            'pending_approval',
            [
              { lineId: 'LA', itemId: 'iA', requested: 20 },
              { lineId: 'LB', itemId: 'iB', requested: 25 },
            ],
            [visibleItemFacts('iA', { here: { rack: 40 } }), visibleItemFacts('iB', { here: { rack: 10 } })],
          ),
        ),
      );

      await renderPage();

      expect(fixesFor('LA')).toBeUndefined();
      expect(fixesFor('LB')).toMatchObject({
        orderId: ORDER_ID,
        lineId: 'LB',
        itemName: 'Item iB',
        quantityRequested: 25,
        fixes: {
          actions: [
            { kind: 'lower', quantity: 10, label: 'Lower to 10' },
            { kind: 'remove', label: 'Remove line' },
          ],
          note: null,
        },
      });
      // The row the confirms send people to.
      const row = document.getElementById('order-line-LB')!;
      expect(row.tagName).toBe('TR');
      expect(row).toHaveAttribute('tabindex', '-1');
    });

    // Review 2026-09-28: the one-click completion confirm names a line
    // waiting on a PO as short ("Item iP: 0 of 60") and "Review short lines"
    // focuses its row, so that row must carry its fix.
    it('to pick: a line waiting on a PO that the completion confirm names short carries its fix', async () => {
      asManager();
      orderAt('picking_in_progress', [orderLine('LN', 'iN', 30), orderLine('LP', 'iP', 60)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(
            ORDER_ID,
            'picking_in_progress',
            [
              { lineId: 'LN', itemId: 'iN', requested: 30 },
              { lineId: 'LP', itemId: 'iP', requested: 60 },
            ],
            [
              visibleItemFacts('iN', { here: { rack: 30 }, heldOwn: 30 }),
              visibleItemFacts('iP', {
                inbound: {
                  rows: [
                    { poId: 'po-1', poNumber: 'PO-2026-0042', status: 'ordered', expectedAt: '2026-10-03T16:00:00Z', remaining: 60 },
                  ],
                  hiddenRemaining: 0,
                  truncated: false,
                  truncatedRemaining: 0,
                },
              }),
            ],
          ),
        ),
      );

      await renderPage();

      expect(lastPanelProps().completionConfirm).toMatchObject({ focusLineId: 'LP' });
      expect(fixesFor('LN')).toBeUndefined();
      expect(fixesFor('LP')).toMatchObject({
        lineId: 'LP',
        fixes: { actions: [{ kind: 'remove', label: 'Remove line' }], note: null },
      });
    });

    it('picked: "Remove from order" for a line nothing was picked for, "Lower to what was picked" for a partial one', async () => {
      asManager();
      orderAt('staged_for_pickup', [
        orderLine('LN', 'iN', 60, { quantity_picked: 30 }),
        orderLine('LP', 'iP', 60, { quantity_picked: 0 }),
      ]);

      await renderPage();

      // Judged from the lines alone: the picked phase shows no readiness.
      expect(screen.queryByTestId('readiness-strip')).toBeNull();
      expect(fixesFor('LN')).toMatchObject({
        fixes: { actions: [{ kind: 'lower', quantity: 30, label: 'Lower to what was picked (30)' }], note: null },
      });
      expect(fixesFor('LP')).toMatchObject({
        fixes: { actions: [{ kind: 'remove', label: 'Remove from order' }], note: null },
      });
    });

    it('out for delivery the lines are final: the note, to the people who could have edited them', async () => {
      asManager();
      orderAt('in_transit', [orderLine('LN', 'iN', 60, { quantity_picked: 60 }), orderLine('LP', 'iP', 60, { quantity_picked: 0 })]);
      await renderPage();
      expect(fixesFor('LN')).toBeUndefined();
      expect(fixesFor('LP')).toMatchObject({ fixes: { actions: [], note: SHORT_LINE_FINAL_NOTE } });

      shortLineFixesProps.mockClear();
      as('staff', ['items:update']);
      await renderPage();
      expect(shortLineFixesProps).not.toHaveBeenCalled();
    });

    it('never for a viewer who may not edit the lines', async () => {
      as('staff', ['items:update']);
      orderAt('pending_approval', [orderLine('LB', 'iB', 25), orderLine('LA', 'iA', 5)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(
            ORDER_ID,
            'pending_approval',
            [
              { lineId: 'LB', itemId: 'iB', requested: 25 },
              { lineId: 'LA', itemId: 'iA', requested: 5 },
            ],
            [visibleItemFacts('iB', { here: { rack: 10 } }), visibleItemFacts('iA', { here: { rack: 10 } })],
          ),
        ),
      );

      await renderPage();

      expect(screen.getAllByTestId('readiness-line').map((c) => c.getAttribute('data-state'))).toContain('short');
      expect(shortLineFixesProps).not.toHaveBeenCalled();
    });
  });
});

/**
 * THE DATES CARD'S NEEDED-BY, in the org's zone (F2-1 production walk,
 * 2026-09-28): an order in a Los Angeles org due at 2:00 PM said 9:00 PM,
 * because the page formatted it with toLocaleString and no zone, in the
 * SERVER's zone (UTC on Vercel). These tests run the page with the server in
 * UTC, as production does; the org is in another zone.
 *
 * Where the zone comes from: the readiness facts carry it (0377
 * order.timeZone) in every phase, and that read is in flight for every order
 * from the moment the order is read, so no organizations read is added. A
 * failed read degrades as every surface does (core resolveOrgTimezone), never
 * to the server's zone.
 */
describe('orders/[id]: the Dates card prints the needed-by in the org zone', () => {
  const runtimeZone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'UTC';
  });
  afterEach(() => {
    if (runtimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = runtimeZone;
  });

  // 2:00 PM in Los Angeles, 4:00 PM in Chicago, 5:00 PM in New York, 9:00 PM UTC.
  const NEEDED_BY = '2026-09-28T21:00:00Z';
  const LINE = {
    id: 'LA',
    order_request_id: ORDER_ID,
    item_id: 'iA',
    quantity_requested: 5,
    quantity_fulfilled: 0,
    quantity_picked: null,
    returned_quantity: 0,
    unit_cost_at_request: 0,
    notes: null,
    item: { id: 'iA', name: 'Item iA', sku: 'SKU-iA', quantity_on_hand: 10, charter_name: null, charter_code: null },
  };
  function neededByRow(): HTMLElement {
    const dt = screen.getByText('Needed by', { selector: 'dt' });
    return dt.nextElementSibling as HTMLElement;
  }
  function asManager() {
    ctxHolder.current = { role: 'manager', permissions: new Set(['orders:read', 'orders:approve']) };
  }
  function orderAt(status: string, request: Record<string, unknown> = {}) {
    orderGet.mockResolvedValue(
      detailFixture({ request: requestFixture({ status, needed_by: NEEDED_BY, ...request }), lines: [LINE] }),
    );
  }
  function factsIn(status: string, timeZone: string) {
    return readinessOk(
      orderReadinessFacts(
        ORDER_ID,
        status,
        [{ lineId: 'LA', itemId: 'iA', requested: 5 }],
        [visibleItemFacts('iA', { here: { rack: 10 } })],
        { timeZone, neededBy: NEEDED_BY },
      ),
    );
  }

  it('an order past picking: the zone the readiness read in flight carries, never the server zone', async () => {
    orderAt('completed');
    readinessResult.mockResolvedValue(factsIn('completed', 'America/Los_Angeles'));

    await renderPage();

    expect(neededByRow()).toHaveTextContent('Mon, Sep 28, 2:00 PM');
    expect(neededByRow()).not.toHaveTextContent('9:00 PM');
    expect(readinessResult).toHaveBeenCalledTimes(1);
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
  });

  it('where readiness is shown: its zone, to the card and the approval panel', async () => {
    asManager();
    orderAt('pending_approval');
    readinessResult.mockResolvedValue(factsIn('pending_approval', 'America/New_York'));

    await renderPage();

    expect(neededByRow()).toHaveTextContent('Mon, Sep 28, 5:00 PM');
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
    // The approval panel's needed-by chip prints in the same zone.
    expect(managerActionsProps).toHaveBeenCalledWith(
      expect.objectContaining({ neededBy: NEEDED_BY, orgTimeZone: 'America/New_York' }),
    );
  });

  it('a viewer who is shown no readiness, on an order still to pick: the same read gives the zone', async () => {
    // Staff with orders:read on someone else's order: readiness audience none.
    orderAt('approved');
    readinessResult.mockResolvedValue(factsIn('approved', 'America/Chicago'));

    await renderPage();

    expect(screen.queryByTestId('readiness-strip')).toBeNull();
    expect(neededByRow()).toHaveTextContent('Mon, Sep 28, 4:00 PM');
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
  });

  it("a failed readiness read: the delivery request's zone when it was read, else core's default, never the server's", async () => {
    readinessResult.mockResolvedValue(READINESS_FAILED);

    // Nothing else read the zone: core's documented default (Los Angeles).
    orderAt('completed');
    const { unmount } = await renderPage();
    expect(neededByRow()).toHaveTextContent('Mon, Sep 28, 2:00 PM');
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
    unmount();

    // The requester's own delivery order read the org's zone for its email
    // draft (America/Chicago here): the card uses that read.
    orderAt('approved', { fulfillment_type: 'delivery', requester_user_id: 'u1' });
    await renderPage();
    expect(neededByRow()).toHaveTextContent('Mon, Sep 28, 4:00 PM');
    expect(getCachedOrgTimezoneMock).toHaveBeenCalledTimes(1);
  });

  it('no needed-by: no Needed by row and no organizations read', async () => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'completed' }), lines: [LINE] }));

    await renderPage();

    expect(screen.queryByText('Needed by', { selector: 'dt' })).toBeNull();
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
  });
});

// Walk D3 (found on the F2-3 walk, the same on main): at 390 px the title read
// "Or..." (the h1 was 58 px wide and needed 284), and "Order reques..." at 768
// with the sidebar, so the order's number was hidden. The title column was
// flex-1 with a 0 basis, so the actions never wrapped: they kept their width
// and the title took what was left. jsdom has no layout; the browser walk
// measures the widths, this pins the rule that gives them.
describe('orders/[id]: the title is never squeezed out by the actions', () => {
  it('the title column asks for 18rem before the actions share its line, so on a narrow screen they wrap under it', async () => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ order_number: 18 }) }));
    await renderPage();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Order request SO-000018');
    const column = h1.closest('[data-testid="order-title-column"]');
    expect(column).not.toBeNull();
    expect(column!.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'basis-72']));
    // The actions are the column's sibling on the same wrapping row.
    const row = column!.parentElement!;
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
  });
});
