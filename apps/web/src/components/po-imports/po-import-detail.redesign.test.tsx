// @vitest-environment happy-dom
/**
 * The review in the redesign (P4.C1, matrix W-PU-07):
 *
 * - The Skip box is the shared Checkbox now (owner: "make sure our check
 *   boxes ... work in the redesign"): one box per line, named by its line
 *   number, keyed by the line's id (two lines with the same words are two
 *   boxes), and read-only once the import is approved or canceled.
 * - Ticking Skip still sends `skip: true` for that line id only.
 * - The two placement sections keep their separate headings, and each field
 *   is named by its label.
 * - The stock impact figures sit in one stat strip with their words.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { approvePoImportAction } = vi.hoisted(() => ({ approvePoImportAction: vi.fn() }));

vi.mock('@/server/actions/po-imports', () => ({
  approvePoImportAction,
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

function renderDetail(
  header: PoImportRow = HEADER,
  lines: LineWithSuggestion[] = [LINE_A, LINE_B],
) {
  return render(
    <PoImportDetail
      header={header}
      lines={lines}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[{ id: 'ch-1', name: 'Harbor Ridge' }]}
      locations={[{ id: 'loc-1', name: 'North DC', warehouseId: 'wh-1' }]}
      items={ITEMS}
    />,
  );
}

beforeEach(() => {
  approvePoImportAction.mockReset();
});

describe('PoImportDetail Skip boxes (shared Checkbox, keyed by line id)', () => {
  it('draws one named Skip box per line and toggles only its own line', async () => {
    const user = userEvent.setup();
    renderDetail();
    const skipA = screen.getByRole('checkbox', { name: 'Skip line 1' });
    const skipB = screen.getByRole('checkbox', { name: 'Skip line 2' });
    expect(skipA).not.toBeChecked();
    await user.click(skipA);
    expect(skipA).toBeChecked();
    expect(skipB).not.toBeChecked();
    await user.click(skipA);
    expect(skipA).not.toBeChecked();
  });

  it('can be toggled from the keyboard', async () => {
    const user = userEvent.setup();
    renderDetail();
    const skipB = screen.getByRole('checkbox', { name: 'Skip line 2' });
    skipB.focus();
    await user.keyboard(' ');
    expect(skipB).toBeChecked();
  });

  it('is read-only once the import is approved', () => {
    renderDetail({ ...HEADER, status: 'approved' } as PoImportRow);
    expect(screen.getByRole('checkbox', { name: 'Skip line 1' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Skip line 2' })).toBeDisabled();
  });

  it('sends skip: true for the ticked line id only when approving', async () => {
    const user = userEvent.setup();
    // Line B is mapped, line A is skipped: nothing is unmapped, so approve opens.
    renderDetail(HEADER, [LINE_A, { ...LINE_B, item_id: 'itm-cvw' }]);
    await user.click(screen.getByRole('checkbox', { name: 'Skip line 1' }));

    await user.click(screen.getByRole('combobox', { name: 'Vendor' }));
    await user.click(await screen.findByRole('option', { name: 'Acme' }));
    await user.click(screen.getByRole('combobox', { name: 'Destination warehouse' }));
    await user.click(await screen.findByRole('option', { name: 'Main' }));
    await user.click(screen.getByRole('combobox', { name: 'Destination location' }));
    await user.click(await screen.findByRole('option', { name: 'North DC' }));

    approvePoImportAction.mockResolvedValue({ ok: true, data: { poId: 'po-9' } });
    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    await user.click(await screen.findByRole('button', { name: /approve & create po/i }));

    expect(approvePoImportAction).toHaveBeenCalledTimes(1);
    const payload = approvePoImportAction.mock.calls[0]![0] as {
      lineOverrides: Array<{ lineId: string; skip: boolean }>;
    };
    expect(payload.lineOverrides).toEqual([{ lineId: 'line-a', itemId: null, skip: true }]);
  });
});

describe('PoImportDetail placement sections and preview (redesign)', () => {
  it('keeps operational placement and billing as two headed sections with named fields', () => {
    renderDetail();
    expect(screen.getByRole('heading', { name: 'Operational placement' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Billing — does not affect placement' }),
    ).toBeInTheDocument();
    for (const name of [
      'Vendor',
      'Destination warehouse',
      'Create new items as',
      'Destination location',
    ]) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
    // Exact names: the help button beside each label must not join the field's name.
    expect(
      screen.getByRole('combobox', { name: 'Charter for items (ownership)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Bill to charter (optional)' }),
    ).toBeInTheDocument();
    // jsdom's name algorithm skips a nested button's aria-label, but browsers add it
    // ("... What is Charter for items?"), so the help buttons must sit beside the
    // labels, never inside them.
    for (const name of ['What is Charter for items?', 'What is Bill to charter?']) {
      expect(screen.getByRole('button', { name }).closest('label')).toBeNull();
    }
    expect(screen.getByLabelText('Expected delivery (optional)')).toHaveAttribute('type', 'date');
    // Never pre-seeded: the warehouse starts unpicked and the location waits for it.
    expect(screen.getByRole('combobox', { name: 'Destination warehouse' })).toHaveTextContent(
      'Pick warehouse',
    );
    expect(screen.getByRole('combobox', { name: 'Destination location' })).toBeDisabled();
  });

  it('shows the four stock impact figures with their words', () => {
    renderDetail();
    const heading = screen.getByRole('heading', { name: 'Stock impact preview' });
    const section = heading.closest('section')!;
    for (const label of ['Items affected', 'Units inbound', 'Unmapped', 'Total cost']) {
      expect(within(section).getByText(label)).toBeInTheDocument();
    }
    // Its heading names the preview table's scroll region; the import's page
    // title (titleId="po-import-title") names the lines table's.
    const [lines, preview] = screen.getAllByRole('table');
    expect(preview!.parentElement).toHaveAttribute('aria-labelledby', heading.id);
    expect(lines!.parentElement).toHaveAttribute('aria-labelledby', 'po-import-title');
    // The page lists Stock impact preview once: the section is not a region too.
    const regions = screen.getAllByRole('region', { name: 'Stock impact preview' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(preview!.parentElement);
  });
});
