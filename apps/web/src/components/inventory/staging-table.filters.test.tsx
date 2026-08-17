import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StagingTable, type StagingTableProps } from './staging-table';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

// The item-type tab is the ONE filter that still rides the URL. Everything
// else in this file must leave the router untouched.
const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Capture exactly what the bulk dialog is handed, without opening it.
const bulkPlaceRowsSeen: Array<unknown[]> = [];
vi.mock('@/components/inventory/bulk-place-dialog', () => ({
  BulkPlaceDialog: (props: { rows: unknown[]; trigger: React.ReactNode }) => {
    bulkPlaceRowsSeen.push(props.rows);
    return <div data-testid="bulk-place-dialog">{props.trigger}</div>;
  },
}));

beforeEach(() => {
  routerPush.mockReset();
  bulkPlaceRowsSeen.length = 0;
});

type Row = StagingTableProps['rows'][number];

function makeRow(over: Partial<Row> & { itemId: string; name: string }): Row {
  return {
    sku: `SKU-${over.itemId}`,
    itemType: 'product',
    warehouseId: 'wh1',
    sourceLocationId: 'stg-1',
    sourceKind: 'staging',
    quantity: 5,
    sourceReceiptId: null,
    sourcePoNumber: null,
    receiptNumber: null,
    receivedAt: null,
    ageDays: null,
    barcode: null,
    modelNumber: null,
    bookStorage: null,
    ...over,
  };
}

// The worklist the acceptance criteria describe: A,B on PO-100; C on PO-200;
// D unattributed + unplaced. Book B is 14d (stale) — the rest recent/none.
const A = makeRow({ itemId: 'A', name: 'Acer Chromebook', sku: 'SP-9U4BK-0EK', sourcePoNumber: 'PO-100', receiptNumber: 'RCV-000031', receivedAt: '2026-08-10T00:00:00Z', ageDays: 3 });
const B = makeRow({ itemId: 'B', name: 'Persepolis', sku: 'SP-BOOK-1', itemType: 'book', sourcePoNumber: 'PO-100', receiptNumber: 'RCV-000032', receivedAt: '2026-08-01T00:00:00Z', ageDays: 14, barcode: '9780375714573', bookStorage: { rackNumber: '38', rackRow: 'A', crateColor: 'blue', crateNumber: '4', grade: null, rackLabel: '38-A', crateLabel: 'Blue 4' } });
const C = makeRow({ itemId: 'C', name: 'Whiteboard markers', sku: 'SP-WBM-12', sourcePoNumber: 'PO-200', receiptNumber: 'RCV-000040', receivedAt: '2026-08-12T00:00:00Z', ageDays: 7, sourceLocationId: 'stg-2' });
const D = makeRow({ itemId: 'D', name: 'Loose paperbacks', sku: 'SP-LP-9', itemType: 'book', sourceKind: 'unplaced', sourceLocationId: 'unp-1' });
const ROWS = [A, B, C, D];

const DESTS = { wh1: [{ id: 'r1', name: 'Rack 1', kind: 'rack' as const, rackNumber: '1', rackRow: null, crateColor: null, crateNumber: null }] };

function renderTable(props: Partial<StagingTableProps> = {}) {
  return render(
    <StagingTable
      rows={ROWS}
      destinationsMap={DESTS}
      warehouseNames={{ wh1: 'WH One' }}
      canPlace
      activeItemType="all"
      {...props}
    />,
  );
}

const search = () => screen.getByRole('searchbox', { name: 'Search staging items' });
const count = () => screen.getByTestId('staging-count').textContent;
const rowNames = () =>
  screen
    .getAllByRole('row')
    .slice(1) // header
    .map((r) => within(r).getAllByRole('cell')[canPlaceCellOffset()]!.textContent ?? '');
// The first body cell is the checkbox when canPlace; the name cell follows.
let canPlaceCellOffset = () => 1;

/** Opens a Radix Select by its accessible trigger name and picks an option. */
async function pick(user: ReturnType<typeof userEvent.setup>, triggerName: string, option: string | RegExp) {
  await user.click(screen.getByRole('combobox', { name: triggerName }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

describe('StagingTable filters — search', () => {
  it('narrows the rows as the user types, by name, SKU, PO (partial) and receipt, without touching the router', () => {
    renderTable();
    expect(count()).toBe('4 items');

    fireEvent.change(search(), { target: { value: 'chromebook' } });
    expect(screen.getByText('Acer Chromebook')).toBeInTheDocument();
    expect(screen.queryByText('Persepolis')).not.toBeInTheDocument();
    expect(count()).toBe('1 of 4 items');

    fireEvent.change(search(), { target: { value: 'SP-WBM' } });
    expect(screen.getByText('Whiteboard markers')).toBeInTheDocument();
    expect(count()).toBe('1 of 4 items');

    // "100" matches PO-100 (A and B): the "PO-" prefix need not be typed.
    fireEvent.change(search(), { target: { value: '100' } });
    expect(count()).toBe('2 of 4 items');
    expect(screen.getByText('Acer Chromebook')).toBeInTheDocument();
    expect(screen.getByText('Persepolis')).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: '  rcv-000040 ' } });
    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('Whiteboard markers')).toBeInTheDocument();

    expect(routerPush).not.toHaveBeenCalled();
  });

  it('the clear button empties the search and restores every row', () => {
    renderTable();
    fireEvent.change(search(), { target: { value: 'nothing-here' } });
    expect(count()).toBe('0 of 4 items');
    fireEvent.click(screen.getByRole('button', { name: 'Clear staging search' }));
    expect(count()).toBe('4 items');
    expect(search()).toHaveValue('');
  });
});

describe('StagingTable filters — PO picker + click-to-filter', () => {
  it('lists the POs derived from the rows with counts, most recent first, plus No PO', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await user.click(screen.getByRole('combobox', { name: 'Filter by purchase order' }));
    const options = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['All POs', 'PO-200 (1)', 'PO-100 (2)', 'No PO / Unattributed (1)']);
  });

  it('keeps offering every PO while one is chosen (options come from ALL loaded rows, not the visible ones)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by purchase order', 'PO-200 (1)');
    expect(count()).toBe('1 of 4 items');
    await user.click(screen.getByRole('combobox', { name: 'Filter by purchase order' }));
    const options = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['All POs', 'PO-200 (1)', 'PO-100 (2)', 'No PO / Unattributed (1)']);
  });

  it('choosing a PO shows only that PO; No PO shows only unattributed rows', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by purchase order', 'PO-100 (2)');
    expect(count()).toBe('2 of 4 items');
    expect(screen.getByText('Acer Chromebook')).toBeInTheDocument();
    expect(screen.getByText('Persepolis')).toBeInTheDocument();
    expect(screen.queryByText('Whiteboard markers')).not.toBeInTheDocument();

    await pick(user, 'Filter by purchase order', 'No PO / Unattributed (1)');
    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('Loose paperbacks')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('the No PO chip reads "PO: No PO", never the internal sentinel', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by purchase order', 'No PO / Unattributed (1)');
    const chips = screen.getByTestId('staging-active-filters');
    expect(within(chips).getByText('PO: No PO')).toBeInTheDocument();
    expect(within(chips).queryByText(/__none__/)).not.toBeInTheDocument();
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove filter PO: No PO' }));
    expect(count()).toBe('4 items');
  });

  it('click-to-filter snaps to the picker\'s canonical spelling of the PO', () => {
    // Two rows carry the same PO typed two ways; the picker groups them under
    // whichever spelling it met first (row order), and clicking the OTHER
    // spelling must select that same option, not create an orphan filter value.
    const upper = makeRow({ itemId: 'U', name: 'Upper case PO', sourcePoNumber: 'PO-100', sourceLocationId: 'stg-u' });
    const lower = makeRow({ itemId: 'L', name: 'Lower case PO', sourcePoNumber: 'po-100', sourceLocationId: 'stg-l' });
    renderTable({ rows: [upper, lower, C] });
    fireEvent.click(screen.getByRole('button', { name: 'po-100' }));
    expect(count()).toBe('2 of 3 items');
    expect(screen.getByText('Upper case PO')).toBeInTheDocument();
    expect(screen.getByText('Lower case PO')).toBeInTheDocument();
    // The Select trigger shows the canonical option (with its count), and the chip matches it.
    expect(screen.getByRole('combobox', { name: 'Filter by purchase order' })).toHaveTextContent('PO-100 (2)');
    expect(within(screen.getByTestId('staging-active-filters')).getByText('PO: PO-100')).toBeInTheDocument();
  });

  it('clicking a PO number in a row filters to that PO and does not navigate', () => {
    renderTable();
    const poButton = screen.getAllByRole('button', { name: 'PO-200' })[0]!;
    expect(poButton).toHaveAttribute('title', 'Show all staging items from PO-200');
    fireEvent.click(poButton);

    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('Whiteboard markers')).toBeInTheDocument();
    expect(screen.queryByText('Acer Chromebook')).not.toBeInTheDocument();
    // The chip names the filter that is now active.
    expect(within(screen.getByTestId('staging-active-filters')).getByText('PO: PO-200')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('the PO button is keyboard-operable (Enter / Space) and does not select the row', () => {
    renderTable();
    const poButton = screen.getAllByRole('button', { name: 'PO-100' })[0]!;
    poButton.focus();
    // A native <button type="button"> — Enter/Space fire click. Assert the
    // element type so a future span+onClick rewrite is caught.
    expect(poButton.tagName).toBe('BUTTON');
    expect(poButton).toHaveAttribute('type', 'button');
    fireEvent.click(poButton);
    expect(count()).toBe('2 of 4 items');
    // No row got selected as a side effect: no bulk bar.
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('clicking a receipt number drops it into the search box', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'RCV-000032' }));
    expect(search()).toHaveValue('RCV-000032');
    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('Persepolis')).toBeInTheDocument();
  });
});

describe('StagingTable filters — source and age', () => {
  it('Source: Staged vs Unplaced', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by source', 'Unplaced');
    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('Loose paperbacks')).toBeInTheDocument();
    await pick(user, 'Filter by source', 'Staged');
    expect(count()).toBe('3 of 4 items');
    expect(screen.queryByText('Loose paperbacks')).not.toBeInTheDocument();
  });

  it('Age: Recent keeps 3d and 7d; Stale keeps 14d; a null age shows under neither', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    // Under All, exactly one badge (B at 14d) — C at 7d, ON the boundary, wears none.
    expect(screen.getAllByText('Stale', { selector: 'div' })).toHaveLength(1);
    await pick(user, 'Filter by age', /^Recent/);
    expect(count()).toBe('2 of 4 items');
    expect(screen.getByText('Acer Chromebook')).toBeInTheDocument();
    expect(screen.getByText('Whiteboard markers')).toBeInTheDocument();
    // Badge and filter agree at the boundary: nothing the Recent bucket keeps
    // is badged Stale (a `>=` badge would light up the 7d row here).
    expect(screen.queryByText('Stale', { selector: 'div' })).not.toBeInTheDocument();
    await pick(user, 'Filter by age', /^Stale/);
    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('Persepolis')).toBeInTheDocument();
    // ...and the one row the Stale bucket keeps is the one row wearing the badge.
    expect(screen.getAllByText('Stale', { selector: 'div' })).toHaveLength(1);
  });
});

describe('StagingTable filters — composition, chips, clear', () => {
  it('ANDs search + PO + source + age, and Clear filters resets all four', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // Books tab (server-side) already applied: only the book rows are loaded.
    renderTable({ rows: [B, D], activeItemType: 'book' });
    await pick(user, 'Filter by purchase order', 'PO-100 (1)');
    await pick(user, 'Filter by age', /^Stale/);
    expect(count()).toBe('1 of 2 items');
    expect(screen.getByText('Persepolis')).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: 'Chromebook' } });
    expect(count()).toBe('0 of 2 items');
    expect(screen.getByText('No staging items match these filters.')).toBeInTheDocument();

    const chips = screen.getByTestId('staging-active-filters');
    expect(within(chips).getByText('Search: Chromebook')).toBeInTheDocument();
    expect(within(chips).getByText('PO: PO-100')).toBeInTheDocument();
    expect(within(chips).getByText('Age: Stale')).toBeInTheDocument();

    fireEvent.click(within(chips).getByRole('button', { name: 'Clear filters' }));
    expect(count()).toBe('2 items');
    expect(search()).toHaveValue('');
    expect(screen.queryByTestId('staging-active-filters')).not.toBeInTheDocument();
    // The Books tab is untouched by Clear filters (it is a URL tab, not a chip).
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Books' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a chip removes just its own filter', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by source', 'Staged');
    fireEvent.change(search(), { target: { value: 'PO-100' } });
    expect(count()).toBe('2 of 4 items');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Source: Staged' }));
    expect(count()).toBe('2 of 4 items'); // search alone still hides C and D
    expect(screen.getByText('Search: PO-100')).toBeInTheDocument();
    expect(screen.queryByText('Source: Staged')).not.toBeInTheDocument();
  });
});

describe('StagingTable filters — counts and empty states', () => {
  it('reads "12 of 100 items" for a wide worklist', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      makeRow({ itemId: `i${i}`, name: i < 12 ? `Match ${i}` : `Other ${i}`, sourceLocationId: `loc-${i}` }),
    );
    renderTable({ rows: many });
    expect(count()).toBe('100 items');
    fireEvent.change(search(), { target: { value: 'match' } });
    expect(count()).toBe('12 of 100 items');
  });

  it('true-empty and filtered-empty are distinct, and the toolbar survives both', () => {
    const { unmount } = renderTable({ rows: [] });
    expect(
      screen.getByText('Nothing to place — received (staged) or unplaced stock appears here.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No staging items match these filters.')).not.toBeInTheDocument();
    expect(search()).toBeInTheDocument();
    expect(count()).toBe('0 items');
    unmount();

    renderTable();
    fireEvent.change(search(), { target: { value: 'zzz-no-such-item' } });
    expect(screen.getByText('No staging items match these filters.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to place/)).not.toBeInTheDocument();
    expect(search()).toBeInTheDocument();
    // The empty state carries its own Clear filters (the chip row has one too).
    fireEvent.click(
      within(screen.getByTestId('staging-filtered-empty')).getByRole('button', { name: 'Clear filters' }),
    );
    expect(count()).toBe('4 items');
    expect(screen.getByText('Acer Chromebook')).toBeInTheDocument();
  });
});

describe('StagingTable filters — selection safety', () => {
  it('select-all selects the 5 VISIBLE placeable rows, not all 20', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeRow({ itemId: `i${i}`, name: i < 5 ? `Visible ${i}` : `Hidden ${i}`, sourceLocationId: `loc-${i}` }),
    );
    renderTable({ rows });
    fireEvent.change(search(), { target: { value: 'visible' } });
    expect(count()).toBe('5 of 20 items');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all placeable rows' }));
    expect(screen.getByText('5 selected')).toBeInTheDocument();
    // The bulk dialog was handed exactly those 5 rows.
    const last = bulkPlaceRowsSeen.at(-1) as Array<{ itemId: string }>;
    expect(last.map((r) => r.itemId)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
    // Widening the filter back does NOT resurrect a selection over the other 15.
    fireEvent.change(search(), { target: { value: '' } });
    expect(screen.getByText('5 selected')).toBeInTheDocument();
  });

  it('changing a filter drops selections that are no longer visible', () => {
    renderTable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Acer Chromebook' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Whiteboard markers' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.change(search(), { target: { value: 'chromebook' } });
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // Clear the filter: markers is back on screen but UNselected — the hidden
    // selection was dropped, not parked.
    fireEvent.change(search(), { target: { value: '' } });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Whiteboard markers' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: 'Select Acer Chromebook' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a rows refresh that hides a selected row under the active filter drops it from Place selected and it does not come back on widen', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { rerender } = renderTable();
    await pick(user, 'Filter by age', /^Recent/); // A (3d) and C (7d)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all placeable rows' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // Overnight, C ages to 8d: the next server render hands us fresh rows.
    const agedC = { ...C, ageDays: 8 };
    rerender(
      <StagingTable rows={[A, B, agedC, D]} destinationsMap={DESTS} warehouseNames={{ wh1: 'WH One' }} canPlace activeItemType="all" />,
    );
    // C is no longer visible under Recent, so it is no longer selected — and,
    // above all, not in the bulk payload.
    expect(count()).toBe('1 of 4 items');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect((bulkPlaceRowsSeen.at(-1) as Array<{ itemId: string }>).map((r) => r.itemId)).toEqual(['A']);

    // Widening to Any age brings C back on screen UNselected.
    await pick(user, 'Filter by age', /^Any age/);
    expect(count()).toBe('4 items');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Whiteboard markers' })).toHaveAttribute('aria-checked', 'false');
    expect((bulkPlaceRowsSeen.at(-1) as Array<{ itemId: string }>).map((r) => r.itemId)).toEqual(['A']);
  });

  it('keeps the composite itemId::sourceLocationId identity under a filter', () => {
    // The same item held in staging AND unplaced: two rows, one itemId.
    const staged = makeRow({ itemId: 'X', name: 'Twice-held', sourceLocationId: 'stg-1', sourceKind: 'staging' });
    const unplaced = makeRow({ itemId: 'X', name: 'Twice-held', sourceLocationId: 'unp-1', sourceKind: 'unplaced' });
    renderTable({ rows: [staged, unplaced] });
    // Both rows share a name, so both checkboxes share a label; select the FIRST (staged).
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Twice-held' })[0]!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    const last = bulkPlaceRowsSeen.at(-1) as Array<{ itemId: string; sourceLocationId: string }>;
    expect(last).toEqual([expect.objectContaining({ itemId: 'X', sourceLocationId: 'stg-1' })]);
  });

  it('Place selected receives exactly the visible selected rows with every field intact', () => {
    renderTable();
    fireEvent.change(search(), { target: { value: 'PO-100' } }); // A and B
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all placeable rows' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    const last = bulkPlaceRowsSeen.at(-1);
    expect(last).toEqual([
      { itemId: 'A', name: 'Acer Chromebook', itemType: 'product', sourceLocationId: 'stg-1', quantity: 5, warehouseId: 'wh1', bookStorage: null },
      { itemId: 'B', name: 'Persepolis', itemType: 'book', sourceLocationId: 'stg-1', quantity: 5, warehouseId: 'wh1', bookStorage: B.bookStorage },
    ]);
  });
});

describe('StagingTable filters — type tab and permissions', () => {
  it('the item-type tabs still navigate via the URL (server-side filter)', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Books' }));
    expect(routerPush).toHaveBeenCalledWith('?type=book');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(routerPush).toHaveBeenLastCalledWith('?');
  });

  it('a read-only user (items:read, no stock:transfer) can search and filter but sees no Place controls', () => {
    canPlaceCellOffset = () => 0;
    try {
      renderTable({ canPlace: false });
      fireEvent.change(search(), { target: { value: 'Persepolis' } });
      expect(count()).toBe('1 of 4 items');
      expect(rowNames()).toEqual(['PersepolisSP-BOOK-1staging']);
      expect(screen.queryByRole('button', { name: 'Place' })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      // History stays available.
      expect(screen.getByRole('button', { name: 'View history for Persepolis' })).toBeInTheDocument();
    } finally {
      canPlaceCellOffset = () => 1;
    }
  });
});
