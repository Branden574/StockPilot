import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// EditableMovementNote (the Note cell) calls useRouter on render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/actions/movements', () => ({ editMovementNoteAction: vi.fn() }));

import { MOVEMENT_TYPE_OPTIONS } from '@/lib/movements-filters';

import {
  MOVEMENT_TYPE_TONE,
  MovementsTable,
  movementTypeLabel,
  movementTypeTone,
  type MovementDisplayRow,
} from './movements-table';

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
    createdAtLabel: 'Sep 1, 2026, 5:00 AM',
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

// L7 (owner decision Q1): the When cell prints the time the server page made
// in the ORGANIZATION's zone (toDisplayRow, core formatMovementWhen). It used to
// be <LocalDateTime>, the viewer's zone, filled in after hydration. One cell
// for both page modes, so one pin. The label is a Tokyo time no test runner
// shares, so a viewer-zone rendering beside it would be a second date.
describe('MovementsTable When column (organization zone, L7)', () => {
  it('prints the org-zone time it is handed under the relative time, and no other absolute time', () => {
    render(
      <MovementsTable
        rows={[row({ createdAt: '2026-10-05T05:30:00.000Z', createdAtLabel: 'Oct 5, 2026, 2:30 PM' })]}
      />,
    );
    const when = cellsFor('Copy Paper Case')[0]!;
    expect(within(when).getByText('Oct 5, 2026, 2:30 PM')).toBeInTheDocument();
    expect(screen.getAllByText(/, 2026, /)).toHaveLength(1);
  });

  // The page leaves the label null only when core's formatter cannot read the
  // time; the cell then prints the relative time alone, never a guessed
  // absolute one in the viewer's zone.
  it('a row with no label prints no absolute time rather than a guess', () => {
    render(
      <MovementsTable rows={[row({ createdAt: '2026-10-05T05:30:00.000Z', createdAtLabel: null })]} />,
    );
    const when = cellsFor('Copy Paper Case')[0]!;
    expect(when.querySelectorAll('span')).toHaveLength(0);
    expect(screen.queryAllByText(/, 2026, /)).toHaveLength(0);
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

  // FX5 (DESIGN-SPEC 6.10 movement type tones, 6.16 "the type in its tone"):
  // the type's tone is one exported map, read here and by the Overview's
  // activity rows, so the two pages cannot colour a type differently.
  it('colours each type from the one shared tone map, and any other code in ink 2', () => {
    expect(MOVEMENT_TYPE_TONE).toEqual({
      add: 'accent',
      receive_po: 'accent',
      return: 'accent',
      adjust: 'warning',
      correction: 'warning',
      damage: 'destructive',
      loss: 'destructive',
      remove: 'muted',
      transfer: 'muted',
      initial: 'muted',
    });
    expect(movementTypeTone('bundle_assembly')).toBe('muted');
    expect(movementTypeTone('toString')).toBe('muted');
    const toneClass = {
      accent: 'text-success',
      warning: 'text-warning',
      destructive: 'text-destructive',
      muted: 'text-ink-2',
    } as const;
    const rows = [...MOVEMENT_TYPE_OPTIONS.map((o) => o.value), 'bundle_assembly'].map((type, i) =>
      row({ id: `m-${type}`, movementType: type, itemName: `Item ${i}` }),
    );
    render(<MovementsTable rows={rows} />);
    rows.forEach((r, i) => {
      const label = cellsFor(`Item ${i}`)[2]!.querySelector('[data-movement-type]')!;
      expect(label).toHaveClass(toneClass[movementTypeTone(r.movementType)]);
    });
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
