import { render, within } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETED_REQUESTER_LABEL, DELETED_USER_LABEL } from '@stockpilot/core';

import { OrderStatusConfigProvider } from '@/components/orders/order-status-config-provider';
import { summaryRequesterLabel } from '@/components/orders/requester-label';
import type { OrderRequestSummary } from '@/server/services/order-requests';

/**
 * The Orders list in the redesign (P3.5, DESIGN-SPEC 7.6, CONFLICTS R1-R6):
 * the M5 look over the same page. Pinned here: the nine status tabs drawn as
 * the stage strip with the same links, default and "Status" landmark, and no
 * figure the app does not have (no count read); the hidden "Waiting for
 * signature" filter; both variants ("Order requests" / "My requests"); every
 * column; the org's own status words; Newer / Older; and the empty and failed
 * states with their words. The server chain itself is pinned in
 * page.chain.test.tsx.
 */

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  requireOrgContext: vi.fn(),
  withContext: vi.fn(),
  list: vi.fn(),
  myRequests: vi.fn(),
  forCurrentUser: vi.fn(),
  canManageOrderItems: vi.fn(),
}));

// Every prop but next/link's own reaches the anchor (aria-current, classes).
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: unknown;
    scroll?: unknown;
    replace?: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: () => null,
}));
vi.mock('@/components/orders/orders-export-menu', () => ({
  OrdersExportMenu: ({ tab }: { tab: string }) => (
    <div data-testid="orders-export-menu" data-tab={tab} />
  ),
}));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: ({ tour }: { tour: { id: string } }) => (
    <span data-testid="page-tour" data-tour={tour.id} />
  ),
}));
vi.mock('@/components/perf/perf-useful', () => ({
  PerfUseful: () => <span data-testid="perf-useful" />,
}));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: m.requireOrgContext }));
vi.mock('@/server/services/context', () => ({ withContext: m.withContext }));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: m.forCurrentUser },
}));
vi.mock('@/server/services/order-catalog-visibility', () => ({
  canManageOrderItems: m.canManageOrderItems,
}));

import OrdersPage from './page';

const TABS: Array<[string, string]> = [
  ['all_active', 'All active'],
  ['needs_approval', 'Needs approval'],
  ['picking', 'Picking'],
  ['packing', 'Packing'],
  ['staged', 'Staged'],
  ['in_transit', 'In transit'],
  ['backordered', 'Backordered'],
  ['completed', 'Completed'],
  ['denied_cancelled', 'Denied/Cancelled'],
];

const COLUMNS = [
  'Order #',
  'Requester',
  'Warehouse',
  'Lines',
  'Total qty',
  'Status',
  'Type',
  'Picker',
  'Driver',
  'Requested',
  'Last update',
];

let seq = 0;
function row(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `o${seq}`,
    orderNumber: 100 + seq,
    status: 'approved',
    warehouseId: 'w1',
    warehouseName: 'North DC',
    requesterUserId: 'u-9',
    requesterEmail: 'pat@example.com',
    requesterName: 'Pat Lee',
    requesterOrgLabel: null,
    requesterDeleted: false,
    source: 'internal',
    lineCount: 2,
    totalQuantity: 1200,
    notes: null,
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    approvedAt: null,
    deliveredAt: null,
    fulfillmentType: 'pickup',
    assignedPickerId: null,
    assignedPickerName: null,
    assignedDeliveryUserId: null,
    assignedDeliveryUserName: null,
    replacementForReturnId: null,
    exchange: null,
    ...over,
  };
}

function setViewer(approver: boolean) {
  m.requireOrgContext.mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: approver ? 'manager' : 'staff',
    permissions: new Set(approver ? ['orders:request', 'orders:approve'] : ['orders:request']),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  m.checkModuleAccess.mockResolvedValue({ enabled: true, canManage: true });
  m.withContext.mockResolvedValue({ organizationId: 'org-1' });
  // The service the page gets: exactly the two reads it may make. Any other
  // call (a per-stage count, for one) would throw and show the failed state.
  m.forCurrentUser.mockResolvedValue({ list: m.list, myRequests: m.myRequests });
  m.list.mockResolvedValue([]);
  m.myRequests.mockResolvedValue([]);
  m.canManageOrderItems.mockReturnValue(false);
  setViewer(true);
});

async function renderPage(
  params: Record<string, string> = {},
  wrap?: (n: React.ReactNode) => React.ReactNode,
) {
  const element = await OrdersPage({ searchParams: Promise.resolve(params) });
  return render(wrap ? wrap(element) : element);
}

describe('Orders page: the status tabs as the stage strip', () => {
  it('draws the nine tabs in order as links in the "Status" landmark, with the same URLs', async () => {
    const view = await renderPage();
    const strip = view.getByRole('navigation', { name: 'Status' });
    const links = within(strip).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(TABS.map(([, label]) => label));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      TABS.map(([key]) => `/dashboard/orders?status=${key}`),
    );
  });

  it('opens on Needs approval for an approver, the one stage marked current', async () => {
    const view = await renderPage();
    const strip = view.getByRole('navigation', { name: 'Status' });
    const current = within(strip)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Needs approval']);
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_approval', limit: 51, offset: 0 }),
    );
  });

  it('an unknown ?status= falls back to Needs approval, as before', async () => {
    await renderPage({ status: 'pending_confirmation' });
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_approval' }));
  });

  it.each(TABS)('?status=%s marks "%s" current and lists its statuses', async (key, label) => {
    const view = await renderPage({ status: key });
    const strip = view.getByRole('navigation', { name: 'Status' });
    expect(within(strip).getByRole('link', { name: label })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(m.list).toHaveBeenCalledTimes(1);
  });

  it('prints no figure in any stage: the tiles carry only their words, and the page makes one read', async () => {
    m.list.mockResolvedValue([row(), row(), row()]);
    const view = await renderPage({ status: 'all_active' });
    const strip = view.getByRole('navigation', { name: 'Status' });
    for (const link of within(strip).getAllByRole('link')) {
      expect(link.textContent).not.toMatch(/\d/);
    }
    // One list read for the rows; no count read per stage (CONFLICTS O2).
    expect(m.forCurrentUser).toHaveBeenCalledTimes(1);
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(m.myRequests).not.toHaveBeenCalled();
  });

  it('keeps the tab words as the fixed vocabulary when the org renames its statuses', async () => {
    m.list.mockResolvedValue([row({ status: 'pending_approval' })]);
    const view = await renderPage({}, (page) => (
      <OrderStatusConfigProvider config={{ pending_approval: { label: 'Awaiting sign-off' } }}>
        {page}
      </OrderStatusConfigProvider>
    ));
    const strip = view.getByRole('navigation', { name: 'Status' });
    expect(within(strip).getByRole('link', { name: 'Needs approval' })).toBeInTheDocument();
    expect(within(strip).queryByText('Awaiting sign-off')).toBeNull();
  });
});

describe('Orders page: the Waiting for signature filter', () => {
  it('is not a stage: no tile is current, the chip says what the list shows, and the way back is kept', async () => {
    const view = await renderPage({ status: 'awaiting_signature' });
    const strip = view.getByRole('navigation', { name: 'Status' });
    expect(within(strip).getAllByRole('link')).toHaveLength(9);
    expect(within(strip).queryByText('Waiting for signature')).toBeNull();
    expect(
      within(strip)
        .getAllByRole('link')
        .some((a) => a.hasAttribute('aria-current')),
    ).toBe(false);
    expect(view.getByText('Waiting for signature')).toBeInTheDocument();
    expect(view.getByRole('link', { name: 'Show all active orders' })).toHaveAttribute(
      'href',
      '/dashboard/orders?status=all_active',
    );
    // The export carries the filter, as the file must match the screen.
    expect(view.getByTestId('orders-export-menu')).toHaveAttribute(
      'data-tab',
      'awaiting_signature',
    );
  });
});

describe('Orders page: the two variants', () => {
  it('an approver gets "Order requests", its sentence, the Tour, Export for the open tab and + Place order', async () => {
    const view = await renderPage({ status: 'picking' });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Order requests');
    expect(
      view.getByText(
        'Review incoming requests and move them through approval, packaging, and delivery.',
      ),
    ).toBeInTheDocument();
    expect(view.getByTestId('page-tour')).toHaveAttribute('data-tour', 'orders-page');
    expect(view.getByTestId('orders-export-menu')).toHaveAttribute('data-tab', 'picking');
    expect(view.getByRole('link', { name: '+ Place order' })).toHaveAttribute(
      'href',
      '/dashboard/orders/new',
    );
  });

  it('a requester gets "My requests": their own newest orders, no tabs, no export, no pager', async () => {
    setViewer(false);
    m.myRequests.mockResolvedValue([row({ status: 'pending_approval' })]);
    const view = await renderPage({ status: 'picking', page: '3' });
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('My requests');
    expect(view.getByText('Track the orders you have placed.')).toBeInTheDocument();
    expect(m.myRequests).toHaveBeenCalledTimes(1);
    expect(m.list).not.toHaveBeenCalled();
    expect(view.queryByRole('navigation', { name: 'Status' })).toBeNull();
    expect(view.queryByTestId('orders-export-menu')).toBeNull();
    expect(view.queryByText(/← Newer|Older →|^Page \d/)).toBeNull();
    expect(view.getByTestId('page-tour')).toBeInTheDocument();
    expect(view.getByRole('link', { name: '+ Place order' })).toHaveAttribute(
      'href',
      '/dashboard/orders/new',
    );
    // The same table.
    expect(view.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(COLUMNS);
  });

  it('the Place order link comes before any other link to the storefront (the tour targets the first)', async () => {
    setViewer(false);
    const { container } = await renderPage();
    const toNew = container.querySelectorAll('a[href="/dashboard/orders/new"]');
    expect(toNew[0]).toHaveTextContent('+ Place order');
  });
});

describe('Orders page: the table keeps every column', () => {
  it('has the eleven columns in order', async () => {
    m.list.mockResolvedValue([row()]);
    const view = await renderPage();
    expect(view.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(COLUMNS);
  });

  it('prints each order’s number, requester, warehouse, lines, quantity, status, type, people and times', async () => {
    m.list.mockResolvedValue([
      row({
        id: 'a1',
        orderNumber: 104,
        status: 'in_transit',
        fulfillmentType: 'delivery',
        requesterName: 'Tomas Reyes',
        requesterOrgLabel: 'Ridge PTA',
        source: 'public_link',
        assignedPickerName: 'Hugo Stanton',
        assignedDeliveryUserName: 'Leo Fairbanks',
        warehouseName: 'South DC',
        lineCount: 3,
        totalQuantity: 1250,
      }),
    ]);
    const view = await renderPage({ status: 'in_transit' });
    const [, bodyRow] = view.getAllByRole('row');
    const cells = within(bodyRow!).getAllByRole('cell');
    expect(cells).toHaveLength(11);

    expect(within(cells[0]!).getByRole('link', { name: 'SO-000104' })).toHaveAttribute(
      'href',
      '/dashboard/orders/a1',
    );
    expect(
      within(cells[1]!).getByRole('link', { name: 'Tomas Reyes · Ridge PTA' }),
    ).toHaveAttribute('href', '/dashboard/orders/a1');
    expect(within(cells[1]!).getByText('Public')).toBeInTheDocument();
    expect(cells[2]).toHaveTextContent('South DC');
    expect(cells[3]).toHaveTextContent('3');
    expect(cells[4]).toHaveTextContent('1,250');
    expect(within(cells[5]!).getByText('In transit')).toBeInTheDocument();
    expect(cells[6]).toHaveTextContent('Delivery');
    expect(cells[7]).toHaveTextContent('Hugo Stanton');
    expect(cells[8]).toHaveTextContent('Leo Fairbanks');
    expect(cells[9]).toHaveTextContent('2 hours ago');
    expect(cells[10]).toHaveTextContent('5 minutes ago');
  });

  it('draws the requester as the name over the organisation, while the link keeps the label as its words and name', async () => {
    const rows = [
      row({ requesterName: 'Tomas Reyes', requesterOrgLabel: 'Ridge PTA' }),
      row({ requesterName: 'Pat Lee', requesterOrgLabel: null }),
      row({
        requesterName: null,
        requesterOrgLabel: 'Ridge PTA',
        requesterEmail: 'sam@example.com',
      }),
      row({ requesterName: null, requesterEmail: null, requesterUserId: 'u-7' }),
      row({
        requesterName: null,
        requesterEmail: null,
        requesterUserId: null,
        requesterDeleted: true,
      }),
      row({
        requesterName: null,
        requesterEmail: null,
        requesterUserId: null,
        source: 'public_link',
      }),
    ];
    m.list.mockResolvedValue(rows);
    const view = await renderPage({ status: 'all_active' });
    const bodyRows = view.getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(rows.length);

    const links = bodyRows.map((tr) =>
      within(within(tr).getAllByRole('cell')[1]!).getByRole('link'),
    );
    // The words of every link are summaryRequesterLabel's, branch by branch.
    expect(links.map((a) => a.textContent)).toEqual([
      'Tomas Reyes · Ridge PTA',
      'Pat Lee',
      'sam@example.com',
      'Team member',
      DELETED_REQUESTER_LABEL,
      'External requester',
    ]);
    rows.forEach((r, i) => {
      expect(links[i]!.textContent).toBe(
        summaryRequesterLabel(r as unknown as OrderRequestSummary),
      );
    });
    expect(links[0]).toHaveAccessibleName('Tomas Reyes · Ridge PTA');

    // Name and organisation are two lines; only the separator is hidden, and
    // only from sight.
    const [name, separator, org] = Array.from(links[0]!.children);
    expect(name).toHaveTextContent(/^Tomas Reyes$/);
    expect(separator).toHaveClass('sr-only');
    expect(separator!.textContent).toBe(' · ');
    expect(org).toHaveTextContent(/^Ridge PTA$/);
    // Every other label is the one line it was.
    for (const a of links.slice(1)) expect(a.children).toHaveLength(0);
    // The Public badge sits beside the requester, outside the link.
    const publicCell = within(bodyRows[5]!).getAllByRole('cell')[1]!;
    expect(within(publicCell).getByText('Public').closest('a')).toBeNull();
  });

  // FX3 (DESIGN-SPEC 8 "1440: everything fits", 6.9 tables; CONFLICTS R5
  // keeps every column): on All active the table needed 1320 px of the
  // 1146 px card at 1440, so Requested was cut and Last update hidden behind
  // a sideways scroll. Picker and Driver names now wrap, the requester's
  // floor is 8rem (was 11rem), and an exchange's state sits beside its
  // Exchange pill as text that wraps, instead of inside a pill that held
  // "Exchange · Waiting for return" on one 183 px line.
  it('lets the people, the requester and an exchange state wrap, so the table fits 1440', async () => {
    m.list.mockResolvedValue([
      row({
        status: 'in_transit',
        fulfillmentType: 'delivery',
        assignedPickerName: 'Hugo Stanton',
        assignedDeliveryUserName: 'Leo Fairbanks',
        replacementForReturnId: 'rma-1',
        exchange: { returnId: 'rma-1', returnNumber: 'RMA-1', state: 'Waiting for return' },
      }),
    ]);
    const view = await renderPage({ status: 'all_active' });
    const cells = within(view.getAllByRole('row')[1]!).getAllByRole('cell');
    expect(cells[7]).toHaveTextContent('Hugo Stanton');
    expect(cells[7]).not.toHaveClass('whitespace-nowrap');
    expect(cells[8]).toHaveTextContent('Leo Fairbanks');
    expect(cells[8]).not.toHaveClass('whitespace-nowrap');
    const requester = cells[1]!.firstElementChild!;
    expect(requester).toHaveClass('min-w-32');
    expect(requester).not.toHaveClass('min-w-44');
    // The words read as before ("Exchange · Waiting for return"), but the
    // pill holds only "Exchange" and the state beside it may wrap.
    const chip = within(cells[5]!).getByTestId('order-exchange-chip');
    expect(chip.textContent).toBe('Exchange · Waiting for return');
    const pill = within(chip).getByText('Exchange');
    expect(pill.textContent).toBe('Exchange');
    const state = within(chip).getByText(/Waiting for return/);
    expect(pill.contains(state)).toBe(false);
    expect(state).toHaveClass('text-muted-foreground', 'text-[12px]');
    expect(state).not.toHaveClass('whitespace-nowrap');
  });

  // Review of FX3: in the Status column the state wraps under its Exchange
  // pill at every width from 1024 to 1600, and its line began with the
  // separator ("· Waiting for return"), which read as a list bullet under the
  // pill. The separator is now for the text and screen readers only: the chip
  // still reads "Exchange · Waiting for return", and the line on screen reads
  // "Waiting for return".
  it("keeps the separator before an exchange's state for screen readers only", async () => {
    m.list.mockResolvedValue([
      row({
        replacementForReturnId: 'rma-1',
        exchange: { returnId: 'rma-1', returnNumber: 'RMA-1', state: 'Waiting for return' },
      }),
    ]);
    const view = await renderPage({ status: 'all_active' });
    const chip = view.getByTestId('order-exchange-chip');
    expect(chip.textContent).toBe('Exchange · Waiting for return');
    // The state's own text (what is drawn) is the words alone...
    const state = within(chip).getByText('Waiting for return');
    expect(state).toHaveClass('text-muted-foreground', 'text-[12px]');
    // ...and the separator before them sits in an sr-only span.
    const separator = state.querySelector('.sr-only');
    expect(separator?.textContent).toBe(' · ');
    expect(state.firstChild).toBe(separator);
  });

  it('shows the driver only on a delivery, a dash where nobody is assigned, and no Public badge on an internal order', async () => {
    m.list.mockResolvedValue([
      row({
        fulfillmentType: 'pickup',
        assignedPickerName: null,
        assignedDeliveryUserName: 'Should Not Show',
        orderNumber: 0,
      }),
    ]);
    const view = await renderPage({ status: 'all_active' });
    const cells = within(view.getAllByRole('row')[1]!).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('—');
    expect(within(cells[1]!).queryByText('Public')).toBeNull();
    expect(cells[6]).toHaveTextContent('Pickup');
    expect(cells[7]).toHaveTextContent('—');
    expect(cells[8]).toHaveTextContent('—');
    expect(view.queryByText('Should Not Show')).toBeNull();
  });

  // B23: 0393 clears the driver of an order whose driver deleted their
  // account. A delivery that went out names nobody afterwards, and the cell
  // used to read "—" as if nobody had ever been put on it.
  it('says "Deleted user" for the driver of a delivery that went out and names no driver', async () => {
    m.list.mockResolvedValue([
      row({
        status: 'in_transit',
        fulfillmentType: 'delivery',
        inTransitAt: '2026-10-20T15:04:05.000Z',
        assignedDeliveryUserId: null,
        assignedDeliveryUserName: null,
      }),
      row({
        status: 'staged_for_delivery',
        fulfillmentType: 'delivery',
        inTransitAt: null,
        assignedDeliveryUserId: null,
        assignedDeliveryUserName: null,
      }),
    ]);
    const view = await renderPage({ status: 'all_active' });
    const [gone, unassigned] = view
      .getAllByRole('row')
      .slice(1)
      .map((tr) => within(tr).getAllByRole('cell')[8]!);
    expect(gone).toHaveTextContent(DELETED_USER_LABEL);
    expect(unassigned).toHaveTextContent('—');
    expect(unassigned).not.toHaveTextContent(DELETED_USER_LABEL);
  });

  it('a completed pickup reads Handed over, and the org’s own status words and colours reach the rows', async () => {
    m.list.mockResolvedValue([
      row({ status: 'completed', fulfillmentType: 'pickup' }),
      row({ status: 'picking_in_progress' }),
      row({ status: 'cancelled' }),
    ]);
    const plain = await renderPage({ status: 'all_active' });
    expect(plain.getByText('Handed over')).toBeInTheDocument();
    plain.unmount();

    const custom = await renderPage({ status: 'all_active' }, (page) => (
      <OrderStatusConfigProvider
        config={{
          picking_in_progress: { label: 'On the floor', color: 'default' },
          cancelled: { label: 'Withdrawn' },
        }}
      >
        {page}
      </OrderStatusConfigProvider>
    ));
    expect(custom.getByText('On the floor')).toBeInTheDocument();
    expect(custom.getByText('Withdrawn')).toBeInTheDocument();
    expect(custom.queryByText('Picking', { selector: 'td *' })).toBeNull();
  });

  it('links rows, never turns a row into a control, and offers no Approve or Deny on the list', async () => {
    m.list.mockResolvedValue([
      row({ status: 'pending_approval' }),
      row({ status: 'pending_approval' }),
    ]);
    const view = await renderPage();
    const table = view.getByRole('table');
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    expect(within(table).queryByText(/^(Approve|Deny)$/)).toBeNull();
    expect(table.querySelector('tr[onclick], tr[role="button"], tr[tabindex]')).toBeNull();
  });
});

describe('Orders page: Newer / Older', () => {
  it('reads 51 to know about Older, shows 50, and Older opens the next page of the same tab', async () => {
    m.list.mockResolvedValue(Array.from({ length: 51 }, () => row()));
    const view = await renderPage({ status: 'completed' });
    expect(view.getAllByRole('row')).toHaveLength(1 + 50);
    expect(view.getByRole('link', { name: 'Older →' })).toHaveAttribute(
      'href',
      '/dashboard/orders?status=completed&page=2',
    );
    expect(view.getByText('Page 1')).toBeInTheDocument();
  });

  it('on page 1 Newer is a disabled button, not a link a keyboard can follow to "#"', async () => {
    m.list.mockResolvedValue([row()]);
    const view = await renderPage({ status: 'completed' });
    expect(view.queryByRole('link', { name: '← Newer' })).toBeNull();
    expect(view.getByRole('button', { name: '← Newer' })).toBeDisabled();
    // The last page: Older is the same quiet disabled button.
    expect(view.queryByRole('link', { name: 'Older →' })).toBeNull();
    expect(view.getByRole('button', { name: 'Older →' })).toBeDisabled();
    expect(view.container.querySelector('a[href="#"]')).toBeNull();
  });

  it('a later page links Newer back with the tab kept and reads from its offset', async () => {
    m.list.mockResolvedValue([row()]);
    const view = await renderPage({ status: 'awaiting_signature', page: '3' });
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ['staged_for_pickup', 'in_transit'],
        offset: 100,
        limit: 51,
      }),
    );
    expect(view.getByRole('link', { name: '← Newer' })).toHaveAttribute(
      'href',
      '/dashboard/orders?status=awaiting_signature&page=2',
    );
    expect(view.getByText('Page 3')).toBeInTheDocument();
  });

  it('clamps the page as before (below 1 is page 1, the cap is 10,000)', async () => {
    await renderPage({ page: '-4' });
    expect(m.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
    await renderPage({ page: '99999' });
    expect(m.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 9_999 * 50 }));
  });

  it('stays under an empty stage, so a later page can still go back', async () => {
    const view = await renderPage({ status: 'packing', page: '2' });
    expect(view.getByText('Nothing in packing')).toBeInTheDocument();
    expect(view.getByRole('link', { name: '← Newer' })).toHaveAttribute(
      'href',
      '/dashboard/orders?status=packing&page=1',
    );
  });
});

describe('Orders page: empty and failed states keep their words', () => {
  it('an empty stage says so in its own words, with no table', async () => {
    const view = await renderPage({ status: 'denied_cancelled' });
    expect(view.getByRole('heading', { name: 'Nothing in denied/cancelled' })).toBeInTheDocument();
    expect(
      view.getByText(
        'No requests are sitting in this stage. Switch tabs above to see other stages of the queue.',
      ),
    ).toBeInTheDocument();
    expect(view.queryByRole('table')).toBeNull();
    // An empty stage is a finished page.
    expect(view.getByTestId('perf-useful')).toBeInTheDocument();
  });

  it('the empty Waiting for signature filter has its own title', async () => {
    const view = await renderPage({ status: 'awaiting_signature' });
    expect(
      view.getByRole('heading', { name: 'No orders waiting for signature' }),
    ).toBeInTheDocument();
  });

  it('a requester with no orders is invited to place one', async () => {
    setViewer(false);
    const view = await renderPage();
    expect(view.getByRole('heading', { name: 'No requests yet' })).toBeInTheDocument();
    expect(
      view.getByText("Place your first order request and we'll route it to the right approver."),
    ).toBeInTheDocument();
    expect(view.getByRole('link', { name: 'Place an order' })).toHaveAttribute(
      'href',
      '/dashboard/orders/new',
    );
  });

  it('a failed read keeps the tabs, Export, Place order and the pager, says what happened and offers Try again', async () => {
    m.list.mockRejectedValue(new Error('boom'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderPage({ status: 'staged', page: '2' });
    errors.mockRestore();

    expect(view.getByRole('heading', { name: "We couldn't load orders" })).toBeInTheDocument();
    expect(
      view.getByText(
        'Something went wrong loading this list. This is usually temporary — try again in a moment, and switch tabs above to view other stages.',
      ),
    ).toBeInTheDocument();
    expect(view.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/dashboard/orders?status=staged',
    );
    expect(view.getByRole('navigation', { name: 'Status' })).toBeInTheDocument();
    expect(view.getByTestId('orders-export-menu')).toBeInTheDocument();
    expect(view.getByRole('link', { name: '+ Place order' })).toBeInTheDocument();
    expect(view.getByRole('link', { name: '← Newer' })).toBeInTheDocument();
    expect(view.queryByRole('table')).toBeNull();
    // A failure is not useful content.
    expect(view.queryByTestId('perf-useful')).toBeNull();
  });
});

describe('Orders page: Manage order items (ordering visibility, design 8.1)', () => {
  it('is offered beside Place order when the service context allows it, and decided from that context', async () => {
    const serviceCtx = { organizationId: 'org-1', role: 'manager' };
    m.withContext.mockResolvedValue(serviceCtx);
    m.canManageOrderItems.mockReturnValue(true);
    const view = await renderPage();
    const link = view.getByRole('link', { name: 'Manage order items' });
    expect(link.getAttribute('href')).toBe('/dashboard/orders/manage-items');
    expect(m.canManageOrderItems).toHaveBeenCalledWith(serviceCtx);
    // In the header's actions, with Place order.
    const actions = view.container.querySelector('[data-slot="page-header-actions"]');
    expect(actions?.textContent).toContain('Manage order items');
    expect(actions?.textContent).toContain('+ Place order');
  });

  it('a requester StockPilot allowed sees it on My requests too', async () => {
    setViewer(false);
    m.canManageOrderItems.mockReturnValue(true);
    const view = await renderPage();
    expect(view.getByRole('link', { name: 'Manage order items' })).toBeInTheDocument();
  });

  it('is not offered without the capability, the switch or the module', async () => {
    m.canManageOrderItems.mockReturnValue(false);
    const view = await renderPage();
    expect(view.queryByRole('link', { name: 'Manage order items' })).toBeNull();
  });

  it('is not offered when the service context failed (fail closed); the page still renders', async () => {
    m.withContext.mockRejectedValue(new Error('context down'));
    m.canManageOrderItems.mockReturnValue(true);
    const view = await renderPage();
    expect(view.queryByRole('link', { name: 'Manage order items' })).toBeNull();
    expect(view.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
