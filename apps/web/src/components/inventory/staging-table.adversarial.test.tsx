// ADVERSARIAL VERIFIER SUITE (independent of the builder's tests).
// 20-row fixture: 3 POs (6/5/4), 5 unattributed rows, both sourceKinds,
// ages 3/7/8/14 + null, books + items, ONE item (I1) with TWO source
// holdings (staging + unplaced) so the composite key is exercised.
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StagingTable, type StagingTableProps } from './staging-table';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const routerPush = vi.fn();
const routerReplace = vi.fn();
let currentSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: vi.fn() }),
  useSearchParams: () => currentSearchParams,
}));

const bulkPlaceRowsSeen: Array<unknown[]> = [];
vi.mock('@/components/inventory/bulk-place-dialog', () => ({
  BulkPlaceDialog: (props: { rows: unknown[]; trigger: React.ReactNode }) => {
    bulkPlaceRowsSeen.push(props.rows);
    return <div data-testid="bulk-place-dialog">{props.trigger}</div>;
  },
}));

beforeEach(() => {
  routerPush.mockReset();
  routerReplace.mockReset();
  bulkPlaceRowsSeen.length = 0;
  currentSearchParams = new URLSearchParams();
});

type Row = StagingTableProps['rows'][number];

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-17T12:00:00Z');
const daysAgo = (d: number, hourOffset = 0) => new Date(NOW - d * DAY + hourOffset * 3_600_000).toISOString();

function row(over: Partial<Row> & { itemId: string; name: string }): Row {
  return {
    sku: `SKU-${over.itemId}`,
    itemType: 'product',
    warehouseId: 'wh1',
    sourceLocationId: 'stg-A',
    sourceKind: 'staging',
    quantity: 2,
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

const PERSEPOLIS_STORAGE = { rackNumber: '38', rackRow: 'A', crateColor: 'blue', crateNumber: '4', grade: null, rackLabel: '38-A', crateLabel: 'Blue 4' };

// PO-1092: R1 R2 R3 R4 R17 R19 (6) | PO-2000: R5..R9 (5) | PO-3000: R10..R13 (4) | none: R14 R15 R16 R18 R20 (5)
const R1 = row({ itemId: 'I1', name: 'Acer ChromeBook 314', sku: 'SP-ACB-314', sourcePoNumber: 'PO-1092', receiptNumber: 'RCV-000101', receivedAt: daysAgo(3, 2), ageDays: 3, quantity: 3 });
const R2 = row({ itemId: 'I2', name: 'Persepolis', sku: 'SP-BOOK-2', itemType: 'book', sourcePoNumber: 'PO-1092', receiptNumber: 'RCV-000101', receivedAt: daysAgo(7), ageDays: 7, barcode: '9780375714573', bookStorage: PERSEPOLIS_STORAGE });
const R3 = row({ itemId: 'I3', name: 'Whiteboard markers', sku: 'SP-WBM-12', sourcePoNumber: 'PO-1092', receiptNumber: 'RCV-000102', receivedAt: daysAgo(8), ageDays: 8 });
const R4 = row({ itemId: 'I4', name: 'HP Laptop 15', sku: 'SP-HP-15', sourcePoNumber: 'PO-1092', receiptNumber: 'RCV-000103', receivedAt: daysAgo(14), ageDays: 14, modelNumber: 'HP-15-DY2795', sourceLocationId: 'stg-B' });
const R5 = row({ itemId: 'I5', name: 'Dell Monitor 24', sku: 'SP-DM-24', sourcePoNumber: 'PO-2000', receiptNumber: 'RCV-000110', receivedAt: daysAgo(3, 1), ageDays: 3, sourceLocationId: 'stg-B' });
const R6 = row({ itemId: 'I6', name: 'Maus', sku: 'SP-BOOK-6', itemType: 'book', sourcePoNumber: 'PO-2000', receiptNumber: 'RCV-000110', receivedAt: daysAgo(7), ageDays: 7, barcode: '9780394747231', sourceLocationId: 'stg-B' });
const R7 = row({ itemId: 'I7', name: 'Stapler', sku: 'SP-STP-1', sourcePoNumber: 'PO-2000', receiptNumber: 'RCV-000111', receivedAt: daysAgo(8), ageDays: 8, sourceLocationId: 'stg-B' });
const R8 = row({ itemId: 'I8', name: 'Packing tape', sku: 'SP-TAPE-1', sourcePoNumber: 'PO-2000', receiptNumber: 'RCV-000112', receivedAt: daysAgo(14), ageDays: 14, sourceLocationId: 'stg-B' });
const R9 = row({ itemId: 'I9', name: 'Glue sticks', sku: 'SP-GLUE-1', sourcePoNumber: 'PO-2000', receiptNumber: 'RCV-000113', receivedAt: daysAgo(3), ageDays: 3, sourceLocationId: 'stg-B' });
const R10 = row({ itemId: 'I10', name: 'Rulers', sku: 'SP-RUL-1', sourcePoNumber: 'PO-3000', receiptNumber: 'RCV-000120', receivedAt: daysAgo(3, 6), ageDays: 3, sourceLocationId: 'stg-C', quantity: 40 });
const R11 = row({ itemId: 'I11', name: 'Spiral notebooks', sku: 'SP-NB-1', sourcePoNumber: 'PO-3000', receiptNumber: 'RCV-000120', receivedAt: daysAgo(7), ageDays: 7, sourceLocationId: 'stg-C', quantity: 12 });
const R12 = row({ itemId: 'I12', name: 'Pencils', sku: 'SP-PEN-1', sourcePoNumber: 'PO-3000', receiptNumber: 'RCV-000121', receivedAt: daysAgo(8), ageDays: 8, sourceLocationId: 'stg-C', quantity: 144 });
const R13 = row({ itemId: 'I13', name: 'The Hobbit', sku: 'SP-BOOK-13', itemType: 'book', sourcePoNumber: 'PO-3000', receiptNumber: 'RCV-000122', receivedAt: daysAgo(14), ageDays: 14, barcode: '9780547928227', sourceLocationId: 'stg-C', quantity: 6, bookStorage: { rackNumber: '12', rackRow: 'B', crateColor: 'red', crateNumber: '2', grade: null, rackLabel: '12-B', crateLabel: 'Red 2' } });
const R14 = row({ itemId: 'I14', name: 'Loose paperbacks', sku: 'SP-LP-9', itemType: 'book', sourceKind: 'unplaced', sourceLocationId: 'unp-1' });
const R15 = row({ itemId: 'I15', name: 'Folding chairs', sku: 'SP-CHR-1', sourceKind: 'unplaced', sourceLocationId: 'unp-1' });
// Composite: SAME item as R1, second holding in unplaced.
const R16 = row({ itemId: 'I1', name: 'Acer ChromeBook 314', sku: 'SP-ACB-314', sourceKind: 'unplaced', sourceLocationId: 'unp-1', quantity: 1 });
// PO-1092 row with NO warehouse: visible but never placeable.
const R17 = row({ itemId: 'I17', name: 'Standing desk', sku: 'SP-DESK-1', sourcePoNumber: 'PO-1092', receiptNumber: 'RCV-000104', receivedAt: daysAgo(3), ageDays: 3, sourceLocationId: 'stg-C', warehouseId: null });
const R18 = row({ itemId: 'I18', name: 'Desk lamp', sku: 'SP-LAMP-1', sourceKind: 'unplaced', sourceLocationId: 'unp-1', receivedAt: daysAgo(3), ageDays: 3 });
const R19 = row({ itemId: 'I19', name: 'Projector', sku: 'SP-PRJ-1', sourcePoNumber: 'PO-1092', receiptNumber: 'RCV-000105', receivedAt: daysAgo(8), ageDays: 8, sourceLocationId: 'stg-C' });
const R20 = row({ itemId: 'I20', name: 'HDMI cables', sku: 'SP-HDMI-1', receivedAt: daysAgo(14), ageDays: 14, sourceLocationId: 'stg-A' });

const ROWS: Row[] = [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20];

const DESTS = { wh1: [{ id: 'r1', name: 'Rack 1', kind: 'rack' as const, rackNumber: '1', rackRow: null, crateColor: null, crateNumber: null }] };

function renderTable(props: Partial<StagingTableProps> = {}) {
  return render(
    <StagingTable rows={ROWS} destinationsMap={DESTS} warehouseNames={{ wh1: 'WH One' }} canPlace activeItemType="all" {...props} />,
  );
}

const search = () => screen.getByRole('searchbox', { name: 'Search staging items' });
const count = () => screen.getByTestId('staging-count').textContent;
const bodyRows = () => screen.getAllByRole('row').slice(1);
const rowCheckbox = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` });
const checkedRowNames = () =>
  screen
    .getAllByRole('checkbox')
    .filter((c) => c.getAttribute('aria-checked') === 'true' && c.getAttribute('aria-label') !== 'Select all placeable rows')
    .map((c) => c.getAttribute('aria-label')!.replace(/^Select /, ''));

async function pick(user: ReturnType<typeof userEvent.setup>, triggerName: string, option: string | RegExp) {
  await user.click(screen.getByRole('combobox', { name: triggerName }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

const toBulk = (r: Row) => ({
  itemId: r.itemId,
  name: r.name,
  itemType: r.itemType,
  sourceLocationId: r.sourceLocationId,
  quantity: r.quantity,
  warehouseId: r.warehouseId,
  bookStorage: r.bookStorage,
});

describe('VERIFY fixture sanity', () => {
  it('renders 20 rows, 20 items, no router traffic', () => {
    renderTable();
    expect(bodyRows()).toHaveLength(20);
    expect(count()).toBe('20 items');
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });
});

describe('VERIFY selection safety', () => {
  it('select 10, filter to PO-3000 (4 visible): selection is exactly the visible 4 and BulkPlaceDialog gets exactly those 4 rows intact', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    // R1 is the STAGING twin of I1 (rendered first); pick it explicitly.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select Acer ChromeBook 314' })[0]!);
    for (const r of [R10, R11, R12, R13, R2, R3, R5, R6, R7]) fireEvent.click(rowCheckbox(r.name));
    expect(checkedRowNames()).toHaveLength(10);
    expect(screen.getByText('10 selected')).toBeInTheDocument();

    await pick(user, 'Filter by purchase order', /^PO-3000 \(4\)$/);
    expect(count()).toBe('4 of 20 items');
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText('4 selected')).toBeInTheDocument();
    expect(checkedRowNames().sort()).toEqual(['Pencils', 'Rulers', 'Spiral notebooks', 'The Hobbit'].sort());

    // The LAST render's payload is what the dialog would open with.
    const payload = bulkPlaceRowsSeen.at(-1) as ReturnType<typeof toBulk>[];
    expect(payload).toHaveLength(4);
    expect(payload).toEqual([R10, R11, R12, R13].map(toBulk));
    // Field-level: types, quantities, source locations, book storage REFERENCE intact.
    expect(payload.map((p) => p.itemType)).toEqual(['product', 'product', 'product', 'book']);
    expect(payload.map((p) => p.quantity)).toEqual([40, 12, 144, 6]);
    expect(payload.every((p) => p.sourceLocationId === 'stg-C' && p.warehouseId === 'wh1')).toBe(true);
    expect(payload[3]!.bookStorage).toBe(R13.bookStorage);
    // No hidden row leaked into the payload.
    expect(payload.some((p) => ['I1', 'I2', 'I3', 'I5', 'I6', 'I7'].includes(p.itemId))).toBe(false);

    // Clear filters does NOT resurrect the 6 dropped selections.
    fireEvent.click(screen.getByRole('button', { name: /Remove filter PO: PO-3000/ }));
    expect(count()).toBe('20 items');
    expect(checkedRowNames().sort()).toEqual(['Pencils', 'Rulers', 'Spiral notebooks', 'The Hobbit'].sort());
    expect(screen.getByText('4 selected')).toBeInTheDocument();
    expect(bulkPlaceRowsSeen.at(-1)).toEqual([R10, R11, R12, R13].map(toBulk));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('select-all under PO-1092 selects only the 5 visible PLACEABLE rows (not the no-warehouse row, not hidden rows); clearing keeps 5', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by purchase order', /^PO-1092 \(6\)$/);
    expect(bodyRows()).toHaveLength(6);
    expect(rowCheckbox('Standing desk')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all placeable rows' }));
    expect(checkedRowNames().sort()).toEqual(['Acer ChromeBook 314', 'HP Laptop 15', 'Persepolis', 'Projector', 'Whiteboard markers'].sort());
    expect(screen.getByText('5 selected')).toBeInTheDocument();
    const payload = bulkPlaceRowsSeen.at(-1) as ReturnType<typeof toBulk>[];
    expect(payload).toEqual([R1, R2, R3, R4, R19].map(toBulk));

    // Now clear filters via the "Clear filters" link: still exactly 5, and the
    // composite twin of I1 (unplaced) is NOT selected.
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(count()).toBe('20 items');
    expect(screen.getByText('5 selected')).toBeInTheDocument();
    const cbs = screen.getAllByRole('checkbox', { name: 'Select Acer ChromeBook 314' });
    expect(cbs).toHaveLength(2);
    expect(cbs.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    // Header select-all is now unchecked (not all 20 placeable are selected).
    expect(screen.getByRole('checkbox', { name: 'Select all placeable rows' })).toHaveAttribute('aria-checked', 'false');
  });

  it('search that hides a selected row drops it; typing back the same text does not bring it back', () => {
    renderTable();
    fireEvent.click(rowCheckbox('Stapler'));
    fireEvent.click(rowCheckbox('Pencils'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: 'pencil' } });
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: '' } });
    expect(bodyRows()).toHaveLength(20);
    expect(checkedRowNames()).toEqual(['Pencils']);
    expect(rowCheckbox('Stapler')).toHaveAttribute('aria-checked', 'false');
  });

  it('composite rows (same itemId, two source holdings) select independently and the payload carries the right sourceLocationId', () => {
    renderTable();
    const twins = screen.getAllByRole('checkbox', { name: 'Select Acer ChromeBook 314' });
    expect(twins).toHaveLength(2);
    fireEvent.click(twins[1]!); // the UNPLACED holding (R16)
    expect(twins.map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(bulkPlaceRowsSeen.at(-1)).toEqual([toBulk(R16)]);
    fireEvent.click(twins[0]!);
    expect(bulkPlaceRowsSeen.at(-1)).toEqual([toBulk(R1), toBulk(R16)]);
    // Source=Unplaced hides R1 -> only R16 stays selected.
  });

  it('Source = Unplaced keeps only the unplaced twin selected', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    const twins = screen.getAllByRole('checkbox', { name: 'Select Acer ChromeBook 314' });
    fireEvent.click(twins[0]!);
    fireEvent.click(twins[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await pick(user, 'Filter by source', 'Unplaced');
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(bulkPlaceRowsSeen.at(-1)).toEqual([toBulk(R16)]);
    fireEvent.click(screen.getByRole('button', { name: /Remove filter Source: Unplaced/ }));
    expect(bodyRows()).toHaveLength(20);
    expect(bulkPlaceRowsSeen.at(-1)).toEqual([toBulk(R16)]);
  });
});

describe('VERIFY search', () => {
  it('"1092" -> the six PO-1092 rows; "  ChromeBook  " trims + case-folds -> both I1 holdings; empty -> all', () => {
    renderTable();
    fireEvent.change(search(), { target: { value: '1092' } });
    expect(count()).toBe('6 of 20 items');
    expect(bodyRows()).toHaveLength(6);
    for (const n of ['Acer ChromeBook 314', 'Persepolis', 'Whiteboard markers', 'HP Laptop 15', 'Standing desk', 'Projector']) {
      expect(screen.getAllByText(n).length).toBeGreaterThan(0);
    }
    fireEvent.change(search(), { target: { value: '  ChromeBook  ' } });
    expect(count()).toBe('2 of 20 items');
    expect(screen.getAllByText('Acer ChromeBook 314')).toHaveLength(2);
    fireEvent.change(search(), { target: { value: '  chromebook  ' } });
    expect(count()).toBe('2 of 20 items');
    fireEvent.change(search(), { target: { value: '   ' } });
    expect(count()).toBe('20 items');
    fireEvent.change(search(), { target: { value: '' } });
    expect(count()).toBe('20 items');
  });

  it('regex characters are literal: ".*[" matches nothing and never throws; "(" and "\\" likewise', () => {
    renderTable();
    for (const q of ['.*[', 'PO-1(', '\\', '[', '.*', '^$']) {
      expect(() => fireEvent.change(search(), { target: { value: q } })).not.toThrow();
      expect(count()).toBe(`0 of 20 items`);
      expect(screen.getByTestId('staging-filtered-empty')).toBeInTheDocument();
    }
    // A literal "." IS a substring of "HP-15-DY2795"? No. But "SP-" is on all SKUs.
    fireEvent.change(search(), { target: { value: 'sp-' } });
    expect(count()).toBe('20 items');
  });

  it('searches barcode (ISBN) and model number too', () => {
    renderTable();
    fireEvent.change(search(), { target: { value: '9780375714573' } });
    expect(count()).toBe('1 of 20 items');
    expect(screen.getByText('Persepolis')).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: 'hp-15-dy' } });
    expect(count()).toBe('1 of 20 items');
    expect(screen.getByText('HP Laptop 15')).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: 'RCV-000110' } });
    expect(count()).toBe('2 of 20 items');
  });

  it('typing 10 characters makes ZERO network requests and ZERO navigations', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call during search');
    });
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {
      throw new Error('xhr during search');
    });
    try {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderTable();
      const before = fetchSpy.mock.calls.length;
      await user.type(search(), 'chromebook');
      expect(search()).toHaveValue('chromebook');
      expect(count()).toBe('2 of 20 items');
      expect(fetchSpy.mock.calls.length - before).toBe(0);
      expect(xhrOpen).not.toHaveBeenCalled();
      expect(routerPush).not.toHaveBeenCalled();
      expect(routerReplace).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      xhrOpen.mockRestore();
    }
  });
});

describe('VERIFY PO picker', () => {
  it('options derived from rows only (zero fetch), counts per PO exact, newest first, No PO present with its count', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call while building PO options');
    });
    try {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderTable();
      await user.click(screen.getByRole('combobox', { name: 'Filter by purchase order' }));
      const names = within(await screen.findByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent);
      // PO-3000's newest receipt is 6h later than PO-1092's, which is 1h later than PO-2000's.
      expect(names).toEqual(['All POs', 'PO-3000 (4)', 'PO-1092 (6)', 'PO-2000 (5)', 'No PO / Unattributed (5)']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('No PO filters to the 5 unattributed rows (both sourceKinds included)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by purchase order', /No PO \/ Unattributed \(5\)/);
    expect(count()).toBe('5 of 20 items');
    for (const n of ['Loose paperbacks', 'Folding chairs', 'Desk lamp', 'HDMI cables']) {
      expect(screen.getByText(n)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Acer ChromeBook 314')).toHaveLength(1); // only the unplaced twin
    expect(screen.getByText('PO: No PO')).toBeInTheDocument();
  });

  it('clicking a PO number in a row sets the filter, shows the chip, and NEVER pushes the router; PO options still list all POs', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    const poButtons = screen.getAllByRole('button', { name: 'PO-2000' });
    expect(poButtons).toHaveLength(5);
    expect(poButtons[0]).toHaveAttribute('title', 'Show all staging items from PO-2000');
    fireEvent.click(poButtons[0]!);
    expect(count()).toBe('5 of 20 items');
    expect(screen.getByText('PO: PO-2000')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    // The picker reflects the click and still offers every PO.
    const trigger = screen.getByRole('combobox', { name: 'Filter by purchase order' });
    expect(trigger).toHaveTextContent('PO-2000');
    await user.click(trigger);
    const names = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['All POs', 'PO-3000 (4)', 'PO-1092 (6)', 'PO-2000 (5)', 'No PO / Unattributed (5)']);
  });

  it('a PO click while another PO filter is active REPLACES it (does not AND to zero)', () => {
    renderTable();
    fireEvent.click(screen.getAllByRole('button', { name: 'PO-2000' })[0]!);
    expect(count()).toBe('5 of 20 items');
    // Only PO-2000 rows visible now, so no PO-3000 button exists — set via search then click.
    fireEvent.change(search(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Remove filter PO: PO-2000/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'PO-3000' })[0]!);
    expect(count()).toBe('4 of 20 items');
    expect(screen.queryByText('PO: PO-2000')).not.toBeInTheDocument();
    expect(screen.getByText('PO: PO-3000')).toBeInTheDocument();
  });

  it('receipt click drops the receipt into the search box (2 rows share RCV-000101)', () => {
    renderTable();
    fireEvent.click(screen.getAllByRole('button', { name: 'RCV-000101' })[0]!);
    expect(search()).toHaveValue('RCV-000101');
    expect(count()).toBe('2 of 20 items');
    expect(routerPush).not.toHaveBeenCalled();
  });
});

describe('VERIFY age buckets', () => {
  it('Recent = ages 3 and 7 (9 rows); Stale = ages 8 and 14 (8 rows); null ages appear only under Any age', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by age', /Recent/);
    expect(count()).toBe('9 of 20 items');
    expect(screen.getByText('Persepolis')).toBeInTheDocument(); // 7d
    expect(screen.getByText('Spiral notebooks')).toBeInTheDocument(); // 7d
    expect(screen.queryByText('Whiteboard markers')).not.toBeInTheDocument(); // 8d
    expect(screen.queryByText('Loose paperbacks')).not.toBeInTheDocument(); // null
    expect(screen.queryByText('Folding chairs')).not.toBeInTheDocument(); // null

    await pick(user, 'Filter by age', /Stale/);
    expect(count()).toBe('8 of 20 items');
    expect(screen.getByText('Whiteboard markers')).toBeInTheDocument(); // 8d
    expect(screen.getByText('HDMI cables')).toBeInTheDocument(); // 14d
    expect(screen.queryByText('Persepolis')).not.toBeInTheDocument(); // 7d is NOT stale
    expect(screen.queryByText('Loose paperbacks')).not.toBeInTheDocument(); // null
    // Every visible Stale row carries the Stale badge; the count of badges equals rows.
    expect(screen.getAllByText('Stale', { selector: 'div,span' }).filter((e) => e.textContent === 'Stale').length).toBeGreaterThanOrEqual(8);

    await pick(user, 'Filter by age', 'Any age');
    expect(count()).toBe('20 items');
  });

  it('badge and bucket agree: rows without a Stale badge are exactly the Recent + null rows', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    await pick(user, 'Filter by age', /Recent/);
    for (const r of bodyRows()) {
      expect(within(r).queryByText('Stale')).not.toBeInTheDocument();
    }
    await pick(user, 'Filter by age', /Stale/);
    for (const r of bodyRows()) {
      expect(within(r).getByText('Stale')).toBeInTheDocument();
    }
  });
});

describe('VERIFY composition, empty states, permissions, type tab', () => {
  it('search + PO + source + age AND together, and each chip removes only its own filter', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable();
    fireEvent.change(search(), { target: { value: 'sp-' } });
    await pick(user, 'Filter by purchase order', /^PO-2000/);
    await pick(user, 'Filter by source', 'Staged');
    await pick(user, 'Filter by age', /Stale/);
    expect(count()).toBe('2 of 20 items'); // Stapler (8d), Packing tape (14d)
    expect(screen.getByTestId('staging-active-filters').textContent).toContain('Search: sp-');
    fireEvent.click(screen.getByRole('button', { name: /Remove filter Age: Stale/ }));
    expect(count()).toBe('5 of 20 items');
    fireEvent.click(screen.getByRole('button', { name: /Remove filter PO: PO-2000/ }));
    expect(count()).toBe('16 of 20 items'); // all staging rows
    fireEvent.click(screen.getByRole('button', { name: /Remove filter Source: Staged/ }));
    expect(count()).toBe('20 items');
    expect(screen.getByRole('button', { name: /Remove filter Search: sp-/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(screen.queryByTestId('staging-active-filters')).not.toBeInTheDocument();
    expect(search()).toHaveValue('');
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('true-empty vs filtered-empty are distinct and the toolbar is present in both', () => {
    const { unmount } = renderTable({ rows: [] });
    expect(screen.getByText(/Nothing to place/)).toBeInTheDocument();
    expect(screen.queryByTestId('staging-filtered-empty')).not.toBeInTheDocument();
    expect(search()).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by purchase order' })).toBeInTheDocument();
    expect(count()).toBe('0 items');
    unmount();

    renderTable();
    fireEvent.change(search(), { target: { value: 'no-such-thing' } });
    expect(screen.getByTestId('staging-filtered-empty')).toHaveTextContent('No staging items match these filters.');
    expect(screen.queryByText(/Nothing to place/)).not.toBeInTheDocument();
    expect(search()).toHaveValue('no-such-thing');
    expect(screen.getByRole('combobox', { name: 'Filter by age' })).toBeInTheDocument();
    expect(count()).toBe('0 of 20 items');
    // The empty-state's own Clear filters button restores everything.
    fireEvent.click(within(screen.getByTestId('staging-filtered-empty')).getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(20);
  });

  it('items:read without stock:transfer: search works, zero Place buttons, zero checkboxes, History for every row', () => {
    renderTable({ canPlace: false });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Place' })).toHaveLength(0);
    expect(screen.queryByText('Place selected')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /View history for/ })).toHaveLength(20);
    fireEvent.change(search(), { target: { value: 'book' } });
    // ChromeBook x2 (name), SP-BOOK-2/6/13 (sku), Spiral notebooks (name) = 6
    expect(count()).toBe('6 of 20 items');
  });

  it('read-only user: PO/source/age selects filter as for anyone else', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable({ canPlace: false });
    await pick(user, 'Filter by purchase order', /^PO-3000/);
    expect(count()).toBe('4 of 20 items');
    await pick(user, 'Filter by age', /Stale/);
    expect(count()).toBe('2 of 20 items');
    await pick(user, 'Filter by source', 'Unplaced');
    expect(count()).toBe('0 of 20 items');
    expect(screen.queryAllByRole('button', { name: 'Place' })).toHaveLength(0);
  });

  it('Type tabs round-trip through ?type= (router.push) and preserve other params; Clear filters never touches the URL', () => {
    currentSearchParams = new URLSearchParams('warehouse=abc');
    renderTable({ activeItemType: 'book' });
    const books = screen.getByRole('button', { name: 'Books' });
    expect(books).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Items' }));
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenLastCalledWith('?warehouse=abc&type=non-book');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(routerPush).toHaveBeenLastCalledWith('?warehouse=abc');
    routerPush.mockClear();
    // Client filters + clear: no navigation.
    fireEvent.change(search(), { target: { value: 'x' } });
    // Two Clear filters controls exist on a zero-match (chip row + empty state); both are client-only.
    const clears = screen.getAllByRole('button', { name: /Clear filters/ });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[0]!);
    expect(count()).toBe('20 items');
    fireEvent.change(search(), { target: { value: 'x' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Clear filters/ })[1]!);
    expect(count()).toBe('20 items');
    expect(routerPush).not.toHaveBeenCalled();
    // The Books tab is still highlighted (client filters do not touch it).
    expect(books).toHaveAttribute('aria-pressed', 'true');
  });
});
