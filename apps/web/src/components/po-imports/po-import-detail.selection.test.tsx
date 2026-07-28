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

vi.mock('@/server/actions/po-imports', () => ({
  approvePoImportAction: vi.fn(),
  cancelPoImportAction: vi.fn(),
  parsePoImportAction: vi.fn(),
  createItemsFromPoLinesAction: vi.fn(),
  findDuplicatesForPoLinesAction: vi.fn(),
  resolvePoImportLineResultsAction: vi.fn(async () => ({ ok: true, data: {} })),
}));

import { PoImportDetail, type LineWithSuggestion } from './po-import-detail';

import type { ComponentProps } from 'react';

import type { PoImportRow } from '@/server/services/po-imports';

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

// Owner's TC1/TC6: two DIFFERENT po_import_lines rows that happen to carry
// the IDENTICAL description/serial text (a real-world duplicate-looking pair
// — e.g. two units of the same model scanned back to back). Every per-line
// control in the table must key off `l.id`, never off description/serial,
// or acting on one row would silently mutate the other.
const SHARED_DESCRIPTION = 'Chromebook 11 G9 — SN: ABC123456';

const LINE_A: LineWithSuggestion = {
  id: 'line-a',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 1,
  uom_original: 'EA',
  description: SHARED_DESCRIPTION,
  unit_cost: 200,
  line_total: 200,
  vendor_item_number: 'V-CB-1',
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: 'itm-cvw',
  suggestionLabel: 'Chromebook · SKU-X · CVW',
  match_status: 'suggested',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
  // Sports variant columns (0301) — null on a non-sports import, which is
  // every line these tests exercise.
  variant_size: null,
  variant_size_original: null,
  variant_size_system: null,
  variant_width: null,
  variant_fit: null,
  variant_color: null,
  jersey_number: null,
  player_name: null,
  group_hint: null,
  serial_hint: null,
  suggested_group_id: null,
  mapping_confidence: null,
};

const LINE_B: LineWithSuggestion = {
  ...LINE_A,
  id: 'line-b',
  line_number: 2,
  // Same description/serial-ish text as line A on purpose (TC1/TC6 fixture).
  description: SHARED_DESCRIPTION,
};

type DetailItems = ComponentProps<typeof PoImportDetail>['items'];

const ITEMS: DetailItems = [
  {
    id: 'itm-cvw',
    sku: 'SKU-X',
    name: 'Chromebook',
    quantityOnHand: 500,
    createdAt: '2024-01-01T00:00:00Z',
  },
];

function renderDetail() {
  return render(
    <PoImportDetail
      header={HEADER}
      lines={[LINE_A, LINE_B]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[]}
      locations={[]}
      items={ITEMS}
    />,
  );
}

/** The two data rows (table header row excluded), in `lines` order. */
function getDataRows(): [HTMLElement, HTMLElement] {
  const rows = screen.getAllByRole('row');
  // rows[0] is the <thead> header row.
  const [rowA, rowB] = rows.slice(1);
  if (!rowA || !rowB) throw new Error('Expected exactly 2 data rows');
  return [rowA, rowB];
}

describe('PoImportDetail per-line selection identity (owner TC1, TC6: keyed on po_import_lines.id, not description/serial)', () => {
  it('TC1: toggling the Skip checkbox on line A does not affect line B, even though both share the same description', async () => {
    const user = userEvent.setup();
    renderDetail();

    const [rowA, rowB] = getDataRows();
    const checkboxA = within(rowA).getByRole('checkbox');
    const checkboxB = within(rowB).getByRole('checkbox');

    expect(checkboxA).not.toBeChecked();
    expect(checkboxB).not.toBeChecked();

    await user.click(checkboxA);

    expect(checkboxA).toBeChecked();
    expect(checkboxB).not.toBeChecked();
  });

  it('TC1 (reverse): toggling Skip on line B does not affect line A', async () => {
    const user = userEvent.setup();
    renderDetail();

    const [rowA, rowB] = getDataRows();
    const checkboxA = within(rowA).getByRole('checkbox');
    const checkboxB = within(rowB).getByRole('checkbox');

    await user.click(checkboxB);

    expect(checkboxB).toBeChecked();
    expect(checkboxA).not.toBeChecked();
  });

  it("TC6: accepting line A's suggestion only resolves line A — line B keeps its own unresolved chip and combobox", async () => {
    const user = userEvent.setup();
    renderDetail();

    const [rowA, rowB] = getDataRows();

    // Both rows start unresolved, each showing its own advisory chip.
    expect(within(rowA).getByText(/possible match/i)).toBeInTheDocument();
    expect(within(rowB).getByText(/possible match/i)).toBeInTheDocument();
    expect(within(rowA).getByRole('button', { name: /pick item/i })).toBeInTheDocument();
    expect(within(rowB).getByRole('button', { name: /pick item/i })).toBeInTheDocument();

    await user.click(within(rowA).getByRole('button', { name: /use existing/i }));

    // Line A resolved: chip gone, combobox now shows the accepted item.
    expect(within(rowA).queryByText(/possible match/i)).not.toBeInTheDocument();
    expect(within(rowA).getByRole('button', { name: /SKU-X/ })).toHaveTextContent('Chromebook');

    // Line B is untouched: still shows its own chip and the create-new
    // placeholder — the accept action did not spill onto the shared
    // description/suggested item.
    expect(within(rowB).getByText(/possible match/i)).toBeInTheDocument();
    expect(within(rowB).getByRole('button', { name: /pick item/i })).toBeInTheDocument();
  });

  it('TC6 (reverse): accepting only line B leaves line A unresolved', async () => {
    const user = userEvent.setup();
    renderDetail();

    const [rowA, rowB] = getDataRows();

    await user.click(within(rowB).getByRole('button', { name: /use existing/i }));

    expect(within(rowB).queryByText(/possible match/i)).not.toBeInTheDocument();
    expect(within(rowB).getByRole('button', { name: /SKU-X/ })).toHaveTextContent('Chromebook');

    expect(within(rowA).getByText(/possible match/i)).toBeInTheDocument();
    expect(within(rowA).getByRole('button', { name: /pick item/i })).toBeInTheDocument();
  });
});
