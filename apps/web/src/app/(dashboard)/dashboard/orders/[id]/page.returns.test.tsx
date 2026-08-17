import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The PHONE's decision module for the same feature, imported by path so this
// file holds both surfaces at once: the real web page rendered below, and the
// module the native order screen (apps/mobile/app/order/[id].tsx) maps its
// rows through. Mobile's vitest cannot reach apps/web; web can reach this.
import * as mobile from '../../../../../../../mobile/src/lib/order-returns';

/**
 * ORDER-SIDE RETURN VISIBILITY (owner report, SO-000085, 2026-08-17).
 *
 * A delivered three-line order (all 1/1, owed 0) had a closed RMA that
 * restocked the Women's Polo S; the order page showed nothing about it, and
 * the swap for a Medium lived only in the RMA's notes. This file drives the
 * REAL order page (only the database and unrelated children are stubbed) and
 * pins, by mutation:
 *
 *   (a) a line with an APPLIED return shows the returned quantity beside the
 *       shipped count, names the RMA, and the RMA panel lists the return
 *       with its notes;
 *   (b) quantity_fulfilled is never rewritten by a return — the shipped
 *       figure and Owed are unchanged when returned_quantity flips 0 -> 1;
 *   (c) an order with NO returns renders exactly as before — no strip, no
 *       returned sub-line, no panel, no "returned" anywhere (golden by
 *       negation, plus the render is byte-identical whether the returns read
 *       returned [] or threw);
 *   (d) an UNAPPLIED return (in flight, denied, cancelled) counts for nothing
 *       in the returned figure — the rule is the 0197 `applied` latch, and
 *       the number rendered is `returned_quantity`, which that latch bumps;
 *   (e) the phone's decisions equal what the web page renders for the same
 *       input — the strings are compared against the MOBILE module (which
 *       re-exports core), and the mobile screen source is scanned to prove it
 *       renders through that module rather than a hand-rolled copy.
 */

const orderGet = vi.fn();
const attachmentsList = vi.fn(async () => []);
const returnableLinesForOrder = vi.fn(async () => []);
const loadOrderReturnsMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const checkModuleAccessMock = vi.fn(async (_moduleId: string) => ({ enabled: false, canManage: false }));
const getWarehouseAccessMock = vi.fn(async (_ctx?: unknown) => ({ hasAllAccess: true, writableIds: [] as string[] }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});

// Every child component that is not the lines table / returns panel — stubbed
// to null. Their own behaviour is covered elsewhere.
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
vi.mock('@/components/maintenance/report-problem-button', () => ({ ReportProblemButton: () => null }));
vi.mock('@/components/orders/send-delivery-request-button', () => ({ SendDeliveryRequestButton: () => null }));

vi.mock('@/lib/dashboard/cached-org', () => ({
  getCachedOrgTimezone: vi.fn(async () => 'America/Chicago'),
  getOrgEmailRouting: vi.fn(async () => ({ state: 'unset' })),
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
  checkModuleAccess: (moduleId: string) => checkModuleAccessMock(moduleId),
}));

const SUPABASE_CLIENT = { from: () => ({}) } as const;
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => SUPABASE_CLIENT),
}));

vi.mock('@/server/services/order-attachments', () => ({
  ATTACHABLE_ORDER_STATUSES: ['staged_for_pickup', 'staged_for_delivery', 'in_transit', 'completed'],
  OrderAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: attachmentsList })) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ get: orderGet })) },
}));
vi.mock('@/server/services/returns', () => ({
  RMAService: { forCurrentUser: vi.fn(async () => ({ returnableLinesForOrder })) },
  loadOrderReturns: (...args: unknown[]) => loadOrderReturnsMock(...args),
}));

import OrderDetailPage from './page';

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const S_LINE = '5e840bc6-0000-0000-0000-000000000000';
const M_LINE = 'line-m';
const XL_LINE = 'line-xl';
const RMA_ID = '85d6084b-0000-0000-0000-000000000000';
const RMA_NUMBER = 'RMA-20260817-EEF074';
const RMA_NOTES = 'Size S New Hire shirt was swapped out for Ladies size M';

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    order_number: 85,
    needed_by: null,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'completed',
    requester_user_id: 'other-user',
    requester_email: null,
    requester_name: 'Lillian',
    requester_org_label: null,
    approved_by: null,
    approved_at: '2026-08-17T16:00:00Z',
    denied_reason: null,
    packaging_at: null,
    ready_at: null,
    delivered_at: null,
    cancelled_at: null,
    cancelled_by: null,
    notes: null,
    internal_notes: null,
    source: 'internal',
    created_at: '2026-08-17T15:00:00Z',
    updated_at: '2026-08-17T17:00:00Z',
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
    completed_at: '2026-08-17T16:40:00Z',
    completed_by: null,
    return_token: null,
    return_prompt_sent_at: null,
    ...overrides,
  };
}

function line(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    order_request_id: ORDER_ID,
    item_id: `item-${id}`,
    quantity_requested: 1,
    quantity_fulfilled: 1,
    quantity_picked: 1,
    returned_quantity: 0,
    unit_cost_at_request: 0,
    notes: null,
    item: {
      id: `item-${id}`,
      name,
      sku: `SKU-${id}`,
      quantity_on_hand: 18,
      charter_name: null,
      charter_code: null,
    },
    ...over,
  };
}

/** SO-000085 as prod holds it: three lines 1/1; only the S line has returned_quantity 1. */
function so85Lines(sReturned = 1) {
  return [
    line(S_LINE, "Women's Polo S", { returned_quantity: sReturned }),
    line(M_LINE, "Women's Polo M"),
    line(XL_LINE, "Men's Polo XL"),
  ];
}

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    request: requestFixture(overrides.request as Record<string, unknown>),
    lines: so85Lines(0),
    reservations: [],
    warehouseName: 'DC4',
    requesterDisplay: 'Lillian',
    requesterName: 'Lillian',
    requesterEmail: null,
    assignedPickerName: null,
    pickSlipStale: false,
    ...overrides,
  };
}

/** The closed RMA exactly as loadOrderReturns hands it back for SO-000085. */
function closedRma(over: Record<string, unknown> = {}) {
  return {
    id: RMA_ID,
    returnNumber: RMA_NUMBER,
    status: 'closed',
    reasonCode: 'other',
    notes: RMA_NOTES,
    createdAt: '2026-08-17T17:10:00Z',
    closedAt: '2026-08-17T17:12:00Z',
    lines: [
      { orderRequestLineId: S_LINE, itemId: `item-${S_LINE}`, quantity: 1, disposition: 'restock', applied: true },
    ],
    ...over,
  };
}

function setViewer(perms: string[], role: 'staff' | 'manager' = 'staff') {
  ctxHolder.current = { role, permissions: new Set<string>(['orders:read', ...perms]) };
}

async function renderPage() {
  return render(await OrderDetailPage({ params: Promise.resolve({ id: ORDER_ID }) }));
}

/** The Fulfilled cell of the row whose Item cell names `itemName`. */
function fulfilledCell(container: HTMLElement, itemName: string): HTMLTableCellElement {
  const rows = Array.from(container.querySelectorAll('tbody tr'));
  const row = rows.find((r) => r.textContent?.includes(itemName));
  if (!row) throw new Error(`no row for ${itemName}`);
  // Columns: Item, Requested, Fulfilled, Owed, On hand (no actions column: viewer cannot edit a completed order).
  return row.querySelectorAll('td')[2] as HTMLTableCellElement;
}
function owedCell(container: HTMLElement, itemName: string): HTMLTableCellElement {
  const rows = Array.from(container.querySelectorAll('tbody tr'));
  const row = rows.find((r) => r.textContent?.includes(itemName));
  if (!row) throw new Error(`no row for ${itemName}`);
  return row.querySelectorAll('td')[3] as HTMLTableCellElement;
}
/** The shipped number = the cell's first text node, before any returned sub-line. */
function shippedFigure(cell: HTMLTableCellElement): string {
  return (cell.childNodes[0]?.textContent ?? '').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  orderGet.mockResolvedValue(detailFixture());
  attachmentsList.mockResolvedValue([]);
  returnableLinesForOrder.mockResolvedValue([]);
  loadOrderReturnsMock.mockResolvedValue([]);
  checkModuleAccessMock.mockResolvedValue({ enabled: false, canManage: false });
  setViewer([]);
});

describe('(c) golden — an order with no returns renders exactly as before', () => {
  it('completed, three lines, nothing returned: no strip, no sub-line, no panel, the word "returned" appears nowhere', async () => {
    const { container } = await renderPage();
    expect(container.querySelector('[data-testid="order-return-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="line-returned"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-returns"]')).toBeNull();
    expect(container.textContent).not.toMatch(/returned/i);
    expect(container.textContent).not.toMatch(/Returns \(/);
    // The Fulfilled cells hold ONLY the number.
    for (const name of ["Women's Polo S", "Women's Polo M", "Men's Polo XL"]) {
      expect(fulfilledCell(container, name).textContent).toBe('1');
    }
    // The read was made (completed order) — it just found nothing.
    expect(loadOrderReturnsMock).toHaveBeenCalledTimes(1);
    expect(loadOrderReturnsMock).toHaveBeenCalledWith(SUPABASE_CLIENT, 'org-1', ORDER_ID);
  });

  it('the no-returns render is byte-identical whether the returns read returned [] or THREW (degrade, never break the page)', async () => {
    const { container: ok } = await renderPage();
    const okHtml = ok.innerHTML;
    loadOrderReturnsMock.mockRejectedValueOnce(new Error('boom'));
    const { container: failed } = await renderPage();
    expect(failed.innerHTML).toBe(okHtml);
  });

  it.each(['approved', 'in_transit', 'backordered', 'cancelled', 'denied'] as const)(
    'a %s order never pays the returns read (nothing but a completed order can carry one)',
    async (status) => {
      orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status }) }));
      await renderPage();
      expect(loadOrderReturnsMock).not.toHaveBeenCalled();
    },
  );

  it('the legacy "delivered" status IS returnable and pays the read', async () => {
    orderGet.mockResolvedValue(detailFixture({ request: requestFixture({ status: 'delivered' }) }));
    await renderPage();
    expect(loadOrderReturnsMock).toHaveBeenCalledTimes(1);
  });
});

describe('(a) a line with an applied return shows the returned qty and the RMA; the panel shows the return with its notes', () => {
  beforeEach(() => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(1) }));
    loadOrderReturnsMock.mockResolvedValue([closedRma()]);
  });

  it('S line: shipped "1" stays, "1 returned" appears beneath it, hover/aria names the RMA; M and XL untouched', async () => {
    const { container } = await renderPage();
    const s = fulfilledCell(container, "Women's Polo S");
    expect(shippedFigure(s)).toBe('1');
    const sub = s.querySelector('[data-testid="line-returned"]') as HTMLElement;
    expect(sub).not.toBeNull();
    expect(sub.textContent).toBe('1 returned');
    expect(sub.getAttribute('title')).toBe(`1 returned on ${RMA_NUMBER}`);
    expect(sub.getAttribute('aria-label')).toBe(`1 returned on ${RMA_NUMBER}`);
    expect(fulfilledCell(container, "Women's Polo M").textContent).toBe('1');
    expect(fulfilledCell(container, "Men's Polo XL").textContent).toBe('1');
    expect(container.querySelectorAll('[data-testid="line-returned"]')).toHaveLength(1);
  });

  it('summary strip: "3 provided · 1 returned · net 2 with requester", with the exchange caveat on hover/aria and a link to the panel', async () => {
    const { container } = await renderPage();
    const strip = container.querySelector('[data-testid="order-return-summary"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain('3 provided · 1 returned · net 2 with requester');
    const figure = strip.querySelector('[title]') as HTMLElement;
    expect(figure.getAttribute('title')).toContain('not counted');
    expect(figure.getAttribute('title')).toContain('return notes');
    expect(strip.querySelector('a[href="#order-returns"]')?.textContent).toBe('See returns');
  });

  it('panel: heading, RMA number, Closed badge, reason, the applied restock line naming the item, and the NOTES verbatim', async () => {
    const { container } = await renderPage();
    const panel = container.querySelector('[data-testid="order-returns"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.id).toBe('order-returns');
    expect(panel.querySelector('h2')?.textContent).toBe('Returns (1)');
    const row = panel.querySelector('[data-testid="order-return"]') as HTMLElement;
    expect(row.textContent).toContain(RMA_NUMBER);
    expect(row.textContent).toContain('Closed');
    expect(row.textContent).toContain('Other');
    expect(row.textContent).toContain("1 × Women's Polo S — Restock · applied");
    expect(row.querySelector('[data-testid="order-return-notes"]')?.textContent).toBe(RMA_NOTES);
  });

  it('MUTATION: the same page with returned_quantity back at 0 and no returns has none of it', async () => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(0) }));
    loadOrderReturnsMock.mockResolvedValue([]);
    const { container } = await renderPage();
    expect(container.querySelector('[data-testid="line-returned"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-return-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-returns"]')).toBeNull();
  });

  it('a returned figure with the returns read FAILED still renders from returned_quantity — the RMA name simply is not known', async () => {
    loadOrderReturnsMock.mockRejectedValueOnce(new Error('boom'));
    const { container } = await renderPage();
    const sub = container.querySelector('[data-testid="line-returned"]') as HTMLElement;
    expect(sub.textContent).toBe('1 returned');
    expect(sub.getAttribute('title')).toBe('1 returned');
    expect(container.querySelector('[data-testid="order-returns"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-return-summary"]')?.textContent).toContain(
      '3 provided · 1 returned · net 2 with requester',
    );
  });
});

describe('(b) fulfilled is NEVER rewritten by a return', () => {
  it('returned_quantity 0 -> 1 on the S line: shipped figure stays "1", Owed stays "0", Total qty stays 3', async () => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(0) }));
    const before = await renderPage();
    expect(shippedFigure(fulfilledCell(before.container, "Women's Polo S"))).toBe('1');
    expect(owedCell(before.container, "Women's Polo S").textContent).toBe('0');
    expect(before.container.textContent).toContain('Total qty 3');

    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(1) }));
    loadOrderReturnsMock.mockResolvedValue([closedRma()]);
    const after = await renderPage();
    expect(shippedFigure(fulfilledCell(after.container, "Women's Polo S"))).toBe('1');
    // A return does not re-owe a unit that shipped and came back.
    expect(owedCell(after.container, "Women's Polo S").textContent).toBe('0');
    expect(after.container.textContent).toContain('Total qty 3');
    // And no partial-fulfilment banner appears — nothing is owed.
    expect(after.container.textContent).not.toContain('Partially fulfilled');
  });
});

describe('(d) an unapplied return counts for nothing in the returned figure — the rule is the applied latch', () => {
  it.each(['requested', 'approved', 'received'] as const)(
    'in-flight %s RMA (applied=false, returned_quantity 0): no "returned" on the line or strip; the panel lists it as pending',
    async (status) => {
      orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(0) }));
      loadOrderReturnsMock.mockResolvedValue([
        closedRma({
          status,
          closedAt: null,
          lines: [{ orderRequestLineId: S_LINE, itemId: `item-${S_LINE}`, quantity: 1, disposition: 'restock', applied: false }],
        }),
      ]);
      const { container } = await renderPage();
      expect(container.querySelector('[data-testid="line-returned"]')).toBeNull();
      expect(container.querySelector('[data-testid="order-return-summary"]')).toBeNull();
      const panel = container.querySelector('[data-testid="order-returns"]') as HTMLElement;
      expect(panel).not.toBeNull();
      expect(panel.textContent).toContain(mobile.RETURN_STATUS_LABELS[status]);
      expect(panel.textContent).toContain("1 × Women's Polo S — Restock · pending");
    },
  );

  it.each(['denied', 'cancelled'] as const)(
    '%s RMA (applied=false): nothing returned anywhere; the panel still shows the history with its status',
    async (status) => {
      orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(0) }));
      loadOrderReturnsMock.mockResolvedValue([
        closedRma({
          status,
          closedAt: null,
          lines: [{ orderRequestLineId: S_LINE, itemId: `item-${S_LINE}`, quantity: 1, disposition: 'scrap', applied: false }],
        }),
      ]);
      const { container } = await renderPage();
      expect(container.querySelector('[data-testid="line-returned"]')).toBeNull();
      expect(container.querySelector('[data-testid="order-return-summary"]')).toBeNull();
      const panel = container.querySelector('[data-testid="order-returns"]') as HTMLElement;
      expect(panel.textContent).toContain(mobile.RETURN_STATUS_LABELS[status]);
      expect(panel.textContent).toContain("1 × Women's Polo S — Scrap · pending");
    },
  );

  it('MUTATION: the same RMA once APPLIED (closed, applied=true, returned_quantity 1) IS counted', async () => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(1) }));
    loadOrderReturnsMock.mockResolvedValue([closedRma()]);
    const { container } = await renderPage();
    expect(container.querySelector('[data-testid="line-returned"]')?.textContent).toBe('1 returned');
    expect(container.querySelector('[data-testid="order-return-summary"]')).not.toBeNull();
  });

  it('a pending RMA on a line that ALSO has an applied one: the figure is the applied count; the hover names both', async () => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(1) }));
    loadOrderReturnsMock.mockResolvedValue([
      closedRma(),
      closedRma({
        id: 'r2',
        returnNumber: 'RMA-2',
        status: 'requested',
        closedAt: null,
        notes: null,
        lines: [{ orderRequestLineId: S_LINE, itemId: `item-${S_LINE}`, quantity: 1, disposition: 'restock', applied: false }],
      }),
    ]);
    const { container } = await renderPage();
    const sub = container.querySelector('[data-testid="line-returned"]') as HTMLElement;
    expect(sub.textContent).toBe('1 returned');
    expect(sub.getAttribute('title')).toBe(`1 returned on ${RMA_NUMBER}; 1 pending on RMA-2`);
    expect(container.querySelector('[data-testid="order-returns"] h2')?.textContent).toBe('Returns (2)');
  });
});

describe('the RMA number links to the returns page only when that page would open for this viewer', () => {
  beforeEach(() => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(1) }));
    loadOrderReturnsMock.mockResolvedValue([closedRma()]);
  });

  it('no returns permission: plain text, no link — but the panel and notes still render', async () => {
    setViewer([]);
    const { container } = await renderPage();
    const panel = container.querySelector('[data-testid="order-returns"]') as HTMLElement;
    expect(panel.querySelector(`a[href="/dashboard/returns/${RMA_ID}"]`)).toBeNull();
    expect(panel.textContent).toContain(RMA_NUMBER);
    expect(panel.textContent).toContain(RMA_NOTES);
    // No module check paid for a viewer who gets no link.
    expect(checkModuleAccessMock).not.toHaveBeenCalledWith('returns');
  });

  it('returns:read + module ON: the number is a link to /dashboard/returns/[id]', async () => {
    setViewer(['returns:read']);
    checkModuleAccessMock.mockImplementation(async (m) => ({ enabled: m === 'returns', canManage: false }));
    const { container } = await renderPage();
    const a = container.querySelector(`a[href="/dashboard/returns/${RMA_ID}"]`);
    expect(a?.textContent).toBe(RMA_NUMBER);
  });

  it('returns:read + module OFF: no link (that page redirects when the module is off); panel still renders', async () => {
    setViewer(['returns:read']);
    checkModuleAccessMock.mockResolvedValue({ enabled: false, canManage: false });
    const { container } = await renderPage();
    expect(container.querySelector(`a[href="/dashboard/returns/${RMA_ID}"]`)).toBeNull();
    expect(container.querySelector('[data-testid="order-returns"]')).not.toBeNull();
  });

  it('returns:manage + module ON: linked as well', async () => {
    setViewer(['returns:manage'], 'manager');
    checkModuleAccessMock.mockImplementation(async (m) => ({ enabled: m === 'returns', canManage: false }));
    const { container } = await renderPage();
    expect(container.querySelector(`a[href="/dashboard/returns/${RMA_ID}"]`)).not.toBeNull();
  });
});

describe('(e) the phone says what the web page renders — pinned against the MOBILE module', () => {
  const MOBILE_LINES = so85Lines(1).map((l) => ({
    orderRequestLineId: l.id,
    name: l.item.name,
    requested: l.quantity_requested,
    fulfilled: l.quantity_fulfilled,
    returned: l.returned_quantity,
  }));

  beforeEach(() => {
    orderGet.mockResolvedValue(detailFixture({ lines: so85Lines(1) }));
    loadOrderReturnsMock.mockResolvedValue([closedRma()]);
  });

  it('summary strip text === mobile.formatOrderReturnSummary(mobile.orderReturnSummary(lines))', async () => {
    const { container } = await renderPage();
    const web = container.querySelector('[data-testid="order-return-summary"] [title]')?.childNodes[0]?.textContent;
    const phone = mobile.formatOrderReturnSummary(mobile.orderReturnSummary(MOBILE_LINES)!);
    expect(web).toBe(phone);
    expect(phone).toBe('3 provided · 1 returned · net 2 with requester');
    // and the caveat both surfaces print is the same constant
    expect(container.querySelector('[data-testid="order-return-summary"] [title]')?.getAttribute('title')).toBe(
      mobile.ORDER_RETURN_SUMMARY_NOTE,
    );
  });

  it('per line: web\'s "N returned" sub-cell is exactly the fragment the phone appends after "fulfilled"', async () => {
    const { container } = await renderPage();
    for (const l of MOBILE_LINES) {
      const phone = mobile.describeLineFulfilment(l);
      const cell = fulfilledCell(container, l.name);
      const web = cell.querySelector('[data-testid="line-returned"]')?.textContent ?? null;
      if (l.returned > 0) {
        expect(phone).toBe(`fulfilled · ${web}`);
      } else {
        expect(web).toBeNull();
        expect(phone).toBe('fulfilled');
      }
    }
  });

  it('panel row + status + reason === the phone\'s describeReturnLine / returnStatusLabel / returnReasonLabel', async () => {
    const { container } = await renderPage();
    const row = container.querySelector('[data-testid="order-return"]') as HTMLElement;
    const rma = closedRma();
    const rl = rma.lines[0]!;
    const phoneLine = mobile.describeReturnLine({
      quantity: rl.quantity,
      itemName: mobile.returnLineItemName(rl, MOBILE_LINES),
      disposition: rl.disposition,
      applied: rl.applied,
    });
    expect(row.textContent).toContain(phoneLine);
    expect(row.textContent).toContain(mobile.returnStatusLabel('closed'));
    expect(row.textContent).toContain(mobile.returnReasonLabel('other'));
    expect(row.textContent).toContain(mobile.returnHandle(rma));
  });

  it('the phone reads the SAME columns web reads (select strings agree column for column)', () => {
    const webSource = readFileSync(
      path.resolve(__dirname, '../../../../../server/services/returns.ts'),
      'utf8',
    );
    const m = webSource.match(/export async function loadOrderReturns[\s\S]*?\.select\(\s*`([\s\S]*?)`/);
    expect(m, 'loadOrderReturns select not found').not.toBeNull();
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(norm(m![1]!)).toBe(norm(mobile.ORDER_RETURNS_SELECT));
  });

  it('the mobile screen renders THROUGH the module (no hand-rolled copy of the sub-line or the summary)', () => {
    const screen = readFileSync(
      path.resolve(__dirname, '../../../../../../../mobile/app/order/[id].tsx'),
      'utf8',
    );
    for (const call of [
      'describeLineFulfilment(',
      'formatOrderReturnSummary(',
      'orderReturnSummary(',
      'describeReturnLine(',
      'returnStatusLabel(',
      'describeReturnMeta(',
      'returnHandle(',
      'parseOrderReturns(',
      'shouldLoadOrderReturns(',
      'shouldShowReturnsSection(',
      '.select(ORDER_RETURNS_SELECT)',
      'ORDER_RETURN_SUMMARY_NOTE',
    ]) {
      expect(screen, `mobile screen must call ${call}`).toContain(call);
    }
    // The pre-feature hand-rolled ternary is gone.
    expect(screen).not.toContain('{l.fulfilled} provided · {l.requested - l.fulfilled} owed');
    // And no literal "returned" WORDING is typed into the screen itself —
    // only the field name (`l.returned`, `returned: …`) may appear once
    // comments are stripped.
    const code = screen
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/(?<![.\w])returned(?![\w])(?!\s*[:,}])/);
  });
});
