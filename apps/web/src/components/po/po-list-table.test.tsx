import { render, screen, within } from '@testing-library/react';
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
 * own cell; in a narrow card the Supplier, Status, Placed, Expected and Lines
 * columns hide and the row folds into the reference's two lines (the status
 * beside the number, the supplier and the dates under it, the line count
 * under the total). Both stay in the DOM, so this pins the words of each and
 * that every row keeps exactly its two links to the PO.
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

  it('folds the supplier and the dates under the number, and the line count under the total', () => {
    render(<PoListTable rows={ROWS} supplierNames={{ 'sup-1': 'Lantern Peak School Supply' }} />);
    const ordered = rowOf('PO-2026-0029');
    expect(
      within(ordered).getByText('Lantern Peak School Supply · Placed Oct 18 · Expected Oct 22'),
    ).toBeInTheDocument();
    expect(within(ordered).getByText('4 lines')).toBeInTheDocument();
    // The status label beside the number as well as in its own column.
    expect(within(ordered).getAllByText('Ordered')).toHaveLength(2);

    // A draft with no supplier and no dates: no supplier, no Placed, one line.
    const draft = rowOf('PO-2026-0028');
    expect(within(draft).getByText('Expected —')).toBeInTheDocument();
    expect(within(draft).getByText('1 line')).toBeInTheDocument();
    expect(within(draft).getAllByText('—').length).toBeGreaterThanOrEqual(3);
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
