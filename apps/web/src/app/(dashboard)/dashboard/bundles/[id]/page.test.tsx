import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * The bundle page in the redesign (P4.D2, matrix W-CA-11): the record header
 * (back link, name, status and Pre-assembly labels, SKU, description, Edit /
 * Archive / Distribute), the Components and Recent distributions cards, and
 * the rail with Pre-assembled stock and Audit. Words, links and gates are
 * today's; the dialogs are stubbed here and tested in their own files.
 */

const ctx: { role: Role; permissions: ReadonlySet<string> } = {
  role: 'owner',
  permissions: effectivePermissions('owner'),
};

type Detail = {
  bundle: Record<string, unknown>;
  components: Array<Record<string, unknown>>;
  phantom: { quantityOnHand: number; warehouseId: string | null } | null;
};

const data: { detail: Detail; recent: Array<Record<string, unknown>>; fail: boolean } = {
  detail: { bundle: {}, components: [], phantom: null },
  recent: [],
  fail: false,
};

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', ...ctx })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'gte', 'lte', 'in', 'order', 'limit', 'not']) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return { from: () => chain };
  }),
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: {
    forCurrentUser: vi.fn(async () => ({
      get: vi.fn(async () => {
        if (data.fail) throw new Error('not found');
        return data.detail;
      }),
      recentDistributions: vi.fn(async () => data.recent),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [
        { id: 'wh-1', name: 'North DC' },
        { id: 'wh-2', name: 'South DC' },
      ]),
    })),
  },
}));
vi.mock('@/components/bundles/distribute-bundle-modal', () => ({
  DistributeBundleModal: () => <button type="button">Distribute</button>,
}));
vi.mock('@/components/bundles/assemble-bundle-modal', () => ({
  AssembleBundleModal: ({ lockedWarehouseId }: { lockedWarehouseId: string | null }) => (
    <button type="button" data-locked={lockedWarehouseId ?? ''}>
      Assemble more
    </button>
  ),
}));
vi.mock('@/components/bundles/archive-bundle-button', () => ({
  ArchiveBundleButton: () => <button type="button">Archive</button>,
}));

import BundleDetailPage from './page';

const BUNDLE_ID = '5eed0000-0000-4000-8000-0000000000b9';

function bundle(over: Record<string, unknown> = {}) {
  return {
    id: BUNDLE_ID,
    name: 'Science Starter Kit',
    sku: 'KIT-SCI-01',
    description: 'One per new science classroom.',
    is_active: true,
    archived_at: null,
    preassembly_enabled: true,
    created_at: '2026-09-25T12:00:00Z',
    updated_at: '2026-09-26T12:00:00Z',
    ...over,
  };
}

async function renderAs(role: Role = 'owner') {
  ctx.role = role;
  ctx.permissions = effectivePermissions(role);
  return render(await BundleDetailPage({ params: Promise.resolve({ id: BUNDLE_ID }) }));
}

beforeEach(() => {
  cleanup();
  data.fail = false;
  data.detail = {
    bundle: bundle(),
    components: [
      {
        itemId: 'i-1',
        itemName: 'Safety goggles',
        itemSku: 'SCI-GOG',
        quantity: 2,
        itemQuantityOnHand: 40,
        isOptional: false,
      },
      {
        itemId: null,
        itemName: null,
        itemSku: null,
        quantity: 1,
        itemQuantityOnHand: 0,
        isOptional: true,
      },
    ],
    phantom: { quantityOnHand: 5, warehouseId: 'wh-1' },
  };
  data.recent = [
    {
      id: 'd-1',
      distributed_at: '2026-10-01T12:00:00Z',
      warehouse_id: 'wh-2',
      quantity: 3,
      notes: 'Room 12 restock',
      shortage_recorded: true,
      schedule_event_id: 'ev-1',
    },
  ];
});

describe('bundle page header', () => {
  it('draws the shared record header: back link, one wrapping h1, labels, SKU and description', async () => {
    await renderAs();
    const header = document.querySelector('[data-slot="page-header"]') as HTMLElement;
    expect(header).toBeTruthy();
    expect(within(header).getByRole('link', { name: '← Back to bundles' })).toHaveAttribute(
      'href',
      '/dashboard/bundles',
    );
    const h1 = within(header).getByRole('heading', { level: 1, name: 'Science Starter Kit' });
    // The name wraps instead of truncating, so its actions can never squeeze it out.
    expect(h1).not.toHaveClass('truncate');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(within(header).getByText('Active')).toBeTruthy();
    expect(within(header).getByText('Pre-assembly')).toBeTruthy();
    expect(within(header).getByText('KIT-SCI-01')).toBeTruthy();
    expect(within(header).getByText('One per new science classroom.')).toBeTruthy();
  });

  it('a manager gets Edit, Archive and Distribute; Edit links to the form', async () => {
    await renderAs('manager');
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/dashboard/bundles/${BUNDLE_ID}/edit`,
    );
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Distribute' })).toBeTruthy();
  });

  it('staff read the bundle with no Edit, Archive, Distribute or Assemble more', async () => {
    await renderAs('staff');
    expect(screen.getByRole('heading', { level: 1, name: 'Science Starter Kit' })).toBeTruthy();
    for (const name of ['Archive', 'Distribute', 'Assemble more']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('an archived bundle shows Archived, keeps Edit, and offers neither Archive nor Distribute', async () => {
    data.detail.bundle = bundle({ archived_at: '2026-10-02T00:00:00Z' });
    await renderAs('owner');
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Distribute' })).toBeNull();
  });

  it('an inactive bundle shows Inactive and is not offered Distribute', async () => {
    data.detail.bundle = bundle({ is_active: false });
    await renderAs('owner');
    expect(screen.getByText('Inactive')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Distribute' })).toBeNull();
  });

  it('any failure to load the bundle is a 404', async () => {
    data.fail = true;
    await expect(renderAs('owner')).rejects.toThrow('notFound');
  });
});

describe('bundle page cards', () => {
  it('Components lists each item with its link, Qty / kit, On hand and Optional, and a deleted item', async () => {
    await renderAs();
    const card = screen.getByRole('heading', { name: 'Components (2)' }).closest('section')!;
    const table = within(card).getByRole('table');
    for (const head of ['Item', 'Qty / kit', 'On hand', 'Optional']) {
      expect(within(table).getByRole('columnheader', { name: head })).toBeTruthy();
    }
    const link = within(table).getByRole('link', { name: /Safety goggles/ });
    expect(link).toHaveAttribute('href', '/dashboard/inventory/i-1');
    expect(link).toHaveTextContent('SCI-GOG');
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(within(first!).getAllByRole('cell')[1]).toHaveTextContent('2');
    expect(within(first!).getAllByRole('cell')[2]).toHaveTextContent('40');
    expect(within(first!).getAllByRole('cell')[3]).toHaveTextContent('—');
    expect(second).toHaveTextContent('Deleted item');
    expect(within(second!).getAllByRole('cell')[3]).toHaveTextContent('Optional');
  });

  it('no components: the empty line in the card', async () => {
    data.detail.components = [];
    await renderAs();
    const card = screen.getByRole('heading', { name: 'Components (0)' }).closest('section')!;
    expect(within(card).getByText('No components — edit this bundle to add some.')).toBeTruthy();
    expect(within(card).queryByRole('table')).toBeNull();
  });

  it('Recent distributions shows the warehouse, quantity, notes and the Shortage and Event flags', async () => {
    await renderAs();
    const card = screen.getByRole('heading', { name: 'Recent distributions' }).closest('section')!;
    const table = within(card).getByRole('table');
    for (const head of ['When', 'Warehouse', 'Qty', 'Notes', 'Flags']) {
      expect(within(table).getByRole('columnheader', { name: head })).toBeTruthy();
    }
    const body = within(table).getAllByRole('row')[1]!;
    expect(body).toHaveTextContent('South DC');
    expect(body).toHaveTextContent('3');
    expect(within(body).getByText('Room 12 restock')).toHaveAttribute('title', 'Room 12 restock');
    expect(within(body).getByText('Shortage')).toBeTruthy();
    expect(within(body).getByText('Event')).toBeTruthy();
  });

  it('no distributions: the empty line', async () => {
    data.recent = [];
    await renderAs();
    const card = screen.getByRole('heading', { name: 'Recent distributions' }).closest('section')!;
    expect(within(card).getByText('No distributions yet.')).toBeTruthy();
  });

  it('Pre-assembled stock shows the kits ready at the phantom warehouse and Assemble more, locked to it', async () => {
    await renderAs('manager');
    const card = screen.getByRole('heading', { name: 'Pre-assembled stock' }).closest('section')!;
    expect(card).toHaveTextContent('5');
    expect(card).toHaveTextContent('kits ready at North DC');
    expect(within(card).getByRole('button', { name: 'Assemble more' })).toHaveAttribute(
      'data-locked',
      'wh-1',
    );
  });

  it('pre-assembly off: no Pre-assembled stock card', async () => {
    data.detail.bundle = bundle({ preassembly_enabled: false });
    await renderAs();
    expect(screen.queryByRole('heading', { name: 'Pre-assembled stock' })).toBeNull();
  });

  it('Audit lists Created and Updated as label and value', async () => {
    await renderAs();
    const card = screen.getByRole('heading', { name: 'Audit' }).closest('section')!;
    const terms = within(card)
      .getAllByRole('term')
      .map((t) => t.textContent);
    expect(terms).toEqual(['Created', 'Updated']);
  });

  it('bundles are not product groups: no checkboxes, Group selected or Ungroup', async () => {
    await renderAs();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText(/Group selected|Ungroup/i)).toBeNull();
  });
});

// B63: a mistyped or cut-off link is Page not found before anything else:
// ahead of the bundles:read redirect, and before the bundle is read (the
// catch-all around that read already answered not found, but only after the
// read had failed).
describe('bundle page: an id that is not a uuid', () => {
  it('is the not-found page, with nothing read', async () => {
    const { requireOrgContext } = await import('@/lib/auth/session');
    const { BundlesService } = await import('@/server/services/bundles');
    vi.mocked(requireOrgContext).mockClear();
    vi.mocked(BundlesService.forCurrentUser).mockClear();
    ctx.role = 'viewer';
    ctx.permissions = new Set<string>();
    for (const id of ['not-a-uuid', BUNDLE_ID.slice(0, -1)]) {
      await expect(BundleDetailPage({ params: Promise.resolve({ id }) }), id).rejects.toThrow(
        'notFound',
      );
    }
    expect(requireOrgContext).not.toHaveBeenCalled();
    expect(BundlesService.forCurrentUser).not.toHaveBeenCalled();
  });
});
