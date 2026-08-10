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
