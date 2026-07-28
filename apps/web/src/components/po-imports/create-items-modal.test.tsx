import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const createItemsFromPoLinesAction = vi.fn();
const findDuplicatesForPoLinesAction = vi.fn();

vi.mock('@/server/actions/po-imports', () => ({
  createItemsFromPoLinesAction: (...args: unknown[]) => createItemsFromPoLinesAction(...args),
  findDuplicatesForPoLinesAction: (...args: unknown[]) => findDuplicatesForPoLinesAction(...args),
  resolvePoImportLineResultsAction: vi.fn(async () => ({ ok: true, data: {} })),
}));

import { CreateItemsModal } from './create-items-modal';

import type { PoImportLineRow } from '@/server/services/po-imports';

// The line whose vendor part number matches an existing CVW-charter item's
// barcode. Every item this feature creates sets barcode = vendor_item_number,
// so the NEXT time anyone orders the same part (even under a different
// charter, e.g. KVA), the duplicate scan comes back with a 'barcode' hit
// against that pre-existing item. Matching must stay advisory: left at its
// default, this line must still CREATE a new item under the chosen charter,
// not silently link to (merge into) the other charter's item.
const LINE: PoImportLineRow = {
  id: 'line-cb-1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 10,
  uom_original: 'EA',
  description: 'Chromebook 11 G9 (V-CB-1)',
  unit_cost: 200,
  line_total: 2000,
  vendor_item_number: 'V-CB-1',
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
} as PoImportLineRow;

function renderModal() {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  render(
    <CreateItemsModal
      open
      onOpenChange={onOpenChange}
      poImportId="imp-1"
      vendorId="sup-1"
      warehouseId="wh-1"
      charterId="chr-kva"
      locationId={null}
      itemType="product"
      lines={[LINE]}
      categories={[]}
      onSuccess={onSuccess}
    />,
  );
  return { onOpenChange, onSuccess };
}

describe('CreateItemsModal duplicate matching stays advisory', () => {
  it('leaves a barcode-matched line in CREATE mode by default — confirming must not auto-link to the existing item', async () => {
    const user = userEvent.setup();
    findDuplicatesForPoLinesAction.mockResolvedValue({
      ok: true,
      data: {
        matches: {
          [LINE.id]: [
            {
              id: 'itm-cvw-existing',
              name: 'Chromebook 11 G9',
              sku: 'SKU-X',
              barcode: 'V-CB-1',
              quantityOnHand: 500,
              matchType: 'barcode',
            },
          ],
        },
      },
    });
    createItemsFromPoLinesAction.mockResolvedValue({
      ok: true,
      data: { created: 1, mapped: 0, linked: 0, skipped: 0 },
    });

    renderModal();

    // Wait for the advisory scan to resolve and the yellow notice to render —
    // this is the moment the buggy code auto-flips the decision.
    await screen.findByText(/possible duplicate/i);
    expect(screen.getByText(/barcode match/i)).toBeInTheDocument();

    // The user does NOT click the duplicate candidate — they just confirm
    // with the default selection, which must still be "Create anyway".
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(createItemsFromPoLinesAction).toHaveBeenCalledTimes(1);
    const call = createItemsFromPoLinesAction.mock.calls[0]![0] as {
      charterId: string | null;
      decisions?: Record<string, { mode: string; itemId?: string }>;
    };
    expect(call.charterId).toBe('chr-kva');
    const decision = call.decisions?.[LINE.id];
    // Must be absent or explicitly 'create' — never 'use_existing', and
    // never pointing at the pre-existing item's id.
    expect(decision?.mode).not.toBe('use_existing');
    expect(decision?.mode ?? 'create').toBe('create');
  });

  it('only links to the existing item when the user explicitly clicks the candidate', async () => {
    const user = userEvent.setup();
    findDuplicatesForPoLinesAction.mockResolvedValue({
      ok: true,
      data: {
        matches: {
          [LINE.id]: [
            {
              id: 'itm-cvw-existing',
              name: 'Chromebook 11 G9',
              sku: 'SKU-X',
              barcode: 'V-CB-1',
              quantityOnHand: 500,
              matchType: 'barcode',
            },
          ],
        },
      },
    });
    createItemsFromPoLinesAction.mockResolvedValue({
      ok: true,
      data: { created: 0, mapped: 0, linked: 1, skipped: 0 },
    });

    renderModal();

    await screen.findByText(/possible duplicate/i);
    // Explicit opt-in: click the candidate row itself.
    await user.click(screen.getByText('Chromebook 11 G9'));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(createItemsFromPoLinesAction).toHaveBeenCalledTimes(1);
    const call = createItemsFromPoLinesAction.mock.calls[0]![0] as {
      decisions?: Record<string, { mode: string; itemId?: string }>;
    };
    expect(call.decisions?.[LINE.id]).toEqual({
      mode: 'use_existing',
      itemId: 'itm-cvw-existing',
    });
  });
});
