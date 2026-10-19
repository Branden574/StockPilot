import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PO's page in the redesign's record layout (page header, Line items in
 * M4's rows, Receipts, Summary, Attachments) keeps what it showed and offered:
 * the PO number as the one h1 with its rename pencil (not on a cancelled PO)
 * and status, the back link, Download PDF, the file actions, Make recurring
 * and the status actions with Mark as ordered last, every line's photo, name,
 * SKU, unit cost, line total, received and ordered quantities, the lines'
 * subtotal beside Receive, and the Summary rows.
 */

const poGet = vi.fn();
const inventoryByIds = vi.fn();
const locationsList = vi.fn();
let role = 'owner';

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
  ItemThumb: ({ alt, imageUrl }: { alt: string; imageUrl: string | null }) => (
    <span data-testid="thumb" data-alt={alt} data-src={imageUrl ?? ''} />
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
  ReceivingService: {
    forCurrentUser: vi.fn(async () => ({
      listForPurchaseOrder: vi.fn(async () => ({ receipts: [], lines: [] })),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [{ id: 'wh-1', name: 'North DC' }]),
    })),
  },
}));
vi.mock('@/server/services/po-attachments', () => ({
  PoAttachmentsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
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

async function renderPage() {
  return render(await PoDetailPage({ params: Promise.resolve({ id: 'po-1' }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  poGet.mockResolvedValue(po());
  inventoryByIds.mockResolvedValue([
    { id: 'item-1', name: 'L4L Polo — Men’s', sku: 'POLO-M', tracking_type: 'none' },
  ]);
  locationsList.mockResolvedValue([
    { id: 'loc-1', name: 'North DC Building', warehouse_id: 'wh-1', kind: null },
  ]);
});

describe('the PO page header', () => {
  it('makes the PO number the one h1, with the status, the supplier and the back link', async () => {
    await renderPage();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('PO-2026-0018');
    expect(screen.getByTestId('status')).toHaveTextContent('partially_received');
    expect(screen.getByRole('link', { name: '← Back to purchase orders' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders',
    );
    // The supplier under the number, and the Summary's Supplier row.
    expect(screen.getAllByText('Lantern Peak School Supply')).toHaveLength(2);
    expect(screen.getByText(/^created /)).toBeInTheDocument();
  });

  it('keeps every action, with the status actions after the files and Mark as ordered last', async () => {
    await renderPage();
    const pdf = screen.getByRole('link', { name: /download pdf/i });
    expect(pdf).toHaveAttribute('href', '/api/purchase-orders/po-1/pdf');
    expect(pdf).toHaveAttribute('target', '_blank');
    const order = [
      pdf,
      screen.getByTestId('file-actions'),
      screen.getByRole('button', { name: 'Make recurring' }),
      screen.getByTestId('po-actions-secondary'),
      screen.getByTestId('po-actions-commit'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `action ${i} follows action ${i - 1}`,
      ).toBeTruthy();
    }
  });

  it('offers the rename pencil until the PO is cancelled', async () => {
    await renderPage();
    expect(screen.getByRole('button', { name: 'Edit PO number' })).toBeInTheDocument();
    poGet.mockResolvedValue(po('cancelled'));
    const cancelled = await renderPage();
    expect(
      within(cancelled.container).queryByRole('button', { name: 'Edit PO number' }),
    ).toBeNull();
  });
});

describe('the PO page lines', () => {
  it('prints each line’s photo, name, SKU, unit cost, line total and received of ordered', async () => {
    await renderPage();
    const [polo, gone] = screen.getAllByTestId('po-line');
    expect(within(polo!).getByTestId('thumb')).toHaveAttribute(
      'data-src',
      'https://img.test/polo-thumb.jpg',
    );
    expect(within(polo!).getByText('L4L Polo — Men’s')).toBeInTheDocument();
    expect(polo!.textContent).toContain('POLO-M · ');
    // What the eye reads, and what a screen reader hears, for the money.
    expect(within(polo!).getByText('$18.00 ea · $3,600.00')).toHaveAttribute('aria-hidden', 'true');
    expect(within(polo!).getByText('Unit cost $18.00, total $3,600.00')).toHaveClass('sr-only');
    expect(polo!.textContent).toContain('Received 120');
    expect(polo!.textContent).toContain('of 200 ordered');
    const bar = polo!.querySelector('[style]') as HTMLElement;
    expect(bar.style.width).toBe('60%');

    // A since-deleted item keeps its line, named as before.
    expect(within(gone!).getByText('Unknown item')).toBeInTheDocument();
    expect((gone!.querySelector('[style]') as HTMLElement).style.width).toBe('0%');
  });

  it('puts the lines’ subtotal beside Receive, and keeps Subtotal and Total in Summary', async () => {
    await renderPage();
    const lines = screen.getByRole('heading', { name: 'Line items' }).closest('section')!;
    expect(lines.textContent).toContain('Subtotal$3,860.00');
    expect(within(lines).getByRole('button', { name: 'Receive items' })).toBeInTheDocument();

    const summary = screen.getByRole('heading', { name: 'Summary' }).closest('section')!;
    const rows = Array.from(summary.querySelectorAll('dt')).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ['Supplier', 'Lantern Peak School Supply'],
      ['Destination', 'North DC Building'],
      ['Expected', '10/9/2026'],
      ['Subtotal', '$3,860.00'],
      ['Total', '$3,910.00'],
    ]);
    expect(within(summary).getByTestId('notes-editor')).toBeInTheDocument();
  });

  it('keeps the Receipts and Attachments sections', async () => {
    await renderPage();
    const receipts = screen.getByRole('heading', { name: 'Receipts' }).closest('section')!;
    expect(within(receipts).getByTestId('receipt-history')).toBeInTheDocument();
    expect(screen.getByTestId('attachments')).toBeInTheDocument();
  });
});
