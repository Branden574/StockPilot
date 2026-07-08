import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

function renderDetail(opts: { items?: DetailItems; lines?: PoImportLineRow[] } = {}) {
  return render(
    <PoImportDetail
      header={HEADER}
      lines={opts.lines ?? [LINE]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[]}
      locations={[]}
      items={opts.items ?? DEFAULT_ITEMS}
    />,
  );
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
