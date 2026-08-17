import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/components/orders/manager-actions-panel', () => ({ ManagerActionsPanel: () => null }));
vi.mock('@/components/orders/order-line-actions', () => ({ OrderLineActions: () => null }));
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
