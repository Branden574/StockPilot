/**
 * Staging in the redesign (P4.A2, matrix W-BK-06 / 06b): the look moved onto
 * the shared patterns, and these pin what the restyle must keep.
 *
 * - The type filter is the shared segmented control, still a group named
 *   "Item type" of toggle buttons with aria-pressed, and its idle option no
 *   longer hovers in the accent (P2.1 hand-off: accent-foreground on the
 *   accent read 1.71:1 light / 1.66:1 dark; the neutral hover reads 17.13 /
 *   15.03, globals-tokens.test.ts).
 * - Row and header selection run through the shared Checkbox: the tour's
 *   `[role="checkbox"][aria-label="Select all placeable rows"]` and
 *   `main table` anchors still resolve, a selected row carries the selected
 *   tint, and a row without a warehouse cannot be ticked.
 * - The two empty states are the shared state panel, with their words.
 * - The bulk-place bar swaps in over the live count, in a band that always
 *   holds the bar's height, instead of appearing on top of the table: the
 *   table no longer moves down when the first row is ticked (the Items
 *   "zero-shift swap"; before, every row slid down by the bar's height and
 *   the next click missed its checkbox). The filters and chips stay usable.
 * - PO, Source and Age are filter triggers sized to their words, marked
 *   data-active while set, and still the same named comboboxes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams('order=o-1&item=i-1'),
}));

import { StagingTable, type StagingTableProps } from './staging-table';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

type Row = StagingTableProps['rows'][number];

function row(itemId: string, name: string, extra: Partial<Row> = {}): Row {
  return {
    itemId,
    name,
    sku: `SKU-${itemId}`,
    itemType: 'book',
    warehouseId: 'wh1',
    sourceLocationId: `stg-${itemId}`,
    sourceKind: 'staging',
    quantity: 3,
    sourceReceiptId: null,
    sourcePoNumber: 'PO-100',
    receiptNumber: null,
    receivedAt: null,
    ageDays: 9,
    barcode: null,
    modelNumber: null,
    bookStorage: null,
    ...extra,
  };
}

function renderTable(props: Partial<StagingTableProps> = {}) {
  return render(
    <StagingTable
      rows={[row('a', 'Book A'), row('b', 'Book B', { warehouseId: null })]}
      destinationsMap={{ wh1: [] }}
      warehouseNames={{ wh1: 'WH One' }}
      canPlace
      activeItemType="all"
      {...props}
    />,
  );
}

describe('Staging table, redesigned', () => {
  it('the type filter is a group of pressed toggles that pushes ?type= and keeps every other param', () => {
    router.push.mockReset();
    renderTable({ activeItemType: 'book' });
    const group = screen.getByRole('group', { name: 'Item type' });
    const books = within(group).getByRole('button', { name: 'Books' });
    const all = within(group).getByRole('button', { name: 'All' });
    expect(books).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    // The idle option's hover is the neutral one, never the accent fill.
    expect(all.className).not.toMatch(/\bhover:bg-accent\b/);
    expect(all.className).not.toMatch(/\bhover:text-accent-foreground\b/);

    fireEvent.click(within(group).getByRole('button', { name: 'Items' }));
    expect(router.push).toHaveBeenCalledWith('?order=o-1&item=i-1&type=non-book');
  });

  it('keeps the tour anchors and draws selection with the shared checkbox', () => {
    const { container } = renderTable();
    expect(container.querySelector('table')).not.toBeNull();
    const header = container.querySelector(
      '[role="checkbox"][aria-label="Select all placeable rows"]',
    );
    expect(header).not.toBeNull();

    const a = screen.getByRole('checkbox', { name: 'Select Book A' });
    const b = screen.getByRole('checkbox', { name: 'Select Book B' });
    expect(b).toBeDisabled();

    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-checked', 'true');
    expect(a).toHaveAttribute('data-state', 'checked');
    expect(a.closest('tr')).toHaveAttribute('data-state', 'selected');
    expect(b.closest('tr')).not.toHaveAttribute('data-state');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    // Select-all over the placeable rows only: the one row, so it is checked.
    expect(header).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(a.closest('tr')).not.toHaveAttribute('data-state');
  });

  it('the bulk bar offers Place selected only with stock:transfer', () => {
    renderTable({ canPlace: false });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Place selected')).not.toBeInTheDocument();
    // History stays for every reader.
    expect(screen.getAllByRole('button', { name: /View history for/ })).toHaveLength(2);
  });

  it('the empty worklist is the shared empty state with its words', () => {
    renderTable({ rows: [] });
    const panel = screen
      .getByText('Nothing to place — received (staged) or unplaced stock appears here.')
      .closest('[data-slot="state-panel"]');
    expect(panel).toHaveAttribute('data-state-kind', 'empty');
    // Not a heading: the page's only heading level 1 is the title.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('a filter that hides every row is the shared no-match state with Clear filters', () => {
    renderTable();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search staging items' }), {
      target: { value: 'zzz-nothing' },
    });
    const panel = screen.getByTestId('staging-filtered-empty');
    expect(panel).toHaveAttribute('data-state-kind', 'no-match');
    expect(panel).toHaveTextContent('No staging items match these filters.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByTestId('staging-filtered-empty')).not.toBeInTheDocument();
  });
});

describe('Staging files keep the neutral hover (P2.1 hand-off)', () => {
  // Accent hovers and focus fills outside components/ui read below 4.5:1 on
  // the redesign accent; every file of this screen uses the neutral bg-muted.
  const FILES = [
    'staging-table.tsx',
    'staging-table-section.tsx',
    'place-from-staging-dialog.tsx',
    'bulk-place-dialog.tsx',
    'item-history-dialog.tsx',
  ];
  it.each(FILES)('%s has no accent hover or focus fill', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    expect(source).not.toMatch(/(hover|focus|focus-visible):bg-accent\b/);
    expect(source).not.toMatch(/(hover|focus|focus-visible):text-accent-foreground\b/);
  });
});

describe('Staging selection band (the zero-shift bulk bar)', () => {
  const slot = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLElement>(`[data-slot="${name}"]`);

  it('ticking a row swaps the bar in over the count, in the band above the table, so the table does not move', () => {
    const { container } = renderTable({
      rows: [row('a', 'Book A'), row('c', 'Book C', { sourcePoNumber: 'PO-200' })],
    });
    const band = slot(container, 'staging-selection-band')!;
    const card = slot(container, 'staging-table-card')!;
    const countLayer = slot(container, 'staging-count-layer')!;
    expect(band).not.toBeNull();
    // The band sits straight above the table card and holds the live count.
    expect(band.nextElementSibling).toBe(card);
    expect(countLayer.parentElement).toBe(band);
    expect(countLayer).toContainElement(screen.getByTestId('staging-count'));
    expect(countLayer).not.toHaveClass('invisible');
    // It already holds the bar's height (38 px; 46 px below sm, where the
    // bar pads 8 px), so the bar has room before anything is ticked.
    expect(countLayer).toHaveClass('min-h-[38px]', 'max-sm:min-h-[46px]');
    expect(slot(container, 'staging-bulk-bar')).toBeNull();
    const firstRowBefore = card.querySelector('tbody tr');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book A' }));

    const bar = slot(container, 'staging-bulk-bar')!;
    expect(bar).toHaveTextContent('1 selected');
    // The bar lives in the band's one grid cell, over the count layer...
    expect(bar.parentElement).toBe(band);
    expect(bar).toHaveClass('col-start-1', 'row-start-1');
    expect(countLayer).toHaveClass('col-start-1', 'row-start-1', 'invisible');
    // ...never inside the table card or as a new block before it.
    expect(card).not.toContainElement(bar);
    expect(band.nextElementSibling).toBe(card);
    expect(card.querySelector('tbody tr')).toBe(firstRowBefore);
    expect(card.firstElementChild?.querySelector('table')).not.toBeNull();

    // Clear: the bar goes and the count is back in the same place.
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(slot(container, 'staging-bulk-bar')).toBeNull();
    expect(countLayer).not.toHaveClass('invisible');
    expect(screen.getByTestId('staging-count')).toHaveTextContent('2 items');
  });

  it('keeps the search, the filters and the chips usable while rows are ticked', () => {
    const { container } = renderTable({
      rows: [row('a', 'Book A'), row('c', 'Book C', { sourcePoNumber: 'PO-200' })],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book C' }));
    expect(slot(container, 'staging-bulk-bar')).toHaveTextContent('2 selected');

    // Nothing the person filters with is hidden by the swap.
    const search = screen.getByRole('searchbox', { name: 'Search staging items' });
    for (const control of [
      search,
      screen.getByRole('combobox', { name: 'Filter by purchase order' }),
      screen.getByRole('combobox', { name: 'Filter by source' }),
      screen.getByRole('combobox', { name: 'Filter by age' }),
    ]) {
      expect(control.closest('.invisible')).toBeNull();
    }

    // Filtering while ticked still prunes the hidden row (the kept rule),
    // and the chip that says so is outside the band and stays reachable.
    fireEvent.change(search, { target: { value: 'Book C' } });
    expect(slot(container, 'staging-bulk-bar')).toHaveTextContent('1 selected');
    const chips = screen.getByTestId('staging-active-filters');
    expect(chips.closest('[data-slot="staging-selection-band"]')).toBeNull();
    expect(chips.closest('.invisible')).toBeNull();
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove filter Search: Book C' }));
    expect(screen.queryByTestId('staging-active-filters')).not.toBeInTheDocument();
    // Book A was dropped when it was hidden, and does not come back ticked.
    expect(screen.getByRole('checkbox', { name: 'Select Book A' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(slot(container, 'staging-bulk-bar')).toHaveTextContent('1 selected');
  });

  it('draws PO, Source and Age as filter triggers marked active while set, under their names', async () => {
    const user = userEvent.setup();
    renderTable({
      rows: [row('a', 'Book A'), row('c', 'Book C', { sourcePoNumber: 'PO-200' })],
    });
    const po = screen.getByRole('combobox', { name: 'Filter by purchase order' });
    const source = screen.getByRole('combobox', { name: 'Filter by source' });
    const age = screen.getByRole('combobox', { name: 'Filter by age' });
    for (const trigger of [po, source, age]) expect(trigger).not.toHaveAttribute('data-active');
    // The quiet label and the value, as before.
    expect(po).toHaveTextContent('PO:All POs');
    expect(source).toHaveTextContent('Source:All sources');
    expect(age).toHaveTextContent('Age:Any age');

    // Click-to-filter from a row sets the PO filter: its trigger is active.
    fireEvent.click(screen.getAllByRole('button', { name: 'PO-200' })[0]!);
    expect(po).toHaveAttribute('data-active');
    expect(po).toHaveTextContent('PO-200');

    await user.click(source);
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'Unplaced' }),
    );
    expect(source).toHaveAttribute('data-active');
    expect(age).not.toHaveAttribute('data-active');

    // Clear filters: every trigger is idle again.
    fireEvent.click(
      within(screen.getByTestId('staging-active-filters')).getByRole('button', {
        name: 'Clear filters',
      }),
    );
    for (const trigger of [po, source, age]) expect(trigger).not.toHaveAttribute('data-active');
  });
});
