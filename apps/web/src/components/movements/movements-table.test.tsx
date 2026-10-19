import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// EditableMovementNote (the Note cell) calls useRouter on render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/actions/movements', () => ({ editMovementNoteAction: vi.fn() }));

import { MOVEMENT_TYPE_OPTIONS } from '@/lib/movements-filters';

import { MovementsTable, movementTypeLabel, type MovementDisplayRow } from './movements-table';

function row(over: Partial<MovementDisplayRow> = {}): MovementDisplayRow {
  return {
    id: 'm-1',
    movementType: 'receive_po',
    quantityChange: 12,
    newQuantity: 40,
    movedQuantity: null,
    reason: null,
    reasonHref: null,
    note: null,
    noteEditable: true,
    createdAt: '2026-09-01T12:00:00.000Z',
    itemName: 'Copy Paper Case',
    itemSku: 'PAP-CASE-01',
    actorLabel: 'Avery Stone',
    actorEmail: 'avery@test.local',
    ...over,
  };
}

/** The cells of the row that holds `itemName`, in column order. */
function cellsFor(itemName: string): HTMLElement[] {
  const tr = screen.getByText(itemName).closest('tr');
  if (!tr) throw new Error(`no row for ${itemName}`);
  return Array.from(tr.querySelectorAll('td'));
}

describe('MovementsTable columns', () => {
  it('keeps the seven columns in order: When, Item, Type, Δ, After, By, Note', () => {
    render(<MovementsTable rows={[row()]} />);
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['When', 'Item', 'Type', 'Δ', 'After', 'By', 'Note']);
  });

  it('prints the item name with its SKU under it, and no photo on any row', () => {
    const { container } = render(<MovementsTable rows={[row()]} />);
    const item = cellsFor('Copy Paper Case')[1]!;
    expect(within(item).getByText('Copy Paper Case')).toBeInTheDocument();
    expect(within(item).getByText('PAP-CASE-01')).toBeInTheDocument();
    // No per-row photos (CONFLICTS M2): the ledger reads no images.
    expect(container.querySelector('img')).toBeNull();
  });

  it('prints an em dash for an item it cannot name, and no SKU line', () => {
    render(<MovementsTable rows={[row({ itemName: null, itemSku: null })]} />);
    const item = screen.getAllByRole('row')[1]!.querySelectorAll('td')[1]!;
    expect(item.textContent).toBe('—');
  });

  it('prints the actor, and the email under it only when the row has one', () => {
    render(
      <MovementsTable
        rows={[
          row(),
          row({ id: 'm-2', itemName: 'Pencil Box', actorLabel: 'System', actorEmail: null }),
        ]}
      />,
    );
    expect(cellsFor('Copy Paper Case')[5]!.textContent).toBe('Avery Stoneavery@test.local');
    expect(cellsFor('Pencil Box')[5]!.textContent).toBe('System');
  });

  it('prints the on-hand After figure', () => {
    render(<MovementsTable rows={[row({ newQuantity: 1250 })]} />);
    expect(cellsFor('Copy Paper Case')[4]!.textContent).toBe('1,250');
  });
});

describe('MovementsTable type column', () => {
  it('names each of the 10 real types with the words the type filter uses', () => {
    const rows = MOVEMENT_TYPE_OPTIONS.map((opt, i) =>
      row({ id: `m-${opt.value}`, movementType: opt.value, itemName: `Item ${i}` }),
    );
    render(<MovementsTable rows={rows} />);
    MOVEMENT_TYPE_OPTIONS.forEach((opt, i) => {
      const type = cellsFor(`Item ${i}`)[2]!;
      expect(type.textContent).toBe(opt.label);
      expect(type.querySelector(`[data-movement-type="${opt.value}"]`)).not.toBeNull();
    });
  });

  it('names a code outside the 10 (the bundle types the database allows) in words, never as a raw code', () => {
    expect(movementTypeLabel('bundle_assembly')).toBe('Bundle assembly');
    expect(movementTypeLabel('bundle_distribution')).toBe('Bundle distribution');
    expect(movementTypeLabel('bundle_shortage')).toBe('Bundle shortage');
    render(<MovementsTable rows={[row({ movementType: 'bundle_distribution' })]} />);
    expect(cellsFor('Copy Paper Case')[2]!.textContent).toBe('Bundle distribution');
  });

  it('keeps a word on every type, so its colour is never the only cue', () => {
    render(<MovementsTable rows={[row({ movementType: 'damage' })]} />);
    const label = cellsFor('Copy Paper Case')[2]!.querySelector('[data-movement-type]')!;
    expect(label.textContent).toBe('Damage');
    // The dot beside the word is decoration only.
    expect(label.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('MovementsTable amount column (one rule for both page modes)', () => {
  it('shows a signed, coloured delta', () => {
    render(
      <MovementsTable
        rows={[
          row({ id: 'in', itemName: 'In Item', quantityChange: 12 }),
          row({ id: 'out', itemName: 'Out Item', movementType: 'remove', quantityChange: -3 }),
        ]}
      />,
    );
    const inCell = cellsFor('In Item')[3]!;
    expect(inCell.textContent).toBe('+12');
    expect(inCell.className).toContain('text-success');
    const outCell = cellsFor('Out Item')[3]!;
    expect(outCell.textContent).toBe('-3');
    expect(outCell.className).toContain('text-destructive');
  });

  it('shows the signed delta for a pick-shaped transfer (a real delta, no moved quantity)', () => {
    render(
      <MovementsTable
        rows={[row({ movementType: 'transfer', quantityChange: -5, movedQuantity: null })]}
      />,
    );
    const cell = cellsFor('Copy Paper Case')[3]!;
    expect(cell.textContent).toBe('-5');
    expect(cell.className).toContain('text-destructive');
  });

  it('shows the moved quantity, uncoloured, for a net-zero location transfer', () => {
    render(
      <MovementsTable
        rows={[row({ movementType: 'transfer', quantityChange: 0, movedQuantity: 10 })]}
      />,
    );
    const cell = cellsFor('Copy Paper Case')[3]!;
    expect(cell.textContent).toBe('10');
    expect(cell.className).not.toContain('text-success');
    expect(cell.className).not.toContain('text-destructive');
  });

  it('shows an em dash when there is neither a delta nor a moved quantity', () => {
    render(<MovementsTable rows={[row({ quantityChange: 0, movedQuantity: null })]} />);
    expect(cellsFor('Copy Paper Case')[3]!.textContent).toBe('—');
  });
});

describe('MovementsTable note column', () => {
  it('offers the note editor only with the permission and on an editable row', () => {
    const { rerender } = render(<MovementsTable rows={[row()]} canEditNotes />);
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();

    rerender(<MovementsTable rows={[row()]} canEditNotes={false} />);
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();

    // A receipt-line row's note is system-managed: read only even for an editor.
    rerender(<MovementsTable rows={[row({ noteEditable: false })]} canEditNotes />);
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
  });

  it('links a reason that names an order to that order', () => {
    render(
      <MovementsTable
        rows={[
          row({
            movementType: 'transfer',
            quantityChange: -2,
            reason: 'Order pick (SO-000060)',
            reasonHref: '/dashboard/orders/ord-60',
          }),
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Order pick (SO-000060)' })).toHaveAttribute(
      'href',
      '/dashboard/orders/ord-60',
    );
  });
});

describe('MovementsTable footer', () => {
  it('draws the pager it is handed as the card footer, and nothing without one', () => {
    const { container, rerender } = render(
      <MovementsTable rows={[row()]} footer={<nav aria-label="Test pager" />} />,
    );
    const footer = container.querySelector('[data-slot="movements-table-footer"]');
    expect(footer).not.toBeNull();
    expect(
      within(footer as HTMLElement).getByRole('navigation', { name: 'Test pager' }),
    ).toBeTruthy();

    rerender(<MovementsTable rows={[row()]} />);
    expect(container.querySelector('[data-slot="movements-table-footer"]')).toBeNull();
  });
});
