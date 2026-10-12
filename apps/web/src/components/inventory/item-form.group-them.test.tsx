import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Group selected (0400) on a refused SKU copy: when an EXISTING record could
// not take a SKU another record holds in the same charter and rack (the old
// way to force two records together), the edit form offers to group the two
// as they are, each keeping its own SKU, charter and rack, next to "Open it".
// Never advice to change a charter or rack.

const h = vi.hoisted(() => ({ toastError: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: (p: { itemIds: readonly string[] }) => (
    <div data-testid="group-dialog">{p.itemIds.join(',')}</div>
  ),
}));

import { updateItemAction } from '@/server/actions/inventory';

import { ItemForm, SKU_TAKEN_GROUP_HINT, skuTakenGroupIds } from './item-form';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const DEFAULTS = {
  id: ME,
  name: 'Polo XXXL',
  sku: 'SP-TCO03-71D',
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
  binLocation: '15-A',
  trackingType: 'none' as const,
  shelfLifeDays: null,
  expiryPolicy: 'warn' as const,
  status: 'active' as const,
  customFields: {},
  variantSize: '',
  itemType: 'product' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('skuTakenGroupIds', () => {
  const refused = (other?: string) => ({
    code: 'conflict' as const,
    message: 'x',
    details: { reason: 'sku_taken', ...(other ? { conflictItemId: other } : {}) },
  });
  it('names this record and the readable holder when an existing record was being edited', () => {
    expect(skuTakenGroupIds(refused(OTHER), ME)).toEqual([ME, OTHER]);
  });
  it('offers nothing when creating, when the holder is hidden, or for another refusal', () => {
    expect(skuTakenGroupIds(refused(OTHER), null)).toBeNull();
    expect(skuTakenGroupIds(refused(), ME)).toBeNull();
    expect(
      skuTakenGroupIds({ code: 'conflict', message: 'x', details: { reason: 'other' } }, ME),
    ).toBeNull();
    expect(skuTakenGroupIds(refused(ME), ME)).toBeNull();
  });
  it('the hint never tells anyone to change a charter or rack', () => {
    expect(SKU_TAKEN_GROUP_HINT).not.toMatch(/change (the )?(charter|rack)/i);
  });
});

describe('ItemForm: a refused SKU copy offers Group them', () => {
  it('toasts the refusal with Group them and Open it; Group them opens the review for both records', async () => {
    vi.mocked(updateItemAction).mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message: 'SKU SP-TK372-88H is already used by “Polo XXXL” in the same charter and rack.',
        details: { reason: 'sku_taken', sku: 'SP-TK372-88H', conflictItemId: OTHER },
      },
    } as never);
    render(
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
        itemPageHref={`/dashboard/inventory/${ME}`}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    const [message, opts] = h.toastError.mock.calls.at(-1)! as [
      string,
      {
        action: { label: string; onClick: () => void };
        cancel: { label: string; onClick: () => void };
      },
    ];
    expect(message).toContain(SKU_TAKEN_GROUP_HINT);
    expect(opts.action.label).toBe('Group them');
    expect(opts.cancel.label).toBe('Open it');
    opts.action.onClick();
    expect(await screen.findByTestId('group-dialog')).toHaveTextContent(`${ME},${OTHER}`);
  });
});
