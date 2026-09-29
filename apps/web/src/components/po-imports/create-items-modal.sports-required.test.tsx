import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// PO import "Create items" for a Sports category that requires a size.
//
// The modal offers per-line Size / Size system / Number inputs so "a missing
// required attribute can be supplied here". But its pre-submit check read the
// line's verdict as computed WITHOUT those inputs, so a line flagged
// "Missing attribute" stayed blocked however the size box was filled: a dead
// end. The server re-resolves WITH the typed values and is the authority; the
// modal now asks the same core rule before calling it, marks the required
// inputs, and fits the example size to the category.
// ---------------------------------------------------------------------------

const createItemsFromPoLinesAction = vi.fn();
const resolvePoImportLineResultsAction = vi.fn();

vi.mock('@/server/actions/po-imports', () => ({
  createItemsFromPoLinesAction: (...args: unknown[]) => createItemsFromPoLinesAction(...args),
  findDuplicatesForPoLinesAction: vi.fn(async () => ({ ok: true, data: { matches: {} } })),
  resolvePoImportLineResultsAction: (...args: unknown[]) =>
    resolvePoImportLineResultsAction(...args),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { CreateItemsModal } from './create-items-modal';

import type { PoImportLineRow } from '@/server/services/po-imports';
import type { LineResolution } from '@/server/services/po-imports-variants';

const JERSEYS_ID = '22222222-2222-2222-2222-222222222222';

const LINE = {
  id: 'line-1',
  po_import_id: 'imp-1',
  line_number: 1,
  line_type: 'inventory',
  qty_ordered_original: 12,
  uom_original: 'EA',
  description: 'Wildcats home jersey',
  unit_cost: 30,
  line_total: 360,
  vendor_item_number: null,
  vendor_product_number: null,
  auxiliary_number: null,
  coa_code: null,
  item_id: null,
  suggested_item_id: null,
  match_status: 'needs_review',
  match_confidence: null,
  extraction_confidence: null,
  exception_reason: null,
  variant_size: null,
  variant_size_system: null,
  jersey_number: null,
} as unknown as PoImportLineRow;

const MISSING_SIZE: LineResolution = {
  result: 'missing_required_attribute',
  groupId: null,
  groupName: null,
  groupCandidates: [],
  variantItemId: null,
  variantCandidates: [],
  variantKey: null,
  message: 'This line has no size, and this product is tracked per size.',
  errorCode: 'SHOE_SIZE_REQUIRED',
};

function renderModal() {
  render(
    <CreateItemsModal
      open
      onOpenChange={vi.fn()}
      poImportId="imp-1"
      vendorId="sup-1"
      warehouseId="wh-1"
      charterId={null}
      locationId={null}
      itemType="product"
      lines={[LINE]}
      categories={[{ id: JERSEYS_ID, name: 'Jerseys', sportsSubcategoryKey: 'jerseys' }]}
      onSuccess={vi.fn()}
    />,
  );
}

async function pickJerseys(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen
    .getAllByRole('combobox')
    .find((el) => el.textContent?.includes('No category'));
  await user.click(trigger!);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: /jerseys/i }));
  await screen.findByText(/Missing attribute/);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolvePoImportLineResultsAction.mockImplementation(
    async ({ categoryId }: { categoryId: string | null }) => ({
      ok: true,
      data: categoryId === JERSEYS_ID ? { [LINE.id]: MISSING_SIZE } : {},
    }),
  );
  createItemsFromPoLinesAction.mockResolvedValue({
    ok: true,
    data: { created: 1, mapped: 0, linked: 0, skipped: 0 },
  });
});

describe('CreateItemsModal — a Sports category that requires a size', () => {
  it('marks the size box required and gives an example that fits Jerseys', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderModal();
    await pickJerseys(user);

    const size = screen.getByRole('textbox', { name: 'Size for line 1' });
    expect(size).toHaveAttribute('aria-required', 'true');
    expect(size).toHaveAttribute('placeholder', 'Size (required), e.g. M');
    // Jerseys do not require a number or a size system.
    const number = screen.getByRole('textbox', { name: 'Number for line 1' });
    expect(number).not.toHaveAttribute('aria-required', 'true');
  });

  it('lets a size typed on the line answer "Missing attribute" and sends it (was a dead end)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderModal();
    await pickJerseys(user);

    await user.type(screen.getByRole('textbox', { name: 'Size for line 1' }), 'M');
    await waitFor(() => expect(screen.queryByText(/Missing attribute/)).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(createItemsFromPoLinesAction).toHaveBeenCalledTimes(1));
    const call = createItemsFromPoLinesAction.mock.calls[0]![0] as {
      categoryId: string | null;
      variantOverrides: Record<string, { size: string | null }>;
    };
    expect(call.categoryId).toBe(JERSEYS_ID);
    expect(call.variantOverrides[LINE.id]?.size).toBe('M');
  });

  it('still refuses the line, naming it, while the size is blank', async () => {
    const { toast } = await import('sonner');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderModal();
    await pickJerseys(user);

    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(createItemsFromPoLinesAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Line 1: This line has no size, and this product is tracked per size.',
    );
    expect(screen.getByRole('textbox', { name: 'Size for line 1' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
