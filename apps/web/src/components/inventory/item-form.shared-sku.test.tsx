import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { sharedSkuBannerCopy } from '@stockpilot/core';

// The seed's wording item (Ungroup, 2026-10-05): the edit form says plainly
// when the SKU (and the other shared fields) are shared by N other records
// the editor can see, and that saving them changes all of them; it points to
// "Make this its own item" on the item page. And a SKU already taken where
// the record is going offers to open the record that holds it.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
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
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));

import { ItemForm, skuTakenOpenHref } from './item-form';

const DEFAULTS = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Black Mouse Pad',
  sku: 'SP-IIHH8-AZCSKHS',
  barcode: '',
  modelNumber: '',
  description: '',
  categoryId: null,
  supplierId: null,
  primaryLocationId: null,
  warehouseId: null,
  charterId: null,
  unitCost: 1,
  retailPrice: 2,
  quantityOnHand: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitOfMeasure: 'unit',
  binLocation: '22-C',
  trackingType: 'none' as const,
  shelfLifeDays: null,
  expiryPolicy: 'warn' as const,
  status: 'active' as const,
  customFields: {},
  variantSize: '',
  itemType: 'product' as const,
};

function renderEdit(sharedSkuOthers?: number, sharedSkuKeeps?: 'kit' | 'family' | null) {
  return render(
    <ItemForm
      defaults={DEFAULTS as never}
      categories={[]}
      locations={[]}
      suppliers={[]}
      warehouses={[]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
      sharedSkuOthers={sharedSkuOthers}
      sharedSkuKeeps={sharedSkuKeeps}
      itemPageHref={`/dashboard/inventory/${DEFAULTS.id}`}
    />,
  );
}

describe('ItemForm: a SKU other records share', () => {
  it('says how many other records share it, which fields change for all, and links to the item page', () => {
    renderEdit(1);
    expect(screen.getByText(sharedSkuBannerCopy(1)!)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the item page' })).toHaveAttribute(
      'href',
      `/dashboard/inventory/${DEFAULTS.id}`,
    );
    // The shared-field notes carry the count too.
    expect(
      screen.getAllByText(/Shared with 1 other record that uses this SKU/).length,
    ).toBeGreaterThan(0);
  });

  // Fix round 1, P4: a kit or a family member is told why its SKU stays, and
  // is not sent to an action that would refuse it.
  it('a kit is told why its SKU stays, with no link to Make this its own item', () => {
    renderEdit(1, 'kit');
    expect(screen.getByText(sharedSkuBannerCopy(1, 'kit')!)).toBeInTheDocument();
    expect(screen.queryByText(/Make this its own item/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the item page' })).toBeNull();
  });

  it('says nothing extra when no other record the editor can see shares it', () => {
    renderEdit(0);
    expect(screen.queryByText(/is also used by/)).toBeNull();
    expect(screen.getAllByText('Shared across all placements of this SKU').length).toBeGreaterThan(
      0,
    );
  });
});

describe('skuTakenOpenHref', () => {
  it('links to the record holding the SKU when the server named one the editor can read', () => {
    expect(
      skuTakenOpenHref(
        { code: 'conflict', message: 'x', details: { reason: 'sku_taken', conflictItemId: 'abc' } },
        false,
      ),
    ).toBe('/dashboard/inventory/abc');
    expect(
      skuTakenOpenHref(
        { code: 'conflict', message: 'x', details: { reason: 'sku_taken', conflictItemId: 'abc' } },
        true,
      ),
    ).toBe('/dashboard/books/abc');
  });
  it('offers nothing otherwise', () => {
    expect(
      skuTakenOpenHref({ code: 'conflict', message: 'x', details: { reason: 'sku_taken' } }, false),
    ).toBeNull();
    expect(skuTakenOpenHref({ code: 'conflict', message: 'x' }, false)).toBeNull();
    expect(
      skuTakenOpenHref(
        { code: 'conflict', message: 'x', details: { reason: 'other', conflictItemId: 'abc' } },
        false,
      ),
    ).toBeNull();
  });
});
