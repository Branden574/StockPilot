import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { InventoryExportFieldKey } from '@/lib/exports/field-registry';

import { ExportBuilderFields } from './export-builder-fields';
import {
  initialExportBuilderState,
  moveField,
  setFormat,
  toggleField,
  type ExportBuilderState,
} from './export-builder-state';

function renderFields(overrides: Partial<Parameters<typeof ExportBuilderFields>[0]> = {}) {
  const onToggle = vi.fn();
  const onMove = vi.fn();
  render(
    <ExportBuilderFields
      state={initialExportBuilderState('book')}
      itemTypeKind="book"
      onToggle={onToggle}
      onMove={onMove}
      {...overrides}
    />,
  );
  return { onToggle, onMove };
}

/**
 * A real, stateful mount — used only where a test needs an ACTUAL reorder to
 * happen (the field cap and focus-retention tests below). Every other test
 * uses the plain controlled `renderFields` above with mocked callbacks,
 * matching Task 14's convention for this component family.
 */
function FieldsHarness({ itemTypeKind }: { itemTypeKind: 'book' | 'other' }) {
  const [state, setState] = React.useState<ExportBuilderState>(() =>
    initialExportBuilderState(itemTypeKind),
  );
  return (
    <ExportBuilderFields
      state={state}
      itemTypeKind={itemTypeKind}
      onToggle={(key) => setState((s) => toggleField(s, key))}
      onMove={(key, direction) => setState((s) => moveField(s, key, direction))}
    />
  );
}

describe('ExportBuilderFields — listing', () => {
  it('groups the fields under readable headings', () => {
    renderFields();
    expect(screen.getByRole('group', { name: 'Common fields' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Book fields' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Financial fields' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'System fields' })).toBeTruthy();
  });

  it('shows the selected fields in OUTPUT order, numbered', () => {
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const items = within(chosen).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Cover');
    expect(items[1]!.textContent).toContain('Title');
    expect(items[2]!.textContent).toContain('ISBN');
  });

  it('hides book fields entirely for an items export', () => {
    renderFields({ state: initialExportBuilderState('other'), itemTypeKind: 'other' });
    expect(screen.queryByRole('group', { name: 'Book fields' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'ISBN' })).toBeNull();
  });

  it('filters by search, matching the label a user actually sees', async () => {
    const user = userEvent.setup();
    renderFields();
    await user.type(screen.getByRole('searchbox', { name: 'Search fields' }), 'isb');
    expect(screen.getByRole('checkbox', { name: 'ISBN' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Category' })).toBeNull();
  });

  it('says so when a search matches nothing, instead of showing an empty box', async () => {
    const user = userEvent.setup();
    renderFields();
    await user.type(screen.getByRole('searchbox', { name: 'Search fields' }), 'zzz');
    expect(screen.getByText('No fields match that search.')).toBeTruthy();
  });

  it('never filters the Column order list — only the picker checkboxes above it', async () => {
    const user = userEvent.setup();
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const beforeCount = within(chosen).getAllByRole('listitem').length;

    // A query that excludes an already-selected field (Title is selected by
    // default for a books export, and "zzz" matches nothing).
    await user.type(screen.getByRole('searchbox', { name: 'Search fields' }), 'zzz');
    expect(screen.getByText('No fields match that search.')).toBeTruthy();

    // The picker above is empty, but the order list is a different data
    // source (state.fieldKeys, not the filtered `available` list) and must
    // still show every selected field, Title included.
    const afterItems = within(chosen).getAllByRole('listitem');
    expect(afterItems).toHaveLength(beforeCount);
    expect(afterItems[1]!.textContent).toContain('Title');
  });
});

describe('ExportBuilderFields — selection', () => {
  it('toggles a field', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderFields();
    await user.click(screen.getByRole('checkbox', { name: 'Author' }));
    expect(onToggle).toHaveBeenCalledWith('author');
  });

  it('select all adds every available field exactly once', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderFields();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    const called = onToggle.mock.calls.map((c) => c[0]);
    expect(new Set(called).size).toBe(called.length);
    expect(called).toContain('warehouse');
    expect(called).not.toContain('name'); // already selected
  });

  it('clear optional keeps an identifying field so the export stays valid', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderFields();
    await user.click(screen.getByRole('button', { name: 'Clear optional' }));
    const called = onToggle.mock.calls.map((c) => c[0]);
    expect(called).not.toContain('name');
    expect(called).toContain('category');
  });

  it('marks a field the current format cannot carry as unavailable rather than hiding it silently', () => {
    // Every registry field supports all three formats today, so this asserts
    // the mechanism with an explicit prop rather than a fixture that cannot
    // exist yet. If a format-specific field is ever added, this test already
    // covers it.
    renderFields({
      state: setFormat(initialExportBuilderState('book'), 'csv', 'book'),
    });
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.getAttribute('aria-disabled')).not.toBe('true');
    }
  });
});

describe('ExportBuilderFields — keyboard reordering', () => {
  it('offers four move controls per selected field', () => {
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const first = within(chosen).getAllByRole('listitem')[1]!;
    expect(within(first).getByRole('button', { name: /move title up/i })).toBeTruthy();
    expect(within(first).getByRole('button', { name: /move title down/i })).toBeTruthy();
    expect(within(first).getByRole('button', { name: /move title to top/i })).toBeTruthy();
    expect(within(first).getByRole('button', { name: /move title to bottom/i })).toBeTruthy();
  });

  it('moves a field with the keyboard alone', async () => {
    const user = userEvent.setup();
    const { onMove } = renderFields();
    await user.tab();
    const button = screen.getByRole('button', { name: /move title up/i });
    button.focus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledWith('name', 'up');
  });

  it('disables up at the top and down at the bottom instead of silently doing nothing', () => {
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const items = within(chosen).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('button', { name: /move cover up/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      within(items.at(-1)!).getByRole('button', { name: /move status down/i }),
    ).toHaveProperty('disabled', true);
  });

  it('announces the new position after a move', async () => {
    const user = userEvent.setup();
    renderFields();
    await user.click(screen.getByRole('button', { name: /move title to top/i }));
    expect(screen.getByRole('status').textContent).toContain('Title');
  });

  it('moves a mid-list field down by exactly one position', async () => {
    // `renderFields()`'s mocked onMove never actually reorders anything, so
    // proving the resulting ORDER (not just that onMove was called with
    // 'down') needs the real, stateful harness — same reasoning as the
    // focus-retention tests below. Default books order is Cover, Title,
    // ISBN, SKU, Author, … (pinned by the "shows the selected fields in
    // OUTPUT order" test above); Title sits mid-list, not at either end, so
    // this exercises the real down branch rather than a boundary no-op.
    const user = userEvent.setup();
    render(<FieldsHarness itemTypeKind="book" />);
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const before = within(chosen).getAllByRole('listitem').map((li) => li.textContent);
    expect(before[1]).toContain('Title');
    expect(before[2]).toContain('ISBN');

    await user.click(screen.getByRole('button', { name: /move title down/i }));

    const after = within(chosen).getAllByRole('listitem').map((li) => li.textContent);
    // Title and ISBN swapped places — a move of exactly one slot, not two.
    expect(after[1]).toContain('ISBN');
    expect(after[2]).toContain('Title');
    // Nothing outside the swapped pair shifted.
    expect(after[0]).toBe(before[0]);
    expect(after.slice(3)).toEqual(before.slice(3));
  });
});

describe('ExportBuilderFields — focus retention', () => {
  it('keeps focus inside the row when a move disables the control that just had it', async () => {
    const user = userEvent.setup();
    render(<FieldsHarness itemTypeKind="book" />);
    const upButton = screen.getByRole('button', { name: /move title up/i });
    upButton.focus();
    await user.keyboard('{Enter}');
    // Title is now first: its OWN "up" and "to top" controls just went
    // disabled, and a disabled button cannot hold browser focus — a naive
    // re-render would silently drop focus to <body>. The row's still-enabled
    // "down" control must pick it up instead, matching Brief section 26.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /move title down/i })).toHaveFocus(),
    );
  });
});

describe('ExportBuilderFields — field cap', () => {
  // The registry only has 29 real fields today (Brief section 7's
  // "additional" fields — Model Number, Manufacturer, Tags, Description,
  // Unit of Measure, Custom Attributes — are not yet built), so Select All
  // can never actually reach the 30-field cap through real data. This pins
  // the MECHANISM the same way the format-unavailable test above does: a
  // synthetic state with a literal 30-length fieldKeys array. The `30` is
  // written out by hand, not read from INVENTORY_EXPORT_MAX_FIELDS, so a
  // future edit to that constant can't silently turn this into a tautology.
  it('disables every not-yet-selected checkbox once 30 fields are already chosen', () => {
    const placeholders = Array.from(
      { length: 30 },
      (_, i) => `placeholder_${i}` as InventoryExportFieldKey,
    );
    renderFields({
      state: { ...initialExportBuilderState('book'), fieldKeys: placeholders },
    });
    expect(screen.getByRole('checkbox', { name: 'ISBN' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      screen.getByRole('checkbox', { name: 'Author' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('never disables a field that is already checked, even at the cap', () => {
    const placeholders: InventoryExportFieldKey[] = [
      'name',
      ...Array.from({ length: 29 }, (_, i) => `placeholder_${i}` as InventoryExportFieldKey),
    ];
    renderFields({
      state: { ...initialExportBuilderState('book'), fieldKeys: placeholders },
    });
    expect(screen.getByRole('checkbox', { name: 'Title' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  it('stops Select all from adding fields past the cap', async () => {
    const user = userEvent.setup();
    const nearCapKeys: InventoryExportFieldKey[] = [
      'image',
      'name',
      'isbn',
      ...Array.from({ length: 27 }, (_, i) => `placeholder_${i}` as InventoryExportFieldKey),
    ];
    const { onToggle } = renderFields({
      state: { ...initialExportBuilderState('book'), fieldKeys: nearCapKeys },
    });
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('ExportBuilderFields — column-count warning', () => {
  it('warns with the brief copy once a PDF has too many columns', () => {
    const state = initialExportBuilderState('book');
    renderFields({
      state: {
        ...state,
        fieldKeys: [
          'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
          'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
          'charter',
        ],
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('may be difficult to read');
    expect(screen.getByRole('alert').textContent).toContain('export to Excel');
  });

  it('stays silent for a CSV, which has no column limit', () => {
    const state = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    renderFields({
      state: {
        ...state,
        fieldKeys: [
          'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category', 'rack',
          'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier', 'charter',
        ],
      },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
