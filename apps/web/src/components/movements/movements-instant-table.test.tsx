import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MovementsInstantTable, type MovementDisplayRow } from './movements-instant-table';

// Pagination calls useRouter for its link flavor; instant mode drives
// onPageChange instead, but the hook still runs on render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function makeRows(n: number): MovementDisplayRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    itemName: `Item ${i}`,
    itemSku: `SKU-${i}`,
    movementType: 'receive',
    quantityChange: 1,
    movedQuantity: 1,
    newQuantity: 10 + i,
    createdAt: '2026-08-01T12:00:00.000Z',
    actorLabel: 'Someone',
    actorEmail: null,
    note: null,
    noteEditable: false,
    reason: null,
    reasonHref: null,
  })) as unknown as MovementDisplayRow[];
}

describe('MovementsInstantTable pagination', () => {
  // The server-mode page (dashboard/movements/page.tsx) renders a pager both
  // above AND below the table. Instant mode — which is what renders for any
  // ledger under MOVEMENTS_INSTANT_CAP, i.e. the common case — shipped with
  // only the top one, so a user who scrolled through a full page had to scroll
  // back up to advance.
  it('renders a pager above AND below the table when there are rows', () => {
    render(<MovementsInstantTable rows={makeRows(3)} />);

    expect(screen.getAllByRole('button', { name: /Next/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Prev/ })).toHaveLength(2);
  });

  it('keeps both pagers on the same page state', () => {
    render(<MovementsInstantTable rows={makeRows(3)} />);

    // Both read the same `page`/`filtered.length`, so their range text must
    // agree rather than drift.
    const ranges = screen.getAllByText(/Showing/);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.textContent).toBe(ranges[1]!.textContent);
  });

  it('keeps only the top pager when the filtered set is empty', () => {
    // The top controls row (filter bar + export + pager) is deliberately
    // unconditional: a filter that matches nothing must stay visible and
    // clearable. Only the BOTTOM pager is gated on having rows, so an empty
    // result shows exactly one.
    render(<MovementsInstantTable rows={[]} />);

    expect(screen.getAllByRole('button', { name: /Next/ })).toHaveLength(1);
    expect(screen.getByText('No movements match')).toBeTruthy();
  });
});

describe('MovementsInstantTable amount column', () => {
  function transferRow(over: Partial<MovementDisplayRow>): MovementDisplayRow {
    return {
      ...makeRows(1)[0]!,
      movementType: 'transfer',
      ...over,
    };
  }

  /** The Δ column is the 4th cell (When, Item, Type, Δ, After, By, Note). */
  function deltaCellFor(itemName: string): HTMLElement {
    const row = screen.getByText(itemName).closest('tr')!;
    return row.querySelectorAll('td')[3] as HTMLElement;
  }

  // Regression: order picks and manager reopen-reversals are written by
  // adjust_stock as movement_type='transfer' with a REAL signed
  // quantity_change and NO moved_quantity (only transfer_stock stamps
  // moved_quantity). Keying the cell off the TYPE blanked the amount to '—'
  // for every pick while the After column visibly dropped — five units left
  // the building with no number on the audit surface.
  it('shows the signed delta for a pick-shaped transfer (no moved_quantity)', () => {
    render(
      <MovementsInstantTable
        rows={[
          transferRow({ id: 'm-pick', itemName: 'Picked Item', quantityChange: -5, movedQuantity: null, newQuantity: 95 }),
        ]}
      />,
    );

    const cell = deltaCellFor('Picked Item');
    expect(cell.textContent).toBe('-5');
    expect(cell.className).toContain('text-destructive');
  });

  it('shows the signed delta for a reopen-shaped transfer (positive, no moved_quantity)', () => {
    render(
      <MovementsInstantTable
        rows={[
          transferRow({ id: 'm-reopen', itemName: 'Reopened Item', quantityChange: 5, movedQuantity: null, newQuantity: 100 }),
        ]}
      />,
    );

    const cell = deltaCellFor('Reopened Item');
    expect(cell.textContent).toBe('+5');
    expect(cell.className).toContain('text-success');
  });

  // Revert-proof for genuine 0231 location moves: net-zero delta, a real
  // moved_quantity — still the physical qty, still uncoloured.
  it('keeps the moved quantity, neutrally, for a net-zero location transfer', () => {
    render(
      <MovementsInstantTable
        rows={[
          transferRow({ id: 'm-move', itemName: 'Moved Item', quantityChange: 0, movedQuantity: 10, newQuantity: 10 }),
        ]}
      />,
    );

    const cell = deltaCellFor('Moved Item');
    expect(cell.textContent).toBe('10');
    expect(cell.className).not.toContain('text-success');
    expect(cell.className).not.toContain('text-destructive');
  });

  it('renders an em dash when there is neither a delta nor a moved quantity', () => {
    render(
      <MovementsInstantTable
        rows={[
          transferRow({ id: 'm-none', itemName: 'Silent Item', quantityChange: 0, movedQuantity: null, newQuantity: 10 }),
        ]}
      />,
    );

    expect(deltaCellFor('Silent Item').textContent).toBe('—');
  });
});
