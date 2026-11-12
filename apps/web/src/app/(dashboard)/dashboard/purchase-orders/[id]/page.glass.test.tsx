import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A purchase order in Liquid Glass (Purchase-Order.dc.html): the receiving
 * summary card over the lines ("Receiving progress": Received x of y units,
 * Still expected, Expected, and the 10 px bar of units received) and the
 * board's line columns (Ordered, Received, Outstanding and the line's
 * status: "n still to come" or "Fully received"), which glass shows in place
 * of Classic's "Received / ordered" column. All glass-only and stateless:
 * figures and words from the lines and the expected day the page already
 * loads (no new read), rendered under opt-in and default and hidden in
 * Classic by styles/liquid-glass/visibility.css, never under off. Classic's
 * column carries data-classic-only and stays the same (the six pins in
 * page.classic-dom.test.tsx). The board's "Overdue by n days" is not drawn:
 * the overdue rule needs the organization's day (core calendar-date.ts), which
 * this page does not read. Mocks as page.classic-dom.test.tsx sets them.
 */

const poGet = vi.fn();
const inventoryByIds = vi.fn();
const locationsList = vi.fn();
const listForPurchaseOrder = vi.fn(async () => ({ receipts: [], lines: [] }));
const attachmentsList = vi.fn(async () => []);
let role = 'owner';

// The page's own module is on: the page checks it before it reads (B66).
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role,
    permissions: null,
  })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      prefetch: _prefetch,
      ...rest
    }: {
      href: string;
      children: React.ReactNode;
      prefetch?: unknown;
    }) => React.createElement('a', { href, ...rest }, children),
  };
});

vi.mock('@/components/po/po-receive-dialog', () => ({
  PoReceiveDialog: () => <button type="button">Receive items</button>,
}));
vi.mock('@/components/po/po-set-destination', () => ({
  PoSetDestination: () => <div data-testid="set-destination" />,
}));
vi.mock('@/components/po/make-recurring-button', () => ({
  MakeRecurringButton: () => <button type="button">Make recurring</button>,
}));
vi.mock('@/components/po/po-rename-button', () => ({
  PoRenameButton: () => <button type="button" aria-label="Edit PO number" />,
}));
vi.mock('@/components/po/po-notes-editor', () => ({
  PoNotesEditor: () => <div data-testid="notes-editor" />,
}));
vi.mock('@/components/po/po-actions', () => ({
  PoActions: ({ part }: { part?: string }) => <span data-testid={`po-actions-${part ?? 'all'}`} />,
}));
vi.mock('@/components/po/po-attachments-panel', () => ({
  PoFileActions: () => <span data-testid="file-actions" />,
  PoAttachmentsList: () => <section data-testid="attachments" />,
}));
vi.mock('@/components/po/receipt-history', () => ({
  ReceiptHistory: () => <div data-testid="receipt-history" />,
}));
vi.mock('@/components/po/po-status-badge', () => ({
  PoStatusBadge: ({ status }: { status: string }) => <span data-testid="status">{status}</span>,
}));
vi.mock('@/components/po/po-access-denied', () => ({ PoAccessDenied: () => null }));
vi.mock('@/components/items/item-thumb', () => ({
  ItemThumb: ({ alt, imageUrl, size }: { alt: string; imageUrl: string | null; size?: string }) => (
    <span data-testid="thumb" data-alt={alt} data-src={imageUrl ?? ''} data-size={size ?? ''} />
  ),
}));

vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: { forCurrentUser: vi.fn(async () => ({ get: poGet })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({
      listForLookups: vi.fn(async () => [{ id: 'sup-1', name: 'Lantern Peak School Supply' }]),
    })),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: locationsList })) },
}));
vi.mock('@/server/services/receiving', () => ({
  ReceivingService: { forCurrentUser: vi.fn(async () => ({ listForPurchaseOrder })) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [{ id: 'wh-1', name: 'North DC' }]),
    })),
  },
}));
vi.mock('@/server/services/po-attachments', () => ({
  PoAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: attachmentsList })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: inventoryByIds })) },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadSizeRunGroups: vi.fn(async () => ({})),
}));
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import PoDetailPage from './page';

const PO_ID = '5eed0000-0000-4000-8000-0000000000f1';

function po(status = 'partially_received') {
  return {
    po: {
      po_number: 'PO-2026-0018',
      status,
      supplier_id: 'sup-1',
      destination_location_id: 'loc-1',
      expected_at: '2026-10-09T00:00:00.000Z',
      subtotal: 3860,
      total: 3910,
      notes: null,
      created_at: '2026-10-01T16:00:00.000Z',
    },
    lines: [
      {
        id: 'pol-1',
        item_id: 'item-1',
        quantity_ordered: 200,
        quantity_received: 120,
        unit_cost: 18,
        line_total: 3600,
        imageUrl: 'https://img.test/polo-thumb.jpg',
        previewUrl: 'https://img.test/polo.jpg',
      },
      {
        id: 'pol-2',
        item_id: 'item-gone',
        quantity_ordered: 400,
        quantity_received: 0,
        unit_cost: 0.65,
        line_total: 260,
        imageUrl: null,
        previewUrl: null,
      },
    ],
  };
}

const NOW = new Date('2026-10-12T18:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
  role = 'owner';
  inventoryByIds.mockResolvedValue([
    { id: 'item-1', name: 'Polo, Navy', sku: 'POLO-M', tracking_type: 'none' },
  ]);
  locationsList.mockResolvedValue([
    { id: 'loc-1', name: 'North DC Building', warehouse_id: 'wh-1', kind: null },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function page(rollout: 'off' | 'opt-in' | 'default' = 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  return render(await PoDetailPage({ params: Promise.resolve({ id: PO_ID }) }));
}

/** Visible-in-glass header cells of the lines table, by text ("" for the photo's). */
function glassHeads(container: HTMLElement): string[] {
  return [...container.querySelectorAll('#po-line-items-heading ~ * th, table th')]
    .filter((th) => !th.hasAttribute('data-classic-only'))
    .map((th) => th.textContent!.trim());
}

/** Each line's glass-only cells, as text. */
function glassCells(container: HTMLElement): string[][] {
  return [...container.querySelectorAll('[data-testid="po-line"]')].map((tr) =>
    [...tr.querySelectorAll(':scope > td[data-glass-only]')].map((td) => td.textContent!.trim()),
  );
}

describe('A purchase order in Liquid Glass: the receiving summary', () => {
  it('sums the lines: Received 120 of 600 units, 480 still expected, the expected day, and a bar of units received', async () => {
    poGet.mockResolvedValue(po());
    const { container } = await page();
    const card = screen.getByRole('region', { name: 'Receiving progress' });
    expect(card.hasAttribute('data-glass-only')).toBe(true);
    expect(card.getAttribute('data-glass')).toBe('po-progress');
    const figures = [...card.querySelectorAll('[data-glass="po-progress-stat"]')].map((s) =>
      [...s.children].map((c) => c.textContent!.trim()),
    );
    expect(figures).toEqual([
      ['Received', '120 of 600 units'],
      ['Still expected', '480'],
      ['Expected', 'Fri, Oct 9'],
    ]);
    const bar = within(card).getByRole('progressbar', { name: 'Units received' });
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('600');
    expect(bar.getAttribute('aria-valuenow')).toBe('120');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('20%');
    // In the main column, between Line items and Receipts (glass draws it first).
    const column = card.parentElement!;
    const titles = [...column.children].map(
      (c) => c.querySelector('h2')?.textContent ?? c.getAttribute('aria-label'),
    );
    expect(titles).toEqual(['Line items', 'Receiving progress', 'Receipts']);
    expect(container.querySelectorAll('[data-glass="po-progress"]')).toHaveLength(1);
  });

  it('counts a line received past its order as received, never as still expected, and fills the bar to the end', async () => {
    const r = po('partially_received');
    r.lines[0]!.quantity_received = 230;
    r.lines[1]!.quantity_received = 400;
    poGet.mockResolvedValue(r);
    await page();
    const card = screen.getByRole('region', { name: 'Receiving progress' });
    const figures = [...card.querySelectorAll('[data-glass="po-progress-stat"]')].map(
      (s) => s.children[1]!.textContent,
    );
    expect(figures.slice(0, 2)).toEqual(['630 of 600 units', '0']);
    const bar = within(card).getByRole('progressbar', { name: 'Units received' });
    expect(bar.getAttribute('aria-valuenow')).toBe('600');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('is drawn for an ordered, expected and received order; not for a draft or a cancelled one', async () => {
    for (const status of ['ordered', 'expected_inbound', 'received']) {
      poGet.mockResolvedValue(po(status));
      const view = await page();
      expect(view.container.querySelector('[data-glass="po-progress"]'), status).not.toBeNull();
      view.unmount();
    }
    for (const status of ['draft', 'cancelled']) {
      poGet.mockResolvedValue(po(status));
      const view = await page();
      expect(view.container.querySelector('[data-glass="po-progress"]'), status).toBeNull();
      view.unmount();
    }
  });

  it('says "—" for an order with no expected day, as Summary does', async () => {
    const r = po();
    (r.po as Record<string, unknown>).expected_at = null;
    poGet.mockResolvedValue(r);
    await page();
    const card = screen.getByRole('region', { name: 'Receiving progress' });
    expect(card.querySelectorAll('[data-glass="po-progress-stat"]')[2]!.textContent).toBe(
      'Expected—',
    );
  });
});

describe('A purchase order in Liquid Glass: the board’s line columns', () => {
  it('heads the lines Item, Ordered, Received, Outstanding and Status, and keeps Classic’s column, marked Classic-only', async () => {
    poGet.mockResolvedValue(po());
    const { container } = await page();
    expect(glassHeads(container)).toEqual([
      'Image',
      'Item',
      'Ordered',
      'Received',
      'Outstanding',
      'Status',
    ]);
    const classic = [...container.querySelectorAll('th[data-classic-only]')];
    expect(classic.map((th) => th.textContent!.trim())).toEqual(['Received / ordered']);
    for (const row of container.querySelectorAll('[data-testid="po-line"]')) {
      const cells = [...row.querySelectorAll(':scope > td')];
      expect(cells.at(-1)!.hasAttribute('data-classic-only')).toBe(true);
      expect(cells.filter((td) => td.hasAttribute('data-glass-only'))).toHaveLength(4);
    }
  });

  it('prints each line’s ordered, received and outstanding figures and its status', async () => {
    poGet.mockResolvedValue(po());
    const { container } = await page();
    expect(glassCells(container)).toEqual([
      ['200', '120', '80', '80 still to come'],
      ['400', '0', '400', '400 still to come'],
    ]);
    const outstanding = container.querySelector(
      '[data-testid="po-line"] > td[data-glass="po-line-outstanding"]',
    )!;
    expect(outstanding.getAttribute('data-state')).toBe('due');
  });

  it('says Fully received, with nothing outstanding, for a line received in full or past it', async () => {
    const r = po('received');
    r.lines[0]!.quantity_received = 200;
    r.lines[1]!.quantity_received = 410;
    poGet.mockResolvedValue(r);
    const { container } = await page();
    expect(glassCells(container)).toEqual([
      ['200', '200', '0', 'Fully received'],
      ['400', '410', '0', 'Fully received'],
    ]);
    for (const td of container.querySelectorAll('td[data-glass="po-line-outstanding"]')) {
      expect(td.getAttribute('data-state')).toBe('none');
    }
  });

  it('gives a draft or cancelled order’s open lines no status (nothing is on its way)', async () => {
    for (const status of ['draft', 'cancelled']) {
      poGet.mockResolvedValue(po(status));
      const view = await page();
      expect(glassCells(view.container), status).toEqual([
        ['200', '120', '80', '—'],
        ['400', '0', '400', '—'],
      ]);
      view.unmount();
    }
  });

  it('puts the glass-only cells between Item and Classic’s column, so no Classic cell changes its place', async () => {
    poGet.mockResolvedValue(po());
    const { container } = await page();
    const row = container.querySelector('[data-testid="po-line"]')!;
    expect(
      [...row.children].map((td) =>
        td.hasAttribute('data-glass-only')
          ? (td.getAttribute('data-glass') ?? 'glass')
          : td.hasAttribute('data-classic-only')
            ? 'classic-only'
            : 'classic',
      ),
    ).toEqual([
      'classic',
      'classic',
      'po-line-ordered',
      'po-line-received',
      'po-line-outstanding',
      'po-line-status',
      'classic-only',
    ]);
  });
});

describe('A purchase order under the off rollout', () => {
  it('renders no glass-only part at all', async () => {
    poGet.mockResolvedValue(po());
    const { container } = await page('off');
    expect(container.querySelectorAll('[data-glass-only]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Receiving progress' })).toBeNull();
  });

  it('renders both under opt-in', async () => {
    poGet.mockResolvedValue(po());
    const { container } = await page('opt-in');
    expect(container.querySelector('[data-glass="po-progress"]')).not.toBeNull();
    expect(glassCells(container)[0]).toHaveLength(4);
  });
});
