import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// All server actions the component tree (detail + CreateItemsModal) imports.
vi.mock('@/server/actions/po-imports', () => ({
  approvePoImportAction: vi.fn(),
  cancelPoImportAction: vi.fn(),
  parsePoImportAction: vi.fn(),
  createItemsFromPoLinesAction: vi.fn(),
  findDuplicatesForPoLinesAction: vi.fn(),
  resolvePoImportLineResultsAction: vi.fn(async () => ({ ok: true, data: {} })),
}));

import { PoImportDetail } from './po-import-detail';

import type { ComponentProps } from 'react';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';

const HEADER: PoImportRow = {
  id: 'imp-1',
  organization_id: 'org-1',
  uploaded_by: 'user-1',
  source_type: 'csv',
  extraction_confidence: null,
  extraction_model: null,
  vendor_id: null,
  warehouse_id: null,
  file_name: 'po.csv',
  file_mime_type: 'text/csv',
  file_size: 2048,
  storage_path: 'imports/po.csv',
  sha256: 'abc',
  status: 'parsed',
  parse_error: null,
  approved_po_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as PoImportRow;

const LINE: PoImportLineRow = {
  id: 'line-1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 10,
  uom_original: 'EA',
  description: 'Blue Widget carton',
  unit_cost: 2,
  line_total: 20,
  vendor_item_number: 'V-BW-1',
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
} as PoImportLineRow;

type DetailItems = ComponentProps<typeof PoImportDetail>['items'];

const DEFAULT_ITEMS: DetailItems = [
  { id: 'i1', sku: 'BW-01', name: 'Blue Widget', quantityOnHand: 250, createdAt: '2024-01-01T00:00:00Z' },
  { id: 'i2', sku: 'RW-02', name: 'Red Widget', quantityOnHand: 7, createdAt: '2024-02-01T00:00:00Z' },
];

function renderDetail(
  opts: {
    items?: DetailItems;
    lines?: PoImportLineRow[];
    header?: PoImportRow;
    locations?: Array<{ id: string; name: string; warehouseId: string }>;
  } = {},
) {
  return render(
    <PoImportDetail
      header={opts.header ?? HEADER}
      lines={opts.lines ?? [LINE]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[]}
      locations={opts.locations ?? []}
      items={opts.items ?? DEFAULT_ITEMS}
    />,
  );
}

/** Finds a Radix Select trigger by its rendered text (value or placeholder).
 *  role="combobox" is NOT a name-from-content role, so getByRole({ name })
 *  can't target these triggers. */
function getSelectTrigger(text: RegExp): HTMLElement {
  const trigger = screen
    .getAllByRole('combobox')
    .find((el) => text.test(el.textContent ?? ''));
  if (!trigger) throw new Error(`No select trigger showing ${String(text)}`);
  return trigger;
}

function querySelectTrigger(text: RegExp): HTMLElement | undefined {
  return screen.queryAllByRole('combobox').find((el) => text.test(el.textContent ?? ''));
}

/** Opens a Radix Select by its trigger text and picks an option. */
async function pickFromSelect(
  user: ReturnType<typeof userEvent.setup>,
  triggerText: RegExp,
  optionName: string | RegExp,
) {
  await user.click(getSelectTrigger(triggerText));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: optionName }));
}

describe('PoImportDetail item-match dropdown (issue 1: only name + SKU)', () => {
  it('shows name + SKU per option and NO on-hand counts anywhere in the dropdown', async () => {
    const user = userEvent.setup();
    renderDetail();

    // Open the line's match combobox.
    await user.click(screen.getByRole('button', { name: /pick item/i }));

    const listbox = await screen.findByRole('listbox');
    // Both items are offered with their SKU + name…
    expect(within(listbox).getByText('Blue Widget')).toBeInTheDocument();
    expect(within(listbox).getByText('BW-01')).toBeInTheDocument();
    expect(within(listbox).getByText('Red Widget')).toBeInTheDocument();
    expect(within(listbox).getByText('RW-02')).toBeInTheDocument();
    // …and the on-hand quantities are gone from the option rows.
    expect(within(listbox).queryByText(/on hand/i)).not.toBeInTheDocument();
    expect(within(listbox).queryByText(/250/)).not.toBeInTheDocument();
  });

  it('typing an on-hand-looking number no longer matches items by their stock count', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: /pick item/i }));
    await user.type(screen.getByPlaceholderText(/search by sku or name/i), '250');

    // Neither SKU nor name contains "250" — before the fix, Blue Widget
    // (250 on hand) matched via its detail text.
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
    expect(screen.queryByText('Blue Widget')).not.toBeInTheDocument();
  });
});

// The org's data model allows the same SKU across multiple rows (per-rack
// "duplicate to rack" model), which used to render one dropdown option per
// ROW. The dropdown must collapse those to ONE option per SKU (the oldest
// row), while id lookups still resolve against the FULL items array.
const DUP_SKU = 'SP-8N8LR-8ND';
const DUP_ITEMS: DetailItems = [
  // Newer duplicate FIRST so the test proves createdAt (not input order) wins.
  { id: 'dup-new', sku: DUP_SKU, name: 'Into Algebra 1 (rack copy)', quantityOnHand: 3, createdAt: '2026-05-01T00:00:00Z' },
  { id: 'dup-old', sku: DUP_SKU, name: 'Into Algebra 1', quantityOnHand: 12, createdAt: '2024-03-01T00:00:00Z' },
  { id: 'i2', sku: 'RW-02', name: 'Red Widget', quantityOnHand: 7, createdAt: '2024-02-01T00:00:00Z' },
];

describe('PoImportDetail item-match dropdown (duplicate-SKU rows)', () => {
  it('shows exactly ONE option per duplicated SKU — the OLDEST row — and selecting it targets that row', async () => {
    const user = userEvent.setup();
    renderDetail({ items: DUP_ITEMS });

    await user.click(screen.getByRole('button', { name: /pick item/i }));
    const listbox = await screen.findByRole('listbox');

    // One option for the duplicated SKU, not one per rack row…
    expect(within(listbox).getAllByText(DUP_SKU)).toHaveLength(1);
    // …and it's the oldest row's (its name renders, the newer copy's doesn't).
    expect(within(listbox).getByText('Into Algebra 1')).toBeInTheDocument();
    expect(within(listbox).queryByText('Into Algebra 1 (rack copy)')).not.toBeInTheDocument();

    // Selecting resolves to the oldest row's id: the trigger label is looked
    // up by id in the combobox's items, so the OLD row's name proves the id.
    await user.click(within(listbox).getByText('Into Algebra 1'));
    const trigger = screen.getByRole('button', { name: new RegExp(DUP_SKU) });
    expect(trigger).toHaveTextContent('Into Algebra 1');
    expect(trigger).not.toHaveTextContent('rack copy');
  });

  it('a line pre-matched to a NEWER duplicate row still renders that row in the trigger', async () => {
    const user = userEvent.setup();
    renderDetail({
      items: DUP_ITEMS,
      // Line arrives from the server already matched to the non-oldest dup.
      lines: [{ ...LINE, item_id: 'dup-new' } as PoImportLineRow],
    });

    // The trigger must show the matched row's SKU + name — not the
    // placeholder — even though 'dup-new' isn't in the deduped options.
    const trigger = screen.getByRole('button', { name: new RegExp(DUP_SKU) });
    expect(trigger).toHaveTextContent('Into Algebra 1 (rack copy)');

    // The selected duplicate is appended to the options so it stays visible
    // (and clearable) alongside the canonical oldest row.
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Into Algebra 1 (rack copy)')).toBeInTheDocument();
    expect(within(listbox).getByText('Into Algebra 1')).toBeInTheDocument();
  });
});

// Owner directives 2026-07-08: warehouse selection is an explicit REQUIRED act
// (never seeded from the header), and the 'Warehouse default' pseudo-location
// is gone — a real destination location is required, with an inline notice +
// hard block when the warehouse has no sites.
describe('PoImportDetail approve guards (explicit warehouse + required location)', () => {
  const LOC = { id: 'loc-1', name: 'Dock A', warehouseId: 'wh-1' };
  const MAPPED_LINE = { ...LINE, item_id: 'i1' } as PoImportLineRow;

  it('starts with NO warehouse selected even when the header carries a warehouse_id', () => {
    renderDetail({ header: { ...HEADER, warehouse_id: 'wh-1' } as PoImportRow });

    // The trigger still shows the placeholder — the header id never seeds state.
    const trigger = getSelectTrigger(/pick warehouse/i);
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toHaveTextContent('Main');
  });

  it('approve attempt without vendor/warehouse renders persistent inline alerts and never opens the dialog', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDetail();

    await user.click(screen.getByRole('button', { name: /review & approve/i }));

    const alertText = screen
      .getAllByRole('alert')
      .map((a) => a.textContent)
      .join(' ');
    expect(alertText).toMatch(/pick a vendor before approving/i);
    expect(alertText).toMatch(/pick a destination warehouse before approving/i);
    expect(screen.queryByText(/approve this import\?/i)).not.toBeInTheDocument();
  });

  it("never renders the removed 'Warehouse default' option — not even inside the location dropdown", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDetail({
      header: { ...HEADER, vendor_id: 'sup-1' } as PoImportRow,
      locations: [LOC],
    });

    expect(screen.queryByText(/warehouse default/i)).not.toBeInTheDocument();

    await pickFromSelect(user, /pick warehouse/i, 'Main');
    await user.click(getSelectTrigger(/pick a location/i));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByText(/warehouse default/i)).not.toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Dock A' })).toBeInTheDocument();
  });

  it('approve without a location (while the warehouse has sites) shows an inline alert; picking one clears it and unblocks', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDetail({
      header: { ...HEADER, vendor_id: 'sup-1' } as PoImportRow,
      locations: [LOC],
      lines: [MAPPED_LINE],
    });

    await pickFromSelect(user, /pick warehouse/i, 'Main');
    await user.click(screen.getByRole('button', { name: /review & approve/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      /pick a destination location before approving/i,
    );
    expect(screen.queryByText(/approve this import\?/i)).not.toBeInTheDocument();

    // Picking a location clears the inline error…
    await pickFromSelect(user, /pick a location/i, 'Dock A');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // …and approve now reaches the confirm dialog.
    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    expect(await screen.findByText(/approve this import\?/i)).toBeInTheDocument();
  });

  it('a warehouse with ZERO sites shows the guidance notice in the location slot and blocks approve', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDetail({
      header: { ...HEADER, vendor_id: 'sup-1' } as PoImportRow,
      locations: [], // nothing linked to wh-1
      lines: [MAPPED_LINE],
    });

    await pickFromSelect(user, /pick warehouse/i, 'Main');

    // The location Select is replaced by the guidance notice — no silent fallback.
    expect(
      screen.getByText(/no sites are linked to this warehouse yet — add one under locations first/i),
    ).toBeInTheDocument();
    expect(querySelectTrigger(/pick a location/i)).toBeUndefined();

    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/no sites to receive into/i);
    expect(screen.queryByText(/approve this import\?/i)).not.toBeInTheDocument();
  });
});
