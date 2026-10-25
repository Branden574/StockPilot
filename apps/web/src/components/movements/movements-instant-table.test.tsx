import { fireEvent, render, screen } from '@testing-library/react';
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
    render(<MovementsInstantTable rows={makeRows(3)} timeZone="America/Los_Angeles" />);

    expect(screen.getAllByRole('button', { name: /Next/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Prev/ })).toHaveLength(2);
  });

  it('keeps both pagers on the same page state', () => {
    render(<MovementsInstantTable rows={makeRows(3)} timeZone="America/Los_Angeles" />);

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
    render(<MovementsInstantTable rows={[]} timeZone="America/Los_Angeles" />);

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
        timeZone="America/Los_Angeles"
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
        timeZone="America/Los_Angeles"
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
        timeZone="America/Los_Angeles"
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
        timeZone="America/Los_Angeles"
      />,
    );

    expect(deltaCellFor('Silent Item').textContent).toBe('—');
  });
});

// L7 (owner decision Q1): the time each movement prints is the ORGANIZATION's,
// formatted on the server (dashboard/movements/page.tsx) and handed in as text.
// The table used to render <LocalDateTime>, the viewer's zone, after hydration.
// The label below is a Tokyo time no test runner shares, so a viewer-zone
// rendering beside it would be a second, different date.
describe('MovementsInstantTable — movement times (L7)', () => {
  it('prints the org-zone time it is handed, and no viewer-zone time', () => {
    const rows = makeRows(1).map((r) => ({
      ...r,
      createdAt: '2026-10-05T05:30:00.000Z',
      createdAtLabel: 'Oct 5, 2026, 2:30 PM',
    }));
    render(<MovementsInstantTable rows={rows} timeZone="America/Los_Angeles" />);
    expect(screen.getByText('Oct 5, 2026, 2:30 PM')).toBeInTheDocument();
    expect(screen.getAllByText(/, 2026, /)).toHaveLength(1);
  });

  it('a row with no label prints no absolute time rather than a guess', () => {
    const rows = makeRows(1).map((r) => ({ ...r, createdAtLabel: null }));
    render(<MovementsInstantTable rows={rows} timeZone="America/Los_Angeles" />);
    expect(screen.queryAllByText(/, 2026, /)).toHaveLength(0);
  });
});

// Slice 3 review F4: the From and To filter cuts days in the ORGANIZATION's
// zone, the zone the rows' times print in (L7). It cut them at UTC midnight
// with its own inline arithmetic, so From=To=2026-10-10 hid an 18:30 PT
// movement on the 10th and showed one from the evening of the 9th.
describe('MovementsInstantTable — From and To in the organization zone (F4)', () => {
  const rows = [
    { id: 'eve-10', name: 'Evening of the 10th', createdAt: '2026-10-11T01:30:00.000Z' },
    { id: 'eve-9', name: 'Late on the 9th', createdAt: '2026-10-10T06:30:00.000Z' },
    { id: 'early-11', name: 'Just after midnight on the 11th', createdAt: '2026-10-11T07:30:00.000Z' },
    // 01:00 on the 10th in Tokyo; 09:00 on the 9th in Los Angeles.
    { id: 'tokyo-10', name: 'Early on the 10th in Tokyo', createdAt: '2026-10-09T16:00:00.000Z' },
  ].map(({ id, name, createdAt }) => ({ ...makeRows(1)[0]!, id, itemName: name, createdAt, createdAtLabel: null }));

  function pickOneDay(day: string) {
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: day } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: day } });
  }

  it("keeps exactly the movements of the org's day", () => {
    render(<MovementsInstantTable rows={rows} timeZone="America/Los_Angeles" />);
    pickOneDay('2026-10-10');
    expect(screen.getByText('Evening of the 10th')).toBeInTheDocument();
    expect(screen.queryByText('Late on the 9th')).toBeNull();
    expect(screen.queryByText('Just after midnight on the 11th')).toBeNull();
    expect(screen.queryByText('Early on the 10th in Tokyo')).toBeNull();
  });

  it('cuts at the midnight of the zone it is handed', () => {
    render(<MovementsInstantTable rows={rows} timeZone="Asia/Tokyo" />);
    // Tokyo's 10 Oct is 15:00Z on the 9th to 15:00Z on the 10th.
    pickOneDay('2026-10-10');
    expect(screen.getByText('Late on the 9th')).toBeInTheDocument();
    expect(screen.getByText('Early on the 10th in Tokyo')).toBeInTheDocument();
    expect(screen.queryByText('Evening of the 10th')).toBeNull();
  });
});
