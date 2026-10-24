import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Movements page rendered for real (the async server component awaited,
 * then its tree rendered), with the ledger service, the session and the
 * warehouse cookie stubbed. page.test.tsx pins the pager props in the source;
 * this proves what the page draws in each mode.
 */

type Params = { page?: string; q?: string; type?: string; from?: string; to?: string };
type CountArgs = { search?: string; types?: string[]; since?: string; until?: string };
type ListArgs = CountArgs & { limit?: number; offset?: number };

const h = vi.hoisted(() => ({
  permissions: new Set<string>(['activity_logs:read', 'movements:edit_notes']),
  count: null as unknown as (args: CountArgs) => Promise<number>,
  list: null as unknown as (args: ListArgs) => Promise<unknown[]>,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-lab',
    userId: 'user-manager',
    role: 'manager',
    permissions: h.permissions,
  })),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
// The page reads the organization's zone for its times and its From and To
// days (L7); page.org-zone.test.tsx covers what it does with it.
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: {
    forCurrentUser: vi.fn(async () => ({
      count: (args: CountArgs) => h.count(args),
      list: (args: ListArgs) => h.list(args),
    })),
  },
}));
vi.mock('@/server/actions/movements', () => ({ editMovementNoteAction: vi.fn() }));

import MovementsPage, { metadata } from './page';

/** A raw ledger row in MovementsService.list()'s shape. */
function mv(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    movement_type: 'adjust',
    quantity_change: 4,
    previous_quantity: 6,
    new_quantity: 10,
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: null,
    notes: null,
    created_at: '2026-09-01T12:00:00.000Z',
    item_id: 'item-1',
    user_id: 'user-2',
    order_ref_id: null,
    item: { id: 'item-1', name: 'Copy Paper Case', sku: 'PAP-CASE-01' },
    actor: { id: 'user-2', fullName: 'Avery Stone', email: 'avery@test.local' },
    actorDeleted: false,
    ...over,
  };
}

/** An order pick: written as movement_type 'transfer' with a real delta and no moved quantity. */
const PICK = mv({
  id: 'm-pick',
  movement_type: 'transfer',
  quantity_change: -5,
  previous_quantity: 100,
  new_quantity: 95,
  reason: 'Order pick (SO-000060)',
  order_ref_id: 'order-60',
  item: { id: 'item-9', name: 'Picked Item', sku: 'PICK-9' },
});

const filtered = (a: CountArgs) => Boolean(a.search || a.types?.length || a.since || a.until);

/** An org over the 1,000-row instant cap: the server-paged ledger. */
function serverLedger({ total = 1500, matching = 3, rows = [PICK] as unknown[] } = {}) {
  h.count = async (a) => (filtered(a) ? matching : total);
  // The speculative instant page (limit 1000) is discarded over the cap.
  h.list = async (a) => (a.limit === 1000 ? [] : rows);
}

/** An org at or under the cap: the whole ledger loads and filters in the browser. */
function instantLedger(rows: unknown[]) {
  h.count = async () => rows.length;
  h.list = async () => rows;
}

async function renderPage(params: Params = {}) {
  const ui = await MovementsPage({ searchParams: Promise.resolve(params) });
  return render(ui);
}

/** The Δ cell of the row naming `itemName` (When, Item, Type, Δ, ...). */
function deltaCell(itemName: string) {
  const tr = screen.getByText(itemName).closest('tr') as HTMLElement;
  return tr.querySelectorAll('td')[3] as HTMLElement;
}

function exportLinks() {
  return screen.queryAllByRole('link', { name: 'Export movements to CSV' });
}

beforeEach(() => {
  h.permissions = new Set(['activity_logs:read', 'movements:edit_notes']);
});

describe('Movements page: title and gate', () => {
  it('names the browser tab "Stock movements" (CONFLICTS D16: it read "Dashboard")', () => {
    expect(metadata).toEqual({ title: 'Stock movements' });
  });

  it('sends anyone without activity_logs:read back to the dashboard', async () => {
    h.permissions = new Set(['movements:edit_notes']);
    instantLedger([mv()]);
    await expect(MovementsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/dashboard',
    );
  });

  it('keeps the heading and its line', async () => {
    instantLedger([mv()]);
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Stock movements' })).toBeInTheDocument();
    expect(
      screen.getByText('Every quantity change, audited. The ledger is append-only.'),
    ).toBeInTheDocument();
  });
});

describe('Movements page: server-paged ledger (over the instant cap)', () => {
  // The server copy of the table kept the old type-keyed amount rule and
  // printed "—" for every order pick (a 'transfer' with a real delta) while
  // its After column dropped. Both modes now draw the one MovementsTable.
  it('shows the signed delta for an order pick, as the instant ledger does', async () => {
    serverLedger();
    await renderPage();
    const cell = deltaCell('Picked Item');
    expect(cell.textContent).toBe('-5');
    expect(cell.className).toContain('text-destructive');
    expect(screen.getByRole('link', { name: 'Order pick (SO-000060)' })).toHaveAttribute(
      'href',
      '/dashboard/orders/order-60',
    );
  });

  it('applies ?q= and ?type= on the server and presses the matching chip', async () => {
    serverLedger();
    const listSpy = vi.fn(h.list);
    h.list = listSpy;
    await renderPage({ q: 'pick', type: 'transfer' });

    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 51, offset: 0, search: 'pick', types: ['transfer'] }),
    );
    const types = screen.getByRole('group', { name: 'Filter by movement type' });
    expect(within(types).getByRole('button', { name: 'Transfer' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Search stock movements')).toHaveValue('pick');
  });

  it('puts one filtered Export CSV in the header', async () => {
    serverLedger();
    await renderPage({ q: 'pick', type: 'transfer', from: '2026-09-01', to: '2026-09-30' });
    const links = exportLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      '/api/movements/export.csv?q=pick&type=transfer&from=2026-09-01&to=2026-09-30',
    );
    expect(links[0]).toHaveAttribute('download');
  });

  it('draws a pager above and below the table, both keeping the filters', async () => {
    serverLedger({ matching: 120 });
    await renderPage({ type: 'transfer' });
    const next = screen.getAllByRole('link', { name: 'Next →' });
    expect(next).toHaveLength(2);
    for (const link of next) {
      expect(link).toHaveAttribute('href', '/dashboard/movements?type=transfer&page=2');
    }
    expect(screen.getAllByRole('button', { name: 'Jump to page' })).toHaveLength(2);
  });

  it('a filter that matches nothing keeps the filters and offers Clear filters', async () => {
    serverLedger({ matching: 0, rows: [] });
    await renderPage({ type: 'loss' });
    expect(screen.getByRole('heading', { name: 'No movements match' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/dashboard/movements',
    );
    expect(screen.getByRole('group', { name: 'Filter by movement type' })).toBeInTheDocument();
    expect(exportLinks()).toHaveLength(1);
  });

  it('past the last page says "End of the ledger" and links back to the newest', async () => {
    serverLedger({ rows: [] });
    await renderPage({ page: '99' });
    expect(screen.getByRole('heading', { name: 'End of the ledger' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to newest' })).toHaveAttribute(
      'href',
      '/dashboard/movements',
    );
  });
});

describe('Movements page: instant ledger (at or under the cap)', () => {
  it('lists every movement, with the header Export for the whole ledger', async () => {
    instantLedger([mv(), PICK]);
    await renderPage();
    expect(screen.getByText('Copy Paper Case')).toBeInTheDocument();
    expect(deltaCell('Picked Item').textContent).toBe('-5');
    const links = exportLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/api/movements/export.csv');
  });

  it('offers the note editor to a holder of movements:edit_notes only', async () => {
    instantLedger([mv()]);
    const { unmount } = await renderPage();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
    unmount();

    h.permissions = new Set(['activity_logs:read']);
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
  });

  it('an empty ledger says so, links to inventory and offers no export', async () => {
    instantLedger([]);
    await renderPage();
    expect(screen.getByRole('heading', { name: 'No movements yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to inventory' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
    expect(exportLinks()).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Filter by movement type' })).toBeNull();
  });
});
