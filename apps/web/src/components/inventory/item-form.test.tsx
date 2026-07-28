import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Task 4 (Model B / SKU grouping clarity): editing a SHARED product field
// (name, sku, unit_cost, retail_price, description, category, barcode,
// reorder_point, reorder_quantity, item_type) now propagates server-side to
// every placement of the SKU (Task 3, InventoryService.update). This is a
// copy/UX-only follow-up — no logic change — that labels which form fields
// are SHARED vs which are PER-PLACEMENT (charter, warehouse, location/rack,
// quantity, status) so the user isn't surprised by the propagation. These
// tests pin that the two helper notes render in the right neighborhoods.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
}));

vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));

vi.mock('@/server/actions/tags', () => ({
  setItemTagsAction: vi.fn(),
}));

import { ItemForm } from './item-form';

const SHARED_COPY = /shared across all placements of this sku/i;
const PLACEMENT_COPY = /this placement only/i;

function renderForm(defaults?: Parameters<typeof ItemForm>[0]['defaults']) {
  return render(
    <ItemForm
      defaults={defaults}
      categories={[]}
      locations={[]}
      suppliers={[]}
      warehouses={[]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

describe('ItemForm — shared vs per-placement field grouping (Task 4)', () => {
  it('shows the "shared across all placements" note next to the product-detail fields (name, cost)', () => {
    renderForm();

    // "Basics" holds name/sku/barcode/description — all shared product fields.
    const basicsHeading = screen.getByRole('heading', { name: 'Basics' });
    const basicsSection = basicsHeading.closest('div');
    expect(basicsSection?.textContent).toMatch(SHARED_COPY);
    // The Name field itself lives in this same section.
    expect(screen.getByPlaceholderText('Wireless mouse')).toBeInTheDocument();

    // "Pricing & stock" holds unit cost / retail price — also shared.
    const pricingHeading = screen.getByRole('heading', { name: 'Pricing & stock' });
    const pricingSection = pricingHeading.closest('div');
    expect(pricingSection?.textContent).toMatch(SHARED_COPY);
    // Unit cost + retail price both render a "0.00" placeholder input.
    expect(screen.getAllByPlaceholderText('0.00').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the "this placement only" note next to the charter/warehouse/rack fields', () => {
    renderForm();

    // "Warehouse & charter" section — entirely per-placement fields.
    const whHeading = screen.getByRole('heading', { name: 'Warehouse & charter' });
    const whSection = whHeading.closest('div');
    expect(whSection?.textContent).toMatch(PLACEMENT_COPY);

    // "Classification" section also carries the placement note ahead of the
    // primary-location / rack cluster.
    const classificationHeading = screen.getByRole('heading', { name: 'Classification' });
    const classificationSection = classificationHeading.closest('div');
    expect(classificationSection?.textContent).toMatch(PLACEMENT_COPY);
    expect(screen.getByPlaceholderText('38')).toBeInTheDocument(); // Rack number
  });

  it('labels on-hand quantity as placement-only when editing an existing item', () => {
    renderForm({ id: 'item-1', quantityOnHand: 12 });

    // Edit mode disables the On-hand input and shows the Adjust dialog
    // trigger — its inline note should call out this row is per-placement.
    const onHandField = screen.getByText('On hand').closest('div');
    expect(onHandField?.textContent).toMatch(PLACEMENT_COPY);
    expect(onHandField?.textContent).toMatch(/quantity lives at this specific rack\/charter/i);
  });

  it('does not change submit behavior — saving a shared field still calls the update action', async () => {
    const { updateItemAction } = await import('@/server/actions/inventory');
    vi.mocked(updateItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);

    renderForm({ id: 'item-1', name: 'Old name', quantityOnHand: 5 });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const nameInput = screen.getByPlaceholderText('Wireless mouse');
    await user.clear(nameInput);
    await user.type(nameInput, 'New name');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateItemAction).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ name: 'New name' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Migration 0303 backfilled `variant_size` onto every historical sized item,
// and InventoryService.update() dual-writes variant_size + custom_fields.size
// and recomputes variant_key. None of that was reachable from the web: the
// edit page never threaded the stored size into the form, so the field seeded
// '' and zod's emptyToUndefined dropped it from every patch. These pin the
// round trip — and that a row with no size gains no field.
// ---------------------------------------------------------------------------
describe('ItemForm — the row\'s own size on edit (0303)', () => {
  it('shows the stored size for a sized row being edited', () => {
    renderForm({ id: 'item-1', quantityOnHand: 5, variantSize: 'XL' });

    expect(screen.getByPlaceholderText('10.5')).toHaveValue('XL');
    expect(screen.getByText('Size')).toBeInTheDocument();
  });

  it('sends the edited size to the update action, so the dual-write is reachable', async () => {
    const { updateItemAction } = await import('@/server/actions/inventory');
    vi.mocked(updateItemAction).mockResolvedValue({ ok: true, data: { id: 'item-1' } } as never);

    renderForm({ id: 'item-1', name: 'Team Shirt', quantityOnHand: 5, variantSize: 'XL' });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const sizeInput = screen.getByPlaceholderText('10.5');
    await user.clear(sizeInput);
    await user.type(sizeInput, 'L');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateItemAction).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ variantSize: 'L' }),
    );
  });

  it('adds no Size field to a row that has no size, or to the create form', () => {
    const { unmount } = renderForm({ id: 'item-1', quantityOnHand: 5 });
    expect(screen.queryByPlaceholderText('10.5')).not.toBeInTheDocument();
    unmount();

    renderForm();
    expect(screen.queryByPlaceholderText('10.5')).not.toBeInTheDocument();
  });
});
