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
    const money = within(polo!).getByTestId('po-line-money');
    expect(money).toHaveTextContent(/^\$18\.00 ea · \$3,600\.00$/);
    expect(money).toHaveAttribute('aria-hidden', 'true');
    expect(within(polo!).getByText('Unit cost $18.00, total $3,600.00')).toHaveClass('sr-only');
    expect(polo!.textContent).toContain('Received 120');
    expect(polo!.textContent).toContain('of 200 ordered');
    const bar = polo!.querySelector('[style]') as HTMLElement;
    expect(bar.style.width).toBe('60%');

    // A since-deleted item keeps its line, named as before.
    expect(within(gone!).getByText('Unknown item')).toBeInTheDocument();
    expect((gone!.querySelector('[style]') as HTMLElement).style.width).toBe('0%');
  });

  // FX9 (DESIGN-SPEC 4 and 6.18, line rows "Thumbnail 32"): the line photo
  // was the 28 px sm frame (radius 5) in a 46 px column. It is the 32 px line
  // frame (radius 6) in a 50 px column: the 18 px gutter and the photo.
  it('draws each line photo in the 32 px line frame, in a 50 px column', async () => {
    await renderPage();
    for (const line of screen.getAllByTestId('po-line')) {
      expect(within(line).getByTestId('thumb')).toHaveAttribute('data-size', 'line');
    }
    const table = screen.getAllByTestId('po-line')[0]!.closest('table')!;
    const imageHeader = within(table).getAllByRole('columnheader')[0]!;
    expect(imageHeader).toHaveTextContent('Image');
    expect(imageHeader).toHaveClass('w-[50px]');
    expect(imageHeader).not.toHaveClass('w-[46px]');
  });

  // Review of FX9: with 12 px beside it, the 32 px photo widened the image
  // column on a phone from 58 px (18 + 28 + 12) to 62 px (18 + 32 + 12), so a
  // line whose SKU is an automatic one (SP-XXXXX-XXXXXXX, 16 characters) drew
  // a 328 px table in the 326 px card at 360 px and scrolled 2 px sideways.
  // Below sm the photo's cell keeps 8 px on its right, so the column stays
  // 58 px (18 + 32 + 8); from sm up it keeps the cell's 12 px.
  it('keeps the photo column 58 px wide on a phone: 8 px beside the photo below sm', async () => {
    await renderPage();
    const lines = screen.getAllByTestId('po-line');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const imageCell = within(line).getByTestId('thumb').closest('td')!;
      expect(imageCell).toHaveClass('first:pl-[18px]', 'max-sm:pr-2');
      // Only below sm: no bare pr-2 that would narrow the gap on every screen.
      expect(imageCell).not.toHaveClass('pr-2');
    }
  });

  // FX13 (DESIGN-SPEC 6.11 "a 4 px bar (radius 2 ...)" and section 4 "2
  // (bars)"): the received bar's fill drew its own rounded ends; the
  // reference fill has none, so only the track rounds its start.
  it('draws each line`s received fill square-ended inside its rounded track', async () => {
    await renderPage();
    for (const line of screen.getAllByTestId('po-line')) {
      const fill = line.querySelector('[style]') as HTMLElement;
      expect(fill).toHaveClass('bg-accent', 'h-full');
      expect(fill.className).not.toMatch(/rounded/);
      expect(fill.parentElement).toHaveClass('h-1', 'overflow-hidden', 'rounded-sm');
    }
  });

  it('names the lines table by the card title, once', async () => {
    await renderPage();
    const heading = screen.getByRole('heading', { level: 2, name: 'Line items' });
    expect(heading).toHaveAttribute('id', 'po-line-items-heading');
    const table = screen.getAllByTestId('po-line')[0]!.closest('table')!;
    const regions = screen.getAllByRole('region', { name: 'Line items' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(table.parentElement);
    expect(regions[0]).toContainElement(table);
  });

  it('puts the space after the SKU’s separator outside its no-wrap span, so the line can break there', async () => {
    await renderPage();
    const [polo] = screen.getAllByTestId('po-line');
    // The SKU and its separator stay together; the space after them sits
    // outside the no-wrap span, where the line may break. This checks the
    // markup, not the widths: a long SKU can still widen the table (see
    // LineItems), which is why its scroll area is named.
    const sku = within(polo!).getByText('POLO-M ·');
    expect(sku).toHaveClass('whitespace-nowrap');
    expect(sku.textContent).toBe('POLO-M ·');
    expect(sku.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(sku.nextSibling?.textContent).toBe(' ');
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
