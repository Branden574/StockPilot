import { cleanup, render, screen, within } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { PoListTable, type PoInstantRow } from './po-instant-table';

/**
 * The purchase orders table both list modes draw. Wide, every column has its
 * own cell; in a narrow card (under 640px) po-list.css lays the same cells
 * out as the reference's two lines (the status beside the number, the
 * supplier and the dates under it, the line count under the total). Each
 * value is drawn once (P69-1): the fold used to be a second, hidden copy of
 * the status, the supplier, the dates and the line count in every row. This
 * pins the words of each cell, that no row holds a second copy, the marks
 * the fold reads (data-none, data-one, --po-total-ch), the table's ARIA
 * roles, and that every row keeps exactly its two links to the PO. The
 * stylesheet's own rules are pinned in po-list-css.guard.test.ts.
 */

const ROWS: PoInstantRow[] = [
  {
    id: 'po-1',
    po_number: 'PO-2026-0029',
    supplier_id: 'sup-1',
    status: 'ordered',
    ordered_at: '2026-10-18T17:00:00.000Z',
    created_at: '2026-10-18T16:55:00.000Z',
    expected_at: '2026-10-22T00:00:00.000Z',
    line_count: 4,
    total: 440,
  },
  {
    id: 'po-2',
    po_number: 'PO-2026-0028',
    supplier_id: null,
    status: 'draft',
    ordered_at: null,
    created_at: '2026-10-17T16:55:00.000Z',
    expected_at: null,
    line_count: 1,
    total: 1025,
  },
];

const previousZone = process.env.TZ;
beforeEach(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterEach(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

function rowOf(poNumber: string): HTMLElement {
  return screen.getByRole('link', { name: poNumber }).closest('tr') as HTMLElement;
}

describe('PoListTable', () => {
  it('keeps the eight columns and their words', () => {
    const { container } = render(
      <PoListTable rows={ROWS} supplierNames={{ 'sup-1': 'Lantern Peak School Supply' }} />,
    );
    const headers = Array.from(container.querySelectorAll('th')).map(
      (th) => th.textContent || th.getAttribute('aria-label'),
    );
    expect(headers).toEqual([
      'PO #',
      'Supplier',
      'Status',
      'Placed',
      'Expected',
      'Lines',
      'Total',
      'Open',
    ]);
    const cells = Array.from(rowOf('PO-2026-0029').querySelectorAll('td')).map(
      (td) => td.textContent,
    );
    expect(cells[1]).toBe('Lantern Peak School Supply');
    expect(cells[3]).toBe('Oct 18');
    expect(cells[4]).toBe('Oct 22');
    expect(cells[5]).toBe('4');
  });

  it('gives each row its two links to the PO and nothing else to click', () => {
    render(<PoListTable rows={ROWS} supplierNames={{}} />);
    const row = rowOf('PO-2026-0029');
    const links = within(row).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard/purchase-orders/po-1',
      '/dashboard/purchase-orders/po-1',
    ]);
    expect(within(row).getByRole('link', { name: 'Open PO-2026-0029' })).toBeInTheDocument();
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('draws each value once, in its own cell, with no hidden copy for the fold', () => {
    render(<PoListTable rows={ROWS} supplierNames={{ 'sup-1': 'Lantern Peak School Supply' }} />);
    const ordered = rowOf('PO-2026-0029');
    // Eight cells and nothing else: no paragraph, no span shown only in the fold.
    expect(ordered.children).toHaveLength(8);
    expect(ordered.querySelector('p')).toBeNull();
    expect(ordered.querySelectorAll('[class*="@min-[640px]"]')).toHaveLength(0);
    expect(ordered.querySelectorAll('.hidden')).toHaveLength(0);
    // The status, the supplier and each date once, each in its own column.
    expect(within(ordered).getAllByText('Ordered')).toHaveLength(1);
    expect(within(ordered).getAllByText('Lantern Peak School Supply')).toHaveLength(1);
    expect(within(ordered).getAllByText('Oct 18')).toHaveLength(1);
    expect(within(ordered).getAllByText('Oct 22')).toHaveLength(1);
    expect(within(ordered).getAllByText('4')).toHaveLength(1);
    expect(within(ordered).queryByText(/lines?$/)).toBeNull();
    expect(within(ordered).queryByText(/^Placed|^Expected/)).toBeNull();
    const cells = Array.from(ordered.children);
    expect(within(cells[2] as HTMLElement).getByText('Ordered')).toBeInTheDocument();
    expect(cells[5]).toHaveTextContent(/^4$/);

    // A draft with no supplier and no Placed day: a dash in each of those
    // cells and in Expected, once each.
    const draft = rowOf('PO-2026-0028');
    expect(draft.children).toHaveLength(8);
    expect(within(draft).getAllByText('Draft')).toHaveLength(1);
    expect(within(draft).getAllByText('—')).toHaveLength(3);
  });

  it('marks what the fold leaves out and a single line, and nothing else', () => {
    render(<PoListTable rows={ROWS} supplierNames={{ 'sup-1': 'Lantern Peak School Supply' }} />);
    const flags = (poNumber: string) =>
      Array.from(rowOf(poNumber).children).map((td) =>
        [td.hasAttribute('data-none') ? 'none' : '', td.hasAttribute('data-one') ? 'one' : '']
          .filter(Boolean)
          .join(','),
      );
    // Ordered, with a supplier and a Placed day, 4 lines: nothing left out.
    expect(flags('PO-2026-0029')).toEqual(['', '', '', '', '', '', '', '']);
    // The draft: no supplier and no Placed in the fold (the cells stay, out
    // of sight, for a screen reader); Expected is always drawn; "1 line".
    expect(flags('PO-2026-0028')).toEqual(['', 'none', '', 'none', '', 'one', '', '']);
    // A supplier id with no name is a dash, left out of the fold too.
    cleanup();
    render(<PoListTable rows={ROWS} supplierNames={{}} />);
    expect(flags('PO-2026-0029')[1]).toBe('none');
  });

  it('keeps its table semantics as ARIA roles, since the fold draws it as blocks and flex lines', () => {
    const { container } = render(
      <PoListTable rows={ROWS} supplierNames={{ 'sup-1': 'Lantern Peak School Supply' }} />,
    );
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('role', 'table');
    expect(table).toHaveAttribute('data-slot', 'po-list');
    expect(table.querySelector('thead')).toHaveAttribute('role', 'rowgroup');
    expect(table.querySelector('tbody')).toHaveAttribute('role', 'rowgroup');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    for (const row of container.querySelectorAll('tr')) expect(row).toHaveAttribute('role', 'row');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((th) => th.textContent || th.getAttribute('aria-label'))).toEqual([
      'PO #',
      'Supplier',
      'Status',
      'Placed',
      'Expected',
      'Lines',
      'Total',
      'Open',
    ]);
    for (const row of rows.slice(1)) {
      const cells = within(row).getAllByRole('cell');
      expect(cells).toHaveLength(8);
      for (const td of row.querySelectorAll('td')) expect(td).toHaveAttribute('role', 'cell');
    }
  });

  it("sizes the fold's right-hand column by the longest total, or a wider line count", () => {
    const { container } = render(<PoListTable rows={ROWS} supplierNames={{}} />);
    const table = () => container.querySelector('table') as HTMLTableElement;
    // "$1,025.00" is 9 characters; "4 lines" counts as 1 + 4.
    expect(table().style.getPropertyValue('--po-total-ch')).toBe('9');
    cleanup();
    const small: PoInstantRow[] = [{ ...ROWS[1]!, id: 'po-3', total: 0, line_count: 120 }];
    const second = render(<PoListTable rows={small} supplierNames={{}} />);
    // "$0.00" is 5 characters; "120 lines" counts as 3 + 4.
    expect(
      (second.container.querySelector('table') as HTMLTableElement).style.getPropertyValue(
        '--po-total-ch',
      ),
    ).toBe('7');
  });

  it('sets the number on a line of its own face (top-aligned), as the flex item it was', () => {
    render(<PoListTable rows={ROWS} supplierNames={{}} />);
    const number = screen.getByRole('link', { name: 'PO-2026-0029' });
    expect(number).toHaveClass('align-top', 'font-mono', 'whitespace-nowrap');
  });

  it('prints the total in each row and the footer inside the card', () => {
    const { container } = render(
      <PoListTable
        rows={ROWS}
        supplierNames={{}}
        footer={<div data-testid="pager">Page 1 of 2</div>}
      />,
    );
    expect(within(rowOf('PO-2026-0028')).getByText('$1,025.00')).toBeInTheDocument();
    const card = container.firstElementChild as HTMLElement;
    expect(within(card).getByTestId('pager')).toBeInTheDocument();
  });
});
