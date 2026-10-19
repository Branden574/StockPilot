import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY } from '@stockpilot/core';

/**
 * The returns list in the redesign (P4.B3, matrix W-OR-05): the shared page
 * header, the nine filters as chips in the "Return filters" navigation with
 * aria-current, the GET search that keeps the open filter, the table card,
 * the 32 px thumbnails, the waiting prompt from 14 days, the keyset pager
 * ("← First page", "Next 25 →") and the empty and filtered states, each with
 * the words it had.
 */

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({ ModuleNotEnabled: () => null }));
const effectiveNavLabel = vi.fn(async (_href: string, fallback: string) => fallback);
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: (href: string, fallback: string) => effectiveNavLabel(href, fallback),
}));

const listPage = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
vi.mock('@/server/services/returns', () => ({
  RMAService: { forCurrentUser: vi.fn(async () => ({ listPage })) },
}));

import ReturnsPage from './page';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ret-1',
    returnNumber: 'RMA-20261018-ABCDEF',
    status: 'approved',
    source: 'requester',
    reasonCode: 'damaged',
    orderRequestId: ORDER_ID,
    orderNumber: 49,
    requesterName: 'Pat Lee',
    requesterEmail: null,
    createdAt: '2026-10-01T00:00:00Z',
    approvedAt: '2026-10-02T00:00:00Z',
    waitingDays: 15,
    lineCount: 2,
    unitCount: 3,
    items: [
      {
        itemId: 'i1',
        name: 'Hoodie',
        variant: 'L',
        quantity: 2,
        thumbUrl: 'https://signed.test/hoodie.jpg',
      },
      { itemId: 'i2', name: 'Notebook', variant: null, quantity: 1, thumbUrl: null },
    ],
    moreItems: 3,
    type: 'return',
    ...over,
  };
}

function answer(over: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    filter: 'all',
    q: '',
    rows: [row()],
    nextCursor: null,
    pageSize: 25,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

async function renderPage(searchParams: Record<string, string> = {}) {
  return render(await ReturnsPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('returns list (redesign)', () => {
  it('has one h1, "Returns", with the explanation under it', async () => {
    listPage.mockResolvedValueOnce(answer());
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Returns' })).toBeInTheDocument();
    expect(
      screen.getByText(/RMAs against handed-over orders\. Approving moves nothing;/),
    ).toBeInTheDocument();
  });

  it("follows a Settings > Navigation rename of the sidebar's Returns entry in the h1 (PLAN rule 10)", async () => {
    listPage.mockResolvedValueOnce(answer());
    effectiveNavLabel.mockResolvedValueOnce('RMAs');
    await renderPage();
    expect(effectiveNavLabel).toHaveBeenCalledWith('/dashboard/returns', 'Returns');
    expect(screen.getByRole('heading', { level: 1, name: 'RMAs' })).toBeInTheDocument();
  });

  it('keeps "Returns" when the rename cannot be read, and still shows the list', async () => {
    listPage.mockResolvedValueOnce(answer());
    effectiveNavLabel.mockRejectedValueOnce(new Error('no org row'));
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Returns' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'RMA-20261018-ABCDEF' })).toBeInTheDocument();
  });

  it('offers all nine filters as links in the "Return filters" navigation, the open one marked current', async () => {
    listPage.mockResolvedValueOnce(answer({ filter: 'exchanges' }));
    await renderPage({ filter: 'exchanges' });
    const nav = screen.getByRole('navigation', { name: 'Return filters' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'All',
      'Returns only',
      'Exchanges',
      'Awaiting approval',
      'Waiting for returned item',
      'Received, not processed',
      'Replacement unavailable',
      'Replacement ready',
      'Closed',
    ]);
    expect(within(nav).getByRole('link', { name: 'Exchanges' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'All' })).toHaveAttribute(
      'href',
      '/dashboard/returns',
    );
    expect(within(nav).getByRole('link', { name: 'Closed' })).toHaveAttribute(
      'href',
      '/dashboard/returns?filter=closed',
    );
  });

  it('keeps the search a GET form named by its placeholder, carrying the open filter and the typed words', async () => {
    listPage.mockResolvedValueOnce(answer({ filter: 'received_not_processed', q: 'SO-49' }));
    const { container } = await renderPage({ filter: 'received_not_processed', q: 'SO-49' });
    const form = screen.getByRole('search');
    expect(form).toHaveAttribute('action', '/dashboard/returns');
    expect(form).toHaveAttribute('method', 'get');
    const box = within(form).getByRole('searchbox', { name: 'Search RMA, SO number or requester' });
    expect(box).toHaveAttribute('name', 'q');
    expect(box).toHaveValue('SO-49');
    expect(container.querySelector('input[type="hidden"][name="filter"]')).toHaveAttribute(
      'value',
      'received_not_processed',
    );
    // A filter link keeps the search words.
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute(
      'href',
      '/dashboard/returns?q=SO-49',
    );
  });

  it('draws every column, the thumbnails in their 32 px frame (the hatch without a photo), "+N" more and the waiting prompt', async () => {
    listPage.mockResolvedValueOnce(answer());
    const { container } = await renderPage();
    // The page title names the table's scroll region.
    expect(screen.getByRole('region', { name: 'Returns' })).toContainElement(
      screen.getByRole('table'),
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'RMA',
      'Order',
      'Type',
      'Requester',
      'Returning',
      'Status',
      'Created',
    ]);
    expect(screen.getByRole('link', { name: 'RMA-20261018-ABCDEF' })).toHaveAttribute(
      'href',
      '/dashboard/returns/ret-1',
    );
    expect(screen.getByRole('link', { name: 'SO-000049' })).toHaveAttribute(
      'href',
      `/dashboard/orders/${ORDER_ID}`,
    );
    expect(screen.getByText('Pat Lee')).toBeInTheDocument();
    const frames = container.querySelectorAll('[data-slot="thumb"]');
    expect(frames).toHaveLength(2);
    expect(frames[0]!.querySelector('img')).toHaveAttribute(
      'src',
      'https://signed.test/hoodie.jpg',
    );
    expect(frames[1]!.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
    expect(screen.getByText(RETURNS_COPY.moreItems(3))).toBeInTheDocument();
    // 15 days waiting: at or past the 14-day prompt, said in the warning tone.
    const waiting = screen.getByText(/waiting 15 days/i);
    expect(waiting.className).toMatch(/\btext-warning\b/);
  });

  it('a row with no requester says who made it (Requester / Staff)', async () => {
    listPage.mockResolvedValueOnce(
      answer({
        rows: [
          row({ requesterName: null, source: 'internal' }),
          row({ id: 'ret-2', requesterName: null, source: 'requester' }),
        ],
      }),
    );
    await renderPage();
    const [, staffRow, requesterRow] = screen.getAllByRole('row');
    expect(within(staffRow!).getByText('Staff')).toBeInTheDocument();
    expect(within(requesterRow!).getByText('Requester')).toBeInTheDocument();
  });

  it('pages by cursor with the same words and URLs, in the table card footer', async () => {
    listPage.mockResolvedValueOnce(answer({ filter: 'closed', nextCursor: 'c2' }));
    await renderPage({ filter: 'closed', cursor: 'c1' });
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('link', { name: '← First page' })).toHaveAttribute(
      'href',
      '/dashboard/returns?filter=closed',
    );
    expect(within(pages).getByRole('link', { name: 'Next 25 →' })).toHaveAttribute(
      'href',
      '/dashboard/returns?filter=closed&cursor=c2',
    );
    expect(listPage).toHaveBeenCalledWith({ filter: 'closed', q: null, cursor: 'c1' });
  });

  it('keeps the "Pages" navigation on a single page, with no links in it', async () => {
    listPage.mockResolvedValueOnce(answer());
    await renderPage();
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).queryAllByRole('link')).toHaveLength(0);
  });

  it('with no returns at all: "No returns yet" as the empty state', async () => {
    listPage.mockResolvedValueOnce(answer({ rows: [] }));
    const { container } = await renderPage();
    expect(screen.getByRole('heading', { name: 'No returns yet' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Open a handed-over order and create a return. Returns requested from a return link or the customer portal show up here too.',
      ),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-state-kind="empty"]')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a filter or search with nothing in it says so as a no-match state, and still offers the way back', async () => {
    listPage.mockResolvedValueOnce(answer({ rows: [], filter: 'awaiting_approval' }));
    const { container } = await renderPage({ filter: 'awaiting_approval' });
    expect(
      screen.getByRole('heading', { name: 'No returns match this view.' }),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-state-kind="no-match"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('href', '/dashboard/returns');
  });
});
