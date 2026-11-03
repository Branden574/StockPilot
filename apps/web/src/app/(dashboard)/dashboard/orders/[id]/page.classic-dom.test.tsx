import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderReadinessResult } from '@stockpilot/core';

import { READINESS_FAILED } from '@/test/order-readiness-facts';
import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). The order page's own
 * Classic DOM (its header, the lines card, the side column and every section
 * it draws itself; the child components are stubbed exactly as page.test.tsx
 * stubs them, and are pinned by their own tests), normalised as the classic
 * proof normalises it (src/test/classic-dom.ts), pinned in __classic__/ from
 * the code BEFORE the glass hooks were added. Liquid Glass may add only inert
 * hook attributes and glass-only elements; with them stripped, the page must
 * render exactly the pinned DOM under the `off` rollout (with no glass-only
 * element at all) and under `default`. Fix the change, never the snapshot.
 *
 * The mocks below are page.test.tsx's, copied verbatim, so the two files
 * render the same page.
 */

const orderGet = vi.fn();
const attachmentsList = vi.fn(async () => []);
const returnableLinesForOrder = vi.fn(async () => []);
const checkModuleAccessMock = vi.fn();
const getWarehouseAccessMock = vi.fn(
  async (
    _ctx?: unknown,
  ): Promise<{ hasAllAccess: boolean; writableIds: string[]; readableIds?: string[] }> => ({
    hasAllAccess: true,
    writableIds: [],
  }),
);
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
// Security slice E: who is offered Add items, recorded.
const addItemsProps = vi.fn();
vi.mock('@/components/orders/add-items-dialog', () => ({
  AddItemsDialog: (props: Record<string, unknown>) => {
    addItemsProps(props);
    return null;
  },
}));
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
vi.mock('@/components/orders/delivery-location-share', () => ({
  DeliveryLocationShare: () => null,
}));
vi.mock('@/components/returns/create-return-dialog', () => ({ CreateReturnDialog: () => null }));
vi.mock('@/components/orders/order-attachments-panel', () => ({
  OrderAttachmentsPanel: () => null,
}));
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
// L50b: whether the shipping panel mounts, recorded.
const shippingPanelProps = vi.fn();
vi.mock('@/components/orders/shipping-panel', () => ({
  ShippingPanel: (props: Record<string, unknown>) => {
    shippingPanelProps(props);
    return null;
  },
}));
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
// sample pair by default (a configured org's state); individual tests
// override to pin the hidden states.
const getOrgEmailRoutingMock = vi.fn(async (_orgId: string, _feature: string) => ({
  state: 'valid' as const,
  recipients: {
    to: 'dc4@sampleorg.test',
    cc: 'jstone@site1.test',
    toName: 'Fresno Warehouse DC4',
    ccName: 'Jordan Stone',
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
  roleSeesEveryWarehouse: (await importOriginal<typeof import('@/lib/auth/warehouse')>())
    .roleSeesEveryWarehouse,
  getWarehouseAccess: (ctx: unknown) => getWarehouseAccessMock(ctx),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  // Orders, the page's own module, is on: the page checks it before it reads
  // (B66). The mock answers every other module.
  checkModuleAccess: (...args: unknown[]) =>
    args[0] === 'orders'
      ? Promise.resolve({ enabled: true, canManage: false })
      : checkModuleAccessMock(...args),
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
const readinessResult = vi.fn(
  async (_orderId: string): Promise<OrderReadinessResult> => READINESS_FAILED,
);
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

const ORDER_ID = '11111111-1111-1111-1111-111111111111';

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

import OrderDetailPage from './page';

const NOW = new Date('2026-11-02T18:00:00Z');

const LINE = (id: string, name: string, sku: string, requested: number, onHand: number) => ({
  id,
  order_request_id: ORDER_ID,
  item_id: `item-${id}`,
  quantity_requested: requested,
  quantity_fulfilled: 0,
  quantity_picked: null,
  returned_quantity: 0,
  unit_cost_at_request: 0,
  notes: null,
  item: {
    id: `item-${id}`,
    name,
    sku,
    quantity_on_hand: onHand,
    charter_name: null,
    charter_code: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  adminHolder.client = null;
  withContextMock.mockImplementation(async () => ({ organizationId: 'org-1' }));
  attachmentsList.mockResolvedValue([]);
  returnableLinesForOrder.mockResolvedValue([]);
  getWarehouseAccessMock.mockResolvedValue({ hasAllAccess: true, writableIds: [] });
  checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
  readinessResult.mockImplementation(async (): Promise<OrderReadinessResult> => READINESS_FAILED);
  canStartCountMock.mockReturnValue(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const SCENARIOS: Array<{ name: string; setup: () => void }> = [
  {
    name: 'approver-pending-approval',
    setup: () => {
      ctxHolder.current = {
        role: 'manager',
        permissions: new Set(['orders:read', 'orders:request', 'orders:approve']),
      };
      orderGet.mockResolvedValue(
        detailFixture({
          request: requestFixture({
            status: 'pending_approval',
            approved_at: null,
            needed_by: '2026-11-06T23:00:00Z',
            notes: 'Two new front-office hires start Monday.',
          }),
          lines: [
            LINE('LA', 'Staff Polo, Navy, M', 'APP-POLO-NVY-M', 2, 6),
            LINE('LB', 'Safety Vest, Hi-Vis', 'SAF-VEST-HV', 6, 46),
          ],
        }),
      );
    },
  },
  {
    name: 'requester-approved',
    setup: () => {
      ctxHolder.current = {
        role: 'staff',
        permissions: new Set(['orders:read', 'orders:request', 'maintenance_requests:submit']),
      };
      orderGet.mockResolvedValue(
        detailFixture({
          request: requestFixture({ status: 'approved', requester_user_id: 'u1' }),
          lines: [LINE('LA', 'Whiteboard Markers, 4-pack', 'OFF-WBM-4', 10, 75)],
        }),
      );
    },
  },
  {
    name: 'manager-completed-delivery',
    setup: () => {
      ctxHolder.current = {
        role: 'manager',
        permissions: new Set(['orders:read', 'orders:request', 'orders:approve']),
      };
      orderGet.mockResolvedValue(
        detailFixture({
          request: requestFixture({
            status: 'completed',
            fulfillment_type: 'delivery',
            completed_at: '2026-08-03T16:00:00Z',
            signed_by_name: 'Sam Receiver',
            signed_at: '2026-08-03T15:55:00Z',
          }),
          lines: [LINE('LA', 'Folding Chair', 'FUR-CHAIR-F', 12, 36)],
        }),
      );
    },
  },
];

async function renderUnder(rollout: 'off' | 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(await OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) }));
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('Order page, Classic DOM', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: the pinned Classic DOM under off and under default`, async () => {
      scenario.setup();
      const off = await renderUnder('off');
      expect(off.glassOnly).toBe(0);
      scenario.setup();
      const glass = await renderUnder('default');
      expect(glass.dom).toBe(off.dom);
      // No Classic element changes its place among its siblings (classicStructure).
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/order-detail.${scenario.name}.txt`);
    });
  }
});
