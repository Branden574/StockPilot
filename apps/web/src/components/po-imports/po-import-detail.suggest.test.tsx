import { render, screen } from '@testing-library/react';
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

// Line arrives from the server unresolved (item_id null) but carrying a
// barcode/ISBN advisory match — the suggested item + a human-readable label
// page.tsx already resolved from the items lookup (Task 4 scope: the
// component just renders it, never resolves it itself).
const SUGGESTED_LINE: LineWithSuggestion = {
  id: 'l1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 10,
  uom_original: 'EA',
  description: 'Chromebook 11 G9',
  unit_cost: 200,
  line_total: 2000,
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
};

type DetailItems = ComponentProps<typeof PoImportDetail>['items'];

const ITEMS: DetailItems = [
  { id: 'itm-cvw', sku: 'SKU-X', name: 'Chromebook', quantityOnHand: 500, createdAt: '2024-01-01T00:00:00Z' },
];

function renderDetail(opts: { line?: Partial<LineWithSuggestion> } = {}) {
  const line: LineWithSuggestion = { ...SUGGESTED_LINE, ...opts.line };
  return render(
    <PoImportDetail
      header={HEADER}
      lines={[line]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[]}
      locations={[]}
      items={ITEMS}
    />,
  );
}

describe('PoImportDetail advisory "Possible match" chip (matching is advisory-only)', () => {
  it('shows a "Possible match" chip and does NOT pre-select the item', () => {
    renderDetail();

    expect(screen.getByText(/possible match/i)).toBeInTheDocument();
    expect(screen.getByText(/Chromebook · SKU-X · CVW/)).toBeInTheDocument();

    // The combobox trigger still shows the create-new default (placeholder),
    // never the suggested item — accepting the chip is the ONLY way in.
    expect(screen.getByRole('button', { name: /pick item/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SKU-X/ })).not.toBeInTheDocument();
  });

  it('does NOT show the chip once the line is already resolved (item_id set)', () => {
    renderDetail({ line: { item_id: 'itm-other' } });
    expect(screen.queryByText(/possible match/i)).not.toBeInTheDocument();
  });

  it('does NOT show the chip for a line with no suggestion at all', () => {
    renderDetail({ line: { suggested_item_id: null, suggestionLabel: null } });
    expect(screen.queryByText(/possible match/i)).not.toBeInTheDocument();
  });

  it('clicking "Use existing" links the line to the suggested item and the chip disappears', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: /use existing/i }));

    // The chip is gone — the line is now resolved...
    expect(screen.queryByText(/possible match/i)).not.toBeInTheDocument();
    // ...and the combobox trigger now shows the accepted suggestion, proving
    // setLineItem(l.id, suggested_item_id) ran (an explicit link, not a
    // silent auto-select — this only happens after the user's click).
    expect(screen.getByRole('button', { name: /SKU-X/ })).toHaveTextContent('Chromebook');
  });
});
