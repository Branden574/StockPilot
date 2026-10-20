// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One warehouse's page (W-BK-14), redrawn with the shared header, stat strip
 * and detail sections. What it keeps: Back to warehouses, the name, code and
 * status, Updated, Edit (the admin route), New order from here, the four
 * figures with their foot lines, Address & contact, Manager, Notes and
 * Charters serviced. What it fixes: New order from here sends the
 * ?warehouseId= the storefront reads (CONFLICTS D2), and a contact phone or
 * email becomes a link only when it is one plain number or address (P5.8
 * verify sweep).
 */

const { get, chartersList, listPairs, counts } = vi.hoisted(() => ({
  get: vi.fn(),
  chartersList: vi.fn(),
  listPairs: vi.fn(),
  counts: { items: 12, pending: 3, completed: 7 },
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: async () => ({ get }) },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: async () => ({ list: chartersList }) },
}));
vi.mock('@/server/services/warehouse-charters', () => ({
  WarehouseChartersService: { forCurrentUser: async () => ({ listPairs }) },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        is: () => q,
        gte: () => q,
        then: (resolve: (r: { count: number }) => void) => {
          const status = filters.find(([k]) => k === 'status')?.[1];
          const count =
            table === 'inventory_items'
              ? counts.items
              : status === 'pending_approval'
                ? counts.pending
                : counts.completed;
          resolve({ count });
        },
      };
      return q;
    },
  }),
}));

import WarehouseDetailPage from './page';

const WH = '5eed0000-0003-4000-8000-000000000001';

function warehouse(over: Record<string, unknown> = {}) {
  return {
    id: WH,
    organization_id: 'org-1',
    name: 'North DC',
    code: 'NDC',
    address: { line1: '1 Dock Rd', city: 'Fresno', region: 'CA', postalCode: '93701' },
    contact_name: 'Dock desk',
    contact_email: 'dock@example.com',
    contact_phone: '(555) 010-0100',
    manager_user_id: 'u-1',
    manager: { id: 'u-1', full_name: 'Mia Manager', email: 'mia@example.com', avatar_url: null },
    status: 'active',
    notes: 'Back gate closes at 5.',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
    ...over,
  };
}

async function renderPage() {
  render(await WarehouseDetailPage({ params: Promise.resolve({ id: WH }) }));
}

beforeEach(() => {
  get.mockReset();
  chartersList.mockResolvedValue([
    { id: 'c-1', name: 'Harbor', code: 'HAR' },
    { id: 'c-2', name: 'Ridge', code: 'RDG' },
  ]);
  listPairs.mockResolvedValue([{ warehouse_id: WH, charter_id: 'c-1' }]);
});

describe('Warehouse page', () => {
  it('keeps the header: back link, name, code, status, Updated, Edit', async () => {
    get.mockResolvedValue(warehouse());
    await renderPage();
    expect(screen.getByRole('link', { name: '← Back to warehouses' })).toHaveAttribute(
      'href',
      '/dashboard/admin/warehouses',
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('North DC');
    expect(screen.getByText('NDC')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/dashboard/admin/warehouses',
    );
  });

  it('New order from here preselects this warehouse with ?warehouseId= (D2)', async () => {
    get.mockResolvedValue(warehouse());
    await renderPage();
    const link = screen.getByRole('link', { name: /New order from here/ });
    expect(link).toHaveAttribute('href', `/dashboard/orders/new?warehouseId=${WH}`);
    expect(link.getAttribute('href')).not.toMatch(/[?&]warehouse=/);
  });

  it('shows the four figures with their foot lines', async () => {
    get.mockResolvedValue(warehouse());
    await renderPage();
    const cells = [...document.querySelectorAll<HTMLElement>('[data-slot="stat-strip-item"]')];
    expect(cells).toHaveLength(4);
    for (const [label, value, foot] of [
      ['Items on hand', '12', 'Active items at this warehouse'],
      ['Charters serviced', '1', null],
      ['Completed orders (30d)', '7', 'Fulfilled out of here'],
      ['Pending order requests', '3', 'Awaiting approval'],
    ] as const) {
      const cell = cells.find((c) => within(c).queryByText(label))!;
      expect(cell).toHaveTextContent(value);
      if (foot) expect(cell).toHaveTextContent(foot);
    }
  });

  it('a plain phone and email are links; the address, contact and manager show', async () => {
    get.mockResolvedValue(warehouse());
    await renderPage();
    expect(screen.getByText('1 Dock Rd')).toBeInTheDocument();
    expect(screen.getByText('Dock desk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '(555) 010-0100' })).toHaveAttribute(
      'href',
      'tel:5550100100',
    );
    expect(screen.getByRole('link', { name: 'dock@example.com' })).toHaveAttribute(
      'href',
      'mailto:dock@example.com',
    );
    expect(screen.getByText('Mia Manager')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'mia@example.com' })).toHaveAttribute(
      'href',
      'mailto:mia@example.com',
    );
    expect(screen.getByText('Back gate closes at 5.')).toBeInTheDocument();
  });

  it.each(['555-0100 ext 12', '*67 555 0100', '555-1234 or 555-9999'])(
    'a phone that is not one plain number (%s) shows its words with no link',
    async (phone) => {
      get.mockResolvedValue(warehouse({ contact_phone: phone }));
      await renderPage();
      expect(screen.getByText(phone)).toBeInTheDocument();
      expect(screen.getByText(phone).closest('a')).toBeNull();
      expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    },
  );

  it('an email that would copy someone else is shown, not linked', async () => {
    get.mockResolvedValue(warehouse({ contact_email: 'a@b.com?bcc=x@y.z' }));
    await renderPage();
    expect(screen.getByText('a@b.com?bcc=x@y.z').closest('a')).toBeNull();
  });

  it('no address, contact, manager or notes: the page says so', async () => {
    get.mockResolvedValue(
      warehouse({
        address: null,
        contact_name: null,
        contact_email: null,
        contact_phone: null,
        manager: null,
        notes: null,
      }),
    );
    await renderPage();
    expect(screen.getByText('No address or contact info on file.')).toBeInTheDocument();
    expect(screen.getByText('No manager assigned.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Notes' })).not.toBeInTheDocument();
  });

  it('lists the charters it serves, or says none are assigned with Manage warehouses', async () => {
    get.mockResolvedValue(warehouse());
    await renderPage();
    const section = screen.getByRole('heading', { name: 'Charters serviced' }).closest('section')!;
    expect(within(section).getByText('Harbor')).toBeInTheDocument();
    expect(within(section).getByText('HAR')).toBeInTheDocument();
    expect(within(section).queryByText('Ridge')).not.toBeInTheDocument();
  });

  it('with no charters: the empty state and its link to Manage warehouses', async () => {
    listPairs.mockResolvedValue([]);
    get.mockResolvedValue(warehouse());
    await renderPage();
    expect(screen.getByText('No charters assigned')).toBeInTheDocument();
    expect(screen.getByText('None assigned yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage warehouses' })).toHaveAttribute(
      'href',
      '/dashboard/admin/warehouses',
    );
  });
});
