import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Radix Select needs pointer-capture APIs happy-dom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));
vi.mock('@/server/actions/po-imports', () => ({
  approvePoImportAction: vi.fn(),
  cancelPoImportAction: vi.fn(),
  parsePoImportAction: vi.fn(),
  createItemsFromPoLinesAction: vi.fn(),
  findDuplicatesForPoLinesAction: vi.fn(),
  resolvePoImportLineResultsAction: vi.fn(async () => ({ ok: true, data: {} })),
  confirmPoImportMappingsAction: vi.fn(),
}));

import { PoImportDetail, type LineWithSuggestion } from './po-import-detail';

import type { ComponentProps } from 'react';

import type { PoImportRow } from '@/server/services/po-imports';
import type { LineResolution } from '@/server/services/po-imports-variants';

/**
 * Task 14 — the review table speaks the result vocabulary, and a line the
 * server could not settle BLOCKS approval. Never "Valid"/"Invalid".
 */

const HEADER: PoImportRow = {
  id: 'imp-1',
  organization_id: 'org-1',
  uploaded_by: 'user-1',
  source_type: 'scan',
  extraction_confidence: 0.95,
  extraction_model: 'claude-sonnet-5',
  vendor_id: 'sup-1',
  warehouse_id: null,
  file_name: 'po.pdf',
  file_mime_type: 'application/pdf',
  file_size: 2048,
  storage_path: 'imports/po.pdf',
  sha256: 'abc',
  status: 'parsed',
  parse_error: null,
  approved_po_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as PoImportRow;

const LINE: LineWithSuggestion = {
  id: 'l1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 6,
  uom_original: 'PAIR',
  description: 'Nike Pegasus 41',
  unit_cost: 90,
  line_total: 540,
  vendor_item_number: null,
  vendor_product_number: 'FD2722',
  auxiliary_number: null,
  coa_code: null,
  item_id: 'itm-1',
  suggested_item_id: null,
  suggestionLabel: null,
  match_status: 'mapped',
  match_confidence: null,
  extraction_confidence: 0.95,
  exception_reason: null,
  variant_size: '10',
  variant_size_original: 'US 10',
  variant_size_system: 'US_MENS',
  variant_width: null,
  variant_fit: null,
  variant_color: null,
  jersey_number: null,
  player_name: null,
  group_hint: 'Nike Pegasus 41',
  serial_hint: null,
  suggested_group_id: null,
  mapping_confidence: null,
};

const RESOLUTION: LineResolution = {
  result: 'add_new_variant',
  groupId: 'grp-1',
  groupName: 'Nike Pegasus 41',
  groupCandidates: [],
  variantItemId: null,
  variantCandidates: [],
  variantKey: 'size=10|system=us_mens',
  message: null,
  errorCode: null,
};

type DetailItems = ComponentProps<typeof PoImportDetail>['items'];
const ITEMS: DetailItems = [
  {
    id: 'itm-1',
    sku: 'SKU-1',
    name: 'Pegasus 41',
    quantityOnHand: 0,
    createdAt: '2024-01-01T00:00:00Z',
  },
];

function renderDetail(opts: {
  line?: Partial<LineWithSuggestion>;
  resolution?: Partial<LineResolution>;
} = {}) {
  const line: LineWithSuggestion = { ...LINE, ...opts.line };
  return render(
    <PoImportDetail
      header={HEADER}
      lines={[line]}
      suppliers={[{ id: 'sup-1', name: 'Acme' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      charters={[]}
      locations={[{ id: 'loc-1', name: 'Dock', warehouseId: 'wh-1' }]}
      items={ITEMS}
      resolutions={{ [line.id]: { ...RESOLUTION, ...opts.resolution } }}
    />,
  );
}

describe('PoImportDetail review vocabulary', () => {
  it('renders Group, Variant and Result columns', () => {
    renderDetail();
    expect(screen.getByRole('columnheader', { name: 'Group' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Variant' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Result' })).toBeInTheDocument();
  });

  it('names the outcome instead of saying Valid/Invalid', () => {
    renderDetail();
    expect(screen.getByText('New variant')).toBeInTheDocument();
    expect(screen.queryByText(/^valid$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^invalid$/i)).not.toBeInTheDocument();
  });

  it('shows the resolved group name and the variant attributes', () => {
    renderDetail();
    expect(screen.getAllByText('Nike Pegasus 41').length).toBeGreaterThan(0);
    expect(screen.getByText('10 US_MENS')).toBeInTheDocument();
  });

  it('renders a uniform number as "#12", never as a serial', () => {
    renderDetail({ line: { jersey_number: '12' } });
    expect(screen.getByText(/#12/)).toBeInTheDocument();
    expect(screen.queryByText(/serial/i)).not.toBeInTheDocument();
  });

  it('flags an ambiguous line and BLOCKS approval until it is resolved', async () => {
    const user = userEvent.setup();
    renderDetail({
      resolution: {
        result: 'ambiguous_variant_match',
        groupId: null,
        groupName: null,
        errorCode: 'AMBIGUOUS_VARIANT_MATCH',
        message: 'Several existing product groups match this line. Pick one.',
        groupCandidates: [
          { id: 'grp-a', name: 'Pegasus 41 Black' },
          { id: 'grp-b', name: 'Pegasus 41 White' },
        ],
      },
    });

    expect(screen.getByText('Ambiguous match')).toBeInTheDocument();
    expect(screen.getByText(/a decision before this import can be approved/i)).toBeInTheDocument();
    // Both candidates are listed — the reviewer picks; nothing is merged.
    expect(screen.getByText(/Pegasus 41 Black/)).toBeInTheDocument();
    expect(screen.getByText(/Pegasus 41 White/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /review & approve/i }));
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringMatching(/need a decision first/i),
    );
  });

  it('offers the mapping-confirmation step for a low-confidence line', () => {
    renderDetail({
      line: { mapping_confidence: 0.4 },
      resolution: {
        result: 'mapping_review_required',
        errorCode: 'IMPORT_MAPPING_REVIEW_REQUIRED',
        message: 'Confirm what the ambiguous column on this line means before importing.',
      },
    });
    expect(screen.getByText(/Confirm what 1 ambiguous column means/i)).toBeInTheDocument();
    expect(screen.getByText(/40% mapping confidence/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm mappings/i })).toBeDisabled();
  });

  it('does not show the mapping step when nothing was flagged', () => {
    renderDetail();
    expect(screen.queryByText(/ambiguous column/i)).not.toBeInTheDocument();
  });

  it('a skipped line stops blocking approval', async () => {
    const user = userEvent.setup();
    renderDetail({
      resolution: {
        result: 'possible_duplicate',
        errorCode: 'POSSIBLE_PRODUCT_GROUP_DUPLICATE',
        message: 'An existing group looks like this one.',
        groupCandidates: [{ id: 'grp-a', name: 'Pegasus 41 Black' }],
      },
    });
    expect(screen.getByText(/a decision before this import can be approved/i)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox'));
    expect(
      screen.queryByText(/a decision before this import can be approved/i),
    ).not.toBeInTheDocument();
  });
});
