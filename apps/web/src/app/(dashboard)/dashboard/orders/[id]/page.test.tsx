import { createHash } from 'node:crypto';
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
import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

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
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  // The Put away links are IntentLinks (they warm on intent, never on sight).
  usePathname: () => '/dashboard/orders/x',
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
// L85: who is offered Cancel request, recorded.
const cancelButtonProps = vi.fn();
vi.mock('@/components/orders/cancel-order-button', () => ({
  CancelOrderButton: (props: Record<string, unknown>) => {
    cancelButtonProps(props);
    return null;
  },
}));
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
// F2-4: the timeline prints a needed-by change's dates in the org's zone, so
// the zone it is handed is recorded.
const orderTimelineProps = vi.fn();
vi.mock('@/components/orders/order-timeline', () => ({
  OrderTimeline: (props: Record<string, unknown>) => {
    orderTimelineProps(props);
    return null;
  },
}));
// F2-4: "Change" beside the needed-by opens this dialog. Recording stubs: the
// dialog's own behaviour (and the button opening the page's one dialog) is
// pinned in revise-needed-by-dialog.test.tsx; this file pins WHO gets it,
// WHERE on the page the button sits, and WHAT the dialog is handed.
const reviseDialogProps = vi.fn();
vi.mock('@/components/orders/revise-needed-by-dialog', async () => {
  const React = await import('react');
  return {
    ReviseNeededByDialog: (props: Record<string, unknown>) => {
      reviseDialogProps(props);
      return null;
    },
    NeededByChangeButton: (props: { orderId: string }) =>
      React.createElement(
        'button',
        { type: 'button', 'data-testid': 'needed-by-change', 'data-order': props.orderId },
        'Change',
      ),
  };
});
// F2-5: "Draft PO for what is short" opens this dialog, mounted once at the
// top of the page. A recording stub: the dialog's own behaviour is pinned in
// draft-shortfall-po-dialog.test.tsx; this file pins WHO is offered it, WHAT
// the page hands it, and that the page reads nothing more for it.
const shortfallDialogProps = vi.fn();
vi.mock('@/components/orders/draft-shortfall-po-dialog', () => ({
  DraftShortfallPoDialog: (props: Record<string, unknown>) => {
    shortfallDialogProps(props);
    return null;
  },
}));
/** The views the page handed its dialog (null: no Change offered). */
const handedViews = () =>
  reviseDialogProps.mock.calls.map(([p]) => (p as { change: unknown }).change).filter((c) => c !== null);
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

// F2-4: the page asks the real rule whether the role alone gives every
// warehouse (roleSeesEveryWarehouse); only the access read is recorded.
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  roleSeesEveryWarehouse: (await importOriginal<typeof import('@/lib/auth/warehouse')>()).roleSeesEveryWarehouse,
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

// Migration 0389: the raw tokens are read through the admin client (order
// secrets). By default there is no service-role key (createAdminClient
// throws), which the page renders without; the hand-over tests hand it a stub.
const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (!adminHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return adminHolder.client;
  },
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
  adminHolder.client = null;
  withContextMock.mockImplementation(async () => ({ organizationId: 'org-1' }));
  orderGet.mockResolvedValue(detailFixture());
  attachmentsList.mockResolvedValue([]);
  returnableLinesForOrder.mockResolvedValue([]);
  getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: true, writableIds: [] });
  setPermissions(true);
  checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
  readinessResult.mockImplementation(async () => READINESS_FAILED);
  canStartCountMock.mockReturnValue(false);
});

// L85: a requester was offered Cancel request after their order was
// approved, and the service then refused it. The page now offers it to the
// requester only while the order waits for approval (core orderCancelOffer);
// an approver still gets it at every open status.
describe('orders/[id]: Cancel request (L85)', () => {
  it('the requester (no approve) is offered it while the order waits for approval', async () => {
    orderGet.mockResolvedValue(
      detailFixture({ request: requestFixture({ status: 'pending_approval', requester_user_id: 'u1' }) }),
    );
    await renderPage();
    expect(cancelButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, status: 'pending_approval' }),
    );
  });

  it('the requester (no approve) is not offered it once the order is approved', async () => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'approved', requester_user_id: 'u1' }) }));
    await renderPage();
    expect(cancelButtonProps).not.toHaveBeenCalled();
  });

  it('an approver is offered it on an approved order', async () => {
    ctxHolder.current = {
      role: 'manager',
      permissions: new Set(['orders:read', 'orders:approve']),
    };
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'approved' }) }));
    await renderPage();
    expect(cancelButtonProps).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });
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

describe('orders/[id]: the Collect signature link (migration 0389)', () => {
  const RAW = '4d'.repeat(32);
  const DIGEST = createHash('sha256').update(RAW).digest('hex');
  let admin: ReturnType<typeof makeSupabaseStub>;

  beforeEach(() => {
    ctxHolder.current = { role: 'manager', permissions: new Set(['orders:read', 'orders:approve']) };
    admin = makeSupabaseStub({
      'order_request_secrets.select': servedLikePostgrest([{ order_request_id: ORDER_ID, signature_token: RAW }]),
    });
    adminHolder.client = admin.client;
  });

  const panelProps = () => managerActionsProps.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  const sideReads = () => admin.fromCalls.filter((t) => t === 'order_request_secrets').length;

  it('an approver at staged for pickup gets the RAW token (its sha256 is the column), never the digest', async () => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'staged_for_pickup', signature_token: DIGEST }) }));
    await renderPage();
    expect(panelProps()?.signatureToken).toBe(RAW);
    expect(panelProps()?.handOverMfaMessage).toBeNull();
  });

  it('F2: an approver who owes an MFA step-up gets no link, the words instead, and the raw token is never read', async () => {
    withContextMock.mockImplementation(
      async () => ({ organizationId: 'org-1', mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }) as never,
    );
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'staged_for_pickup', signature_token: DIGEST }) }));
    await renderPage();
    expect(panelProps()?.signatureToken).toBeNull();
    expect(panelProps()?.handOverMfaMessage).toBe('Re-authenticate with MFA to collect a signature.');
    expect(sideReads()).toBe(0);
  });

  it('F2: a service context that failed holds the link back too (fail closed), with no words', async () => {
    withContextMock.mockImplementation(async () => {
      throw new Error('factors unreadable');
    });
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'in_transit', signature_token: DIGEST }) }));
    await renderPage();
    expect(panelProps()?.signatureToken).toBeNull();
    expect(panelProps()?.handOverMfaMessage).toBeNull();
    expect(sideReads()).toBe(0);
  });

  it("review 1: a staff approver gets the link only for an order in a warehouse they may write to (the mint's rule)", async () => {
    ctxHolder.current = { role: 'staff', permissions: new Set(['orders:read', 'orders:approve']) };
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'staged_for_pickup', signature_token: DIGEST }) }));
    getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: false, writableIds: ['wh-other'] });
    await renderPage();
    expect(panelProps()?.signatureToken).toBeNull();
    expect(sideReads()).toBe(0);

    getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: false, writableIds: ['wh-1'] });
    await renderPage();
    expect(panelProps()?.signatureToken).toBe(RAW);
  });

  it('review 1: a failed warehouse access read gives a staff approver no link (fail closed)', async () => {
    ctxHolder.current = { role: 'staff', permissions: new Set(['orders:read', 'orders:approve']) };
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'in_transit', signature_token: DIGEST }) }));
    getWarehouseAccessMock.mockRejectedValue(new Error('assignments unreadable'));
    await renderPage();
    expect(panelProps()?.signatureToken).toBeNull();
    expect(sideReads()).toBe(0);
  });

  it('no link before the order can be signed (packing slip generated): the raw token is not read', async () => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'packing_slip_generated', signature_token: DIGEST }) }));
    await renderPage();
    expect(panelProps()?.signatureToken).toBeNull();
    expect(sideReads()).toBe(0);
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
 * F2-3: PUT AWAY AND PARTIAL FULFILMENT FROM THE ORDER. Everything here comes
 * from the readiness read the page already makes (no read of its own): the
 * put-away links on the lines and the strip, and the approve-partial / resume
 * preview handed to the actions panel.
 */
describe('orders/[id]: put away and partial fulfilment from the order (F2-3)', () => {
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
  function orderAt(status: string, lines: unknown[]) {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status }), lines }));
  }
  function as(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer', perms: string[]) {
    ctxHolder.current = { role, permissions: new Set(['orders:read', ...perms]) };
  }
  const lastPanelProps = () => managerActionsProps.mock.calls.at(-1)![0] as Record<string, unknown>;
  const stagingHref = (...items: string[]) => `/dashboard/inventory/staging?order=${ORDER_ID}&item=${items.join(',')}`;
  /** The line cells' put-away links, by row. */
  const lineLinks = () =>
    screen.getAllByTestId('readiness-line').map((cell) => within(cell).queryByTestId('readiness-put-away-line'));

  /**
   * A ready on a rack; B needs put-away (10 rack + 30 Staging, 25 asked); C
   * short with 4 in Staging (2 rack + 4 Staging, 20 asked: its state is Short,
   * the worst bucket it touches, but 4 units would still be freed).
   */
  const LINES = [orderLine('LA', 'iA', 20), orderLine('LB', 'iB', 25), orderLine('LC', 'iC', 20)];
  const facts = (status: string) =>
    orderReadinessFacts(
      ORDER_ID,
      status,
      [
        { lineId: 'LA', itemId: 'iA', requested: 20 },
        { lineId: 'LB', itemId: 'iB', requested: 25 },
        { lineId: 'LC', itemId: 'iC', requested: 20 },
      ],
      [
        visibleItemFacts('iA', { here: { rack: 40 } }),
        visibleItemFacts('iB', { here: { rack: 10, staging: 30 } }),
        visibleItemFacts('iC', { here: { rack: 2, staging: 4 } }),
      ],
    );

  describe('Put away', () => {
    it('a viewer who may move stock: each line with units in Staging links to Staging for its item, and the strip for all of them', async () => {
      as('manager', ['orders:approve', 'stock:transfer', 'items:read']);
      orderAt('pending_approval', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('pending_approval')));

      await renderPage();

      // One read, the page's own: nothing added for put-away.
      expect(readinessForCurrentUser).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTestId('readiness-line').map((c) => c.getAttribute('data-state'))).toEqual([
        'ready',
        'needs_put_away',
        'short',
      ]);
      const [a, b, c] = lineLinks();
      expect(a).toBeNull();
      expect(b!.querySelector('a')).toHaveAttribute('href', stagingHref('iB'));
      expect(b).toHaveTextContent('Put away');
      // A Short line with units in Staging still offers them (its sentence
      // already says they must be put away).
      expect(c!.querySelector('a')).toHaveAttribute('href', stagingHref('iC'));
      const strip = screen.getByTestId('readiness-strip');
      const all = within(strip).getByRole('link', { name: 'Put away 2 items' });
      expect(all).toHaveAttribute('href', stagingHref('iB', 'iC'));
      expect(within(strip).queryByTestId('readiness-put-away-permission')).toBeNull();
    });

    it('without Transfer stock: no links, and the strip says why once', async () => {
      as('manager', ['orders:approve', 'items:read']);
      orderAt('pending_approval', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('pending_approval')));

      await renderPage();

      expect(lineLinks().every((l) => l === null)).toBe(true);
      const strip = screen.getByTestId('readiness-strip');
      expect(within(strip).queryByRole('link', { name: /Put away/ })).toBeNull();
      expect(within(strip).getByTestId('readiness-put-away-permission')).toHaveTextContent(
        'Putting stock away needs the Transfer stock permission.',
      );
    });

    // The Staging page answers 404 (and the phone's route 403) without
    // items:read: Transfer stock alone, by an override, must not get a link
    // that opens a refusal, nor be told to get Transfer stock.
    it('Transfer stock without View items: no links, and the strip names View items', async () => {
      as('manager', ['orders:approve', 'stock:transfer']);
      orderAt('pending_approval', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('pending_approval')));

      await renderPage();

      expect(lineLinks().every((l) => l === null)).toBe(true);
      const strip = screen.getByTestId('readiness-strip');
      expect(within(strip).queryByRole('link', { name: /Put away/ })).toBeNull();
      expect(within(strip).getByTestId('readiness-put-away-permission')).toHaveTextContent(
        'Putting stock away needs the View items permission.',
      );
    });

    it('a staff picker with Transfer stock gets it on a picking order too', async () => {
      as('staff', ['items:update', 'stock:transfer', 'items:read']);
      orderAt('picking_in_progress', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('picking_in_progress')));

      await renderPage();

      expect(within(screen.getByTestId('readiness-strip')).getByRole('link', { name: 'Put away 2 items' })).toHaveAttribute(
        'href',
        stagingHref('iB', 'iC'),
      );
    });

    it('two lines of one item name it once: "Put away 1 item"', async () => {
      as('manager', ['orders:approve', 'stock:transfer', 'items:read']);
      orderAt('pending_approval', [orderLine('L1', 'iB', 5), orderLine('L2', 'iB', 20)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(
            ORDER_ID,
            'pending_approval',
            [
              { lineId: 'L1', itemId: 'iB', requested: 5 },
              { lineId: 'L2', itemId: 'iB', requested: 20 },
            ],
            [visibleItemFacts('iB', { here: { rack: 10, staging: 30 } })],
          ),
        ),
      );

      await renderPage();

      expect(within(screen.getByTestId('readiness-strip')).getByRole('link', { name: 'Put away 1 item' })).toHaveAttribute(
        'href',
        stagingHref('iB'),
      );
    });

    it('nothing when nothing is in Staging, on a failed read, or for the requester', async () => {
      as('manager', ['orders:approve', 'stock:transfer', 'items:read']);
      orderAt('pending_approval', [orderLine('LA', 'iA', 20)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(ORDER_ID, 'pending_approval', [{ lineId: 'LA', itemId: 'iA', requested: 20 }], [
            visibleItemFacts('iA', { here: { rack: 40 } }),
          ]),
        ),
      );
      const ready = await renderPage();
      expect(screen.queryByTestId('readiness-put-away')).toBeNull();
      expect(screen.queryByTestId('readiness-put-away-permission')).toBeNull();
      ready.unmount();

      orderAt('pending_approval', LINES);
      readinessResult.mockResolvedValue(READINESS_FAILED);
      const failed = await renderPage();
      expect(screen.getByTestId('readiness-strip')).toHaveAttribute('data-failed', 'true');
      expect(screen.queryByTestId('readiness-put-away')).toBeNull();
      expect(screen.queryByTestId('readiness-put-away-permission')).toBeNull();
      failed.unmount();

      // The requester's own order: one sentence, no actions (with Transfer stock too).
      ctxHolder.current = { role: 'viewer', permissions: new Set(['orders:read', 'stock:transfer', 'items:read']) };
      orderGet.mockResolvedValue(
        detailFixture({ request: requestFixture({ status: 'pending_approval', requester_user_id: 'u1' }), lines: LINES }),
      );
      readinessResult.mockResolvedValue(readinessOk(facts('pending_approval')));
      await renderPage();
      expect(screen.getByTestId('readiness-strip')).toHaveAttribute('data-mode', 'requester');
      expect(screen.queryByTestId('readiness-put-away')).toBeNull();
      expect(screen.queryByTestId('readiness-put-away-permission')).toBeNull();
      expect(screen.queryByTestId('readiness-put-away-line')).toBeNull();
    });
  });

  describe('the approve-partial / resume preview', () => {
    it("pending: the panel gets core's per-item preview from the page's own read, duplicate lines combined", async () => {
      as('manager', ['orders:approve']);
      orderAt('pending_approval', [orderLine('L1', 'iM', 25), orderLine('L2', 'iM', 15), orderLine('L3', 'iN', 10)]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(
            ORDER_ID,
            'pending_approval',
            [
              { lineId: 'L1', itemId: 'iM', requested: 25 },
              { lineId: 'L2', itemId: 'iM', requested: 15 },
              { lineId: 'L3', itemId: 'iN', requested: 10 },
            ],
            [
              visibleItemFacts('iM', { name: 'Maus I', here: { rack: 36 } }),
              visibleItemFacts('iN', { name: 'Notebook', here: { rack: 10 } }),
            ],
          ),
        ),
      );

      await renderPage();

      expect(readinessForCurrentUser).toHaveBeenCalledTimes(1);
      const props = lastPanelProps();
      expect(props.stockGates).toMatchObject({ approvePartial: 'enabled' });
      expect(props.partialPreview).toMatchObject({
        state: 'ok',
        action: 'approve_partial',
        orderId: ORDER_ID,
        asked: 50,
        willHold: 46,
        backorder: 4,
        items: [
          { itemId: 'iM', itemName: 'Maus I', lineCount: 2, asked: 40, willHold: 36, backorder: 4 },
          { itemId: 'iN', itemName: 'Notebook', lineCount: 1, asked: 10, willHold: 10, backorder: 0 },
        ],
      });
    });

    it('backordered: the resume preview, on what is still owed', async () => {
      as('manager', ['orders:approve']);
      orderAt('backordered', [orderLine('L1', 'iM', 20, { quantity_fulfilled: 12 })]);
      readinessResult.mockResolvedValue(
        readinessOk(
          orderReadinessFacts(
            ORDER_ID,
            'backordered',
            [{ lineId: 'L1', itemId: 'iM', requested: 20, fulfilled: 12 }],
            [visibleItemFacts('iM', { here: { rack: 5 } })],
          ),
        ),
      );

      await renderPage();

      expect(lastPanelProps().partialPreview).toMatchObject({
        state: 'ok',
        action: 'resume',
        asked: 8,
        willHold: 5,
        backorder: 3,
      });
    });

    it('a failed read is an unavailable preview, never zeros', async () => {
      as('manager', ['orders:approve']);
      orderAt('pending_approval', LINES);
      readinessResult.mockResolvedValue(READINESS_FAILED);

      await renderPage();

      expect(lastPanelProps().partialPreview).toMatchObject({
        state: 'unavailable',
        action: 'approve_partial',
        reason: 'read_failed',
      });
    });

    it('none for a viewer who may not approve, and none outside the two statuses', async () => {
      // A pending order: someone who may not approve gets no actions panel at
      // all (so the preview's canApprove guard is defence in depth there).
      as('staff', ['items:update', 'stock:transfer', 'items:read']);
      orderAt('pending_approval', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('pending_approval')));
      const pending = await renderPage();
      expect(managerActionsProps).not.toHaveBeenCalled();
      pending.unmount();

      as('staff', ['items:update']);
      orderAt('picking_in_progress', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('picking_in_progress')));
      const picker = await renderPage();
      expect(lastPanelProps().partialPreview).toBeNull();
      picker.unmount();

      as('manager', ['orders:approve']);
      orderAt('approved', LINES);
      readinessResult.mockResolvedValue(readinessOk(facts('approved')));
      await renderPage();
      expect(lastPanelProps().partialPreview).toBeNull();
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

describe('orders/[id]: the way back to Book Order Totals (plan D17)', () => {
  // The report's drawer opens an order with ?return=<the report view>. The
  // page offers "Back to Book Order Totals" to exactly that view, and only
  // for the report's own path; anything else keeps "Back to orders".
  const REPORT = '/dashboard/reports/book-order-totals';
  const VIEW = `${REPORT}?charter=0e000000-0000-4000-8000-0000000000a1&range=custom&from=2026-09-01&to=2026-09-30&q=Outsiders&page=2&view=0e000000-0000-4000-8000-000000000f01`;

  async function renderWithReturn(value?: string | string[]) {
    return render(
      await OrderDetailPage({
        params: Promise.resolve({ id: ORDER_ID }),
        searchParams: Promise.resolve(value === undefined ? {} : { return: value }),
      }),
    );
  }

  it('opened from the report: the link goes back to that exact view', async () => {
    await renderWithReturn(VIEW);
    const back = screen.getByRole('link', { name: '← Back to Book Order Totals' });
    expect(back).toHaveAttribute('href', VIEW);
    expect(screen.queryByRole('link', { name: '← Back to orders' })).toBeNull();
  });

  it.each([
    ['no return at all', undefined],
    ['another origin', `https://evil.com${REPORT}`],
    ['a protocol-relative URL', '//evil.com'],
    ['a look-alike path', `${REPORT}-evil`],
    ['another dashboard page', '/dashboard/orders'],
    ['javascript:', 'javascript:alert(1)'],
    ['return given twice', [VIEW, '//evil.com']],
  ])('%s: keeps "Back to orders"', async (_what, value) => {
    await renderWithReturn(value);
    expect(screen.getByRole('link', { name: '← Back to orders' })).toHaveAttribute(
      'href',
      '/dashboard/orders',
    );
    expect(screen.queryByText(/Back to Book Order Totals/)).toBeNull();
  });

  it('a caller that passes no searchParams at all (the Orders list link) keeps "Back to orders"', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: '← Back to orders' })).toHaveAttribute(
      'href',
      '/dashboard/orders',
    );
  });
});

// ── F2-4: change the needed-by date ─────────────────────────────────────────
//
// WHO is offered "Change" (an approver with write access to the order's
// warehouse, on an open order, once the org's zone is read), WHERE (on the
// readiness strip where the full strip is shown; in the Dates card
// otherwise, never both), WHAT the dialog is handed (the needed-by EXACTLY
// as read, the org's zone as the facts carry it), and that it costs the page
// no round trip of its own. Each assertion fails if the page stops passing
// the entry (the call-site pins).

describe("orders/[id]: change the needed-by date (F2-4)", () => {
  // Exactly as PostgREST prints it, microseconds included: 2:00 PM on Thu Oct
  // 1 in New York.
  const NEEDED_BY = '2026-10-01T18:00:00.123456+00:00';
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
  function as(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer', perms: string[]) {
    ctxHolder.current = { role, permissions: new Set(['orders:read', ...perms]) };
  }
  function orderAt(status: string, request: Record<string, unknown> = {}, lines: unknown[] = [LINE]) {
    orderGet.mockResolvedValue(
      detailFixture({ request: requestFixture({ status, needed_by: NEEDED_BY, ...request }), lines }),
    );
  }
  function factsAt(status: string, timeZone: string | null = 'America/New_York') {
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
  const lastChange = () => (reviseDialogProps.mock.calls.at(-1)![0] as { change: Record<string, unknown> }).change;
  const inStrip = () => within(screen.getByTestId('readiness-strip')).queryByTestId('needed-by-change');
  const inDates = () => within(screen.getByTestId('dates-needed-by')).queryByTestId('needed-by-change');

  it('the dialog is mounted ONCE, at the top of the page, so a refresh that moves or removes Change never takes an open dialog with it', () => {
    // Change moves from the strip to the Dates card when picking completes,
    // and goes when the readiness read fails or the order closes; the dialog
    // sits beside OrderRealtimeRefresh, which no status or read moves.
    const src = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');
    expect(src.split('<ReviseNeededByDialog').length - 1).toBe(1);
    expect(src).toMatch(
      /<OrderRealtimeRefresh orderId=\{id\} \/>\s*<ReviseNeededByDialog change=\{neededByChange\} trigger=\{false\} \/>/,
    );
    const strip = readFileSync(path.resolve(__dirname, '../../../../../components/orders/readiness-strip.tsx'), 'utf8');
    expect(strip).not.toContain('<ReviseNeededByDialog');
  });

  it('a manager on an order still to pick: Change on the strip, beside the date in the org zone; handed the date exactly as read; no access read', async () => {
    as('manager', ['orders:approve']);
    orderAt('approved');
    readinessResult.mockResolvedValue(factsAt('approved'));

    await renderPage();

    const row = within(screen.getByTestId('readiness-strip')).getByTestId('readiness-needed-by-change');
    expect(row).toHaveTextContent('Needed by Thu, Oct 1, 2:00 PM');
    expect(within(row).getByTestId('needed-by-change')).toBeInTheDocument();
    // One way to it: not in the Dates card too.
    expect(inDates()).toBeNull();
    // Mounted once, by the page, opened by the button (never its own trigger).
    expect(reviseDialogProps).toHaveBeenCalledTimes(1);
    expect(reviseDialogProps.mock.calls[0]![0]).toMatchObject({ trigger: false });
    expect(within(row).getByTestId('needed-by-change')).toHaveAttribute('data-order', ORDER_ID);
    expect(lastChange()).toEqual({
      orderId: ORDER_ID,
      neededBy: NEEDED_BY,
      status: 'approved',
      timeZone: 'America/New_York',
      rowLabel: 'Needed by Thu, Oct 1, 2:00 PM',
    });
    // The role decides a manager's warehouse access: nothing is read for it.
    expect(getWarehouseAccessMock).not.toHaveBeenCalled();
    expect(readinessResult).toHaveBeenCalledTimes(1);
  });

  it('a pending order: the same, with its status (saving then waits for approval to reach the Schedule)', async () => {
    as('admin', ['orders:approve']);
    orderAt('pending_approval');
    readinessResult.mockResolvedValue(factsAt('pending_approval'));
    await renderPage();
    expect(inStrip()).not.toBeNull();
    expect(lastChange()).toMatchObject({ status: 'pending_approval', neededBy: NEEDED_BY });
  });

  it('an order with no needed-by: "No needed-by date" and Change, so an approver can set one', async () => {
    as('manager', ['orders:approve']);
    orderAt('approved', { needed_by: null });
    readinessResult.mockResolvedValue(factsAt('approved'));
    await renderPage();
    expect(within(screen.getByTestId('readiness-strip')).getByTestId('readiness-needed-by-change')).toHaveTextContent(
      'No needed-by date',
    );
    expect(lastChange()).toMatchObject({ neededBy: null, rowLabel: 'No needed-by date' });
  });

  it('past picking (no strip): Change in the Dates card, in the zone the readiness read in flight carries', async () => {
    as('manager', ['orders:approve']);
    orderAt('staged_for_delivery', { fulfillment_type: 'delivery' });
    readinessResult.mockResolvedValue(factsAt('staged_for_delivery', 'America/Chicago'));

    await renderPage();

    expect(screen.queryByTestId('readiness-strip')).toBeNull();
    expect(inDates()).not.toBeNull();
    // 18:00Z is 1:00 PM in Chicago.
    expect(screen.getByTestId('dates-needed-by')).toHaveTextContent('Thu, Oct 1, 1:00 PM');
    expect(lastChange()).toMatchObject({ status: 'staged_for_delivery', timeZone: 'America/Chicago' });
    expect(readinessResult).toHaveBeenCalledTimes(1);
    expect(getCachedOrgTimezoneMock).not.toHaveBeenCalled();
  });

  it('past picking with no needed-by: the Dates card row appears for the approver, with Change', async () => {
    as('manager', ['orders:approve']);
    orderAt('in_transit', { needed_by: null });
    readinessResult.mockResolvedValue(factsAt('in_transit'));
    await renderPage();
    expect(screen.getByTestId('dates-needed-by')).toHaveTextContent('—');
    expect(inDates()).not.toBeNull();
    expect(lastChange()).toMatchObject({ neededBy: null, status: 'in_transit' });
  });

  it('an order with no lines (no strip): Change in the Dates card', async () => {
    as('manager', ['orders:approve']);
    orderAt('pending_approval', {}, []);
    readinessResult.mockResolvedValue(factsAt('pending_approval'));
    await renderPage();
    expect(screen.queryByTestId('readiness-strip')).toBeNull();
    expect(inDates()).not.toBeNull();
  });

  it("a staff approver: Change only with write access to the order's warehouse, their access read beside the order read", async () => {
    as('staff', ['orders:approve', 'items:update']);
    let releaseOrder!: () => void;
    orderGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOrder = () =>
            resolve(detailFixture({ request: requestFixture({ status: 'approved', needed_by: NEEDED_BY }), lines: [LINE] }));
        }),
    );
    readinessResult.mockResolvedValue(factsAt('approved'));
    getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: false, writableIds: ['wh-1'] });

    const page = OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) });
    await vi.waitFor(() => expect(orderGet).toHaveBeenCalledWith(ORDER_ID));
    // Asked for before the order read answered: never a level of its own.
    await vi.waitFor(() => expect(getWarehouseAccessMock).toHaveBeenCalledTimes(1));
    releaseOrder();
    render(await page);

    expect(inStrip()).not.toBeNull();
    expect(getWarehouseAccessMock).toHaveBeenCalledTimes(1);
  });

  it('a staff approver assigned to another warehouse, a read-only viewer with the grant, or a failed access read: no Change', async () => {
    readinessResult.mockResolvedValue(factsAt('approved'));

    as('staff', ['orders:approve']);
    orderAt('approved');
    getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: false, writableIds: ['wh-2'] });
    let r = await renderPage();
    expect(screen.getByTestId('readiness-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
    r.unmount();

    // The all-warehouses flag is write access everywhere.
    getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: true, writableIds: [] });
    r = await renderPage();
    expect(inStrip()).not.toBeNull();
    r.unmount();

    as('viewer', ['orders:approve']);
    getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: true, writableIds: ['wh-1'] });
    r = await renderPage();
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
    r.unmount();

    as('staff', ['orders:approve']);
    getWarehouseAccessMock.mockRejectedValue(new Error('gateway'));
    await renderPage();
    expect(screen.getByTestId('readiness-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
  });

  it('never for anyone who may not approve: a picker, or the requester', async () => {
    readinessResult.mockResolvedValue(factsAt('approved'));
    as('staff', ['items:update']);
    orderAt('approved');
    let r = await renderPage();
    expect(screen.getByTestId('readiness-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
    r.unmount();

    as('staff', ['orders:request']);
    orderAt('approved', { requester_user_id: 'u1' });
    r = await renderPage();
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
    r.unmount();
    expect(handedViews()).toEqual([]);
    // And no access read for them.
    expect(getWarehouseAccessMock).not.toHaveBeenCalled();
  });

  it('never on a closed order, where the save would refuse', async () => {
    as('manager', ['orders:approve']);
    for (const status of ['completed', 'cancelled', 'denied', 'pending_confirmation']) {
      orderAt(status);
      readinessResult.mockResolvedValue(factsAt(status));
      const r = await renderPage();
      expect(screen.queryByTestId('needed-by-change')).toBeNull();
      r.unmount();
    }
    expect(handedViews()).toEqual([]);
  });

  it("a failed readiness read: no Change (the org's zone is not known, and a preview in a guessed zone would be wrong)", async () => {
    as('manager', ['orders:approve']);
    readinessResult.mockResolvedValue(READINESS_FAILED);

    orderAt('approved');
    let r = await renderPage();
    // The strip says it could not check; Check again reads it again.
    expect(screen.getByTestId('readiness-strip')).toHaveAttribute('data-failed', 'true');
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
    r.unmount();

    orderAt('staged_for_pickup');
    r = await renderPage();
    expect(screen.queryByTestId('needed-by-change')).toBeNull();
    // The date still prints (in the fallback zone), without Change.
    expect(screen.getByTestId('dates-needed-by')).toBeInTheDocument();
    expect(handedViews()).toEqual([]);
  });

  it("an org with no zone set: core's default, as the server resolves it", async () => {
    as('manager', ['orders:approve']);
    orderAt('approved');
    readinessResult.mockResolvedValue(factsAt('approved', null));
    await renderPage();
    expect(lastChange()).toMatchObject({ timeZone: 'America/Los_Angeles', rowLabel: 'Needed by Thu, Oct 1, 11:00 AM' });
  });

  it("the timeline is handed the org's zone, so a change's dates print in it", async () => {
    as('manager', ['orders:approve']);
    orderAt('approved');
    readinessResult.mockResolvedValue(factsAt('approved'));
    await renderPage();
    expect(orderTimelineProps).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, timeZone: 'America/New_York' }),
    );
  });
});

describe('orders/[id]: draft a PO for what is short (F2-5)', () => {
  const ITEM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const ITEM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
  function orderLine(id: string, itemId: string, requested: number) {
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
      item: { id: itemId, name: `Item ${itemId}`, sku: null, quantity_on_hand: 2, charter_name: null, charter_code: null },
    };
  }
  const LINES = [orderLine('LA', ITEM_A, 10), orderLine('LB', ITEM_B, 5)];
  function as(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer', perms: string[]) {
    ctxHolder.current = { role, permissions: new Set(['orders:read', ...perms]) };
  }
  /** The service context the page already started (its modules). */
  function modules(ids: string[]) {
    withContextMock.mockResolvedValue({ organizationId: 'org-1', enabledModules: new Set(ids) } as never);
  }
  /** A: 10 owed, 2 on the shelf (8 to draft). B: 5 owed, 5 on the shelf. */
  function factsWith(aOver: Record<string, unknown> = {}, bOver: Record<string, unknown> = {}) {
    return readinessOk(
      orderReadinessFacts(
        ORDER_ID,
        'approved',
        [
          { lineId: 'LA', itemId: ITEM_A, requested: 10 },
          { lineId: 'LB', itemId: ITEM_B, requested: 5 },
        ],
        [
          visibleItemFacts(ITEM_A, { here: { rack: 2 }, supplierId: 'sup-1', ...aOver }),
          visibleItemFacts(ITEM_B, { here: { rack: 5 }, ...bOver }),
        ],
      ),
    );
  }
  const handedOffers = () => shortfallDialogProps.mock.calls.map(([p]) => (p as { offer: unknown }).offer);
  const strip = () => screen.getByTestId('readiness-strip');

  beforeEach(() => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'approved' }), lines: LINES }));
    modules(['orders', 'purchase_orders']);
  });
  afterEach(() => {
    withContextMock.mockResolvedValue({ organizationId: 'org-1' });
  });

  it("a manager with purchase-order access: the button on the strip, and the page's dialog gets this order's view, from the page's own read", async () => {
    as('manager', ['orders:approve', 'purchase_orders:manage', 'purchase_orders:read']);
    readinessResult.mockResolvedValue(factsWith());

    await renderPage();

    expect(within(strip()).getByRole('button', { name: 'Draft PO for what is short' })).toHaveAttribute(
      'data-shortfall-po',
      ORDER_ID,
    );
    expect(within(strip()).queryByTestId('readiness-shortfall-po-permission')).toBeNull();
    // Mounted once, and handed the order, the view core made of the page's
    // own readiness read, and the org's zone the strip prints in.
    expect(shortfallDialogProps).toHaveBeenCalledTimes(1);
    const offer = handedOffers()[0] as {
      orderId: string;
      timeZone: string;
      view: { orderId: string; draftableCount: number; rows: Array<{ itemId: string; draftable: number; supplierId: string | null }> };
    };
    expect(offer.orderId).toBe(ORDER_ID);
    expect(offer.timeZone).toBe('America/Los_Angeles');
    expect(offer.view.orderId).toBe(ORDER_ID);
    expect(offer.view.draftableCount).toBe(1);
    expect(offer.view.rows.map((r) => [r.itemId, r.draftable, r.supplierId])).toEqual([[ITEM_A, 8, 'sup-1']]);
    // No read of its own: one readiness read, and no supplier names on the page.
    expect(readinessForCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("anyone else on the full strip gets core's sentence and no dialog: a manager without purchase_orders:manage, staff with it", async () => {
    for (const [role, perms] of [
      ['manager', ['orders:approve', 'purchase_orders:read']],
      ['staff', ['items:update', 'purchase_orders:manage']],
    ] as const) {
      shortfallDialogProps.mockClear();
      as(role, [...perms]);
      readinessResult.mockResolvedValue(factsWith());
      const { unmount } = await renderPage();
      expect(within(strip()).queryByRole('button', { name: 'Draft PO for what is short' })).toBeNull();
      expect(within(strip()).getByTestId('readiness-shortfall-po-permission')).toHaveTextContent(
        'Drafting a PO needs a manager with purchase-order access.',
      );
      expect(handedOffers()).toEqual([null]);
      unmount();
    }
  });

  it('nothing when nothing may be drafted: all covered by a PO, the PO module off, a failed read', async () => {
    as('manager', ['orders:approve', 'purchase_orders:manage', 'purchase_orders:read']);
    const cases = [
      // A's 8 already on an ordered PO.
      factsWith({
        inbound: {
          rows: [{ poId: 'po-1', poNumber: 'PO-2026-0021', status: 'ordered', expectedAt: null, remaining: 8 }],
          hiddenRemaining: 0,
          truncated: false,
          truncatedRemaining: 0,
        },
      }),
      // The purchase-orders module off: readiness reads no POs.
      factsWith({ inbound: null, drafts: null }, { inbound: null, drafts: null }),
      READINESS_FAILED,
    ];
    for (const [i, r] of cases.entries()) {
      shortfallDialogProps.mockClear();
      if (i === 1) modules(['orders']);
      readinessResult.mockResolvedValue(r);
      const { unmount } = await renderPage();
      expect(screen.queryByTestId('readiness-draft-shortfall-po')).toBeNull();
      expect(screen.queryByTestId('readiness-shortfall-po-permission')).toBeNull();
      expect(handedOffers()).toEqual([null]);
      unmount();
    }
  });

  it("the modules come from the page's own service context: with purchase_orders off there, no button even if a read said otherwise", async () => {
    as('manager', ['orders:approve', 'purchase_orders:manage', 'purchase_orders:read']);
    modules(['orders']);
    readinessResult.mockResolvedValue(factsWith());
    await renderPage();
    expect(screen.queryByTestId('readiness-draft-shortfall-po')).toBeNull();
    // Never the permission sentence to a manager who holds the permission.
    expect(screen.queryByTestId('readiness-shortfall-po-permission')).toBeNull();
    expect(handedOffers()).toEqual([null]);
    // The context the page had already started: nothing new asked for.
    expect(withContextMock).toHaveBeenCalledTimes(1);
  });

  it('the requester gets no numbers, so no offer and no sentence', async () => {
    as('viewer', []);
    orderGet.mockResolvedValue(
      detailFixture({ request: requestFixture({ status: 'approved', requester_user_id: 'u1' }), lines: LINES }),
    );
    readinessResult.mockResolvedValue(factsWith());
    await renderPage();
    expect(strip()).toHaveAttribute('data-mode', 'requester');
    expect(screen.queryByTestId('readiness-draft-shortfall-po')).toBeNull();
    expect(screen.queryByTestId('readiness-shortfall-po-permission')).toBeNull();
    expect(handedOffers()).toEqual([null]);
  });

  it('the page mounts the dialog once, beside the needed-by dialog, never inside the strip, and reads no supplier names', () => {
    const src = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
    expect(src.match(/<DraftShortfallPoDialog\b/g)).toHaveLength(1);
    expect(src).toMatch(
      /<ReviseNeededByDialog change=\{neededByChange\} trigger=\{false\} \/>\s*<DraftShortfallPoDialog offer=\{shortfallPoOffer\} \/>/,
    );
    expect(src).toMatch(/shortfallPo=\{readinessShortfallPo\}/);
    // Supplier names are read when the dialog opens, never by the page.
    expect(src).not.toMatch(/SuppliersService|listForLookups|from\('suppliers'\)/);
    // The view comes from the page's own readiness result.
    expect(src).toMatch(/shortfallPoView\(readinessAssessment\)/);
  });
});
