import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the item form's save awaited its actions with no catch. Its busy state
// is react-hook-form's, which clears itself, so a save that got no answer
// (offline, a server error, a deploy) ended in silence: no message, and on a
// create no way to know whether the item exists. A tags write or a photo that
// got no answer after the item was created threw the rest of the save away,
// so the person was never told the item had been created or taken to it.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
  findGroupCandidatesAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));
// The canvas work is the browser's; here a photo is its own master.
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: file,
    thumbBlob: null,
    lqip: null,
  })),
}));

import { toast } from 'sonner';

import { createImageUploadAction } from '@/server/actions/item-images';
import { createItemAction, updateItemAction } from '@/server/actions/inventory';
import { setItemTagsAction } from '@/server/actions/tags';

import { ItemForm, type ItemFormDefaults } from './item-form';

const WAREHOUSE_ID = '66666666-6666-4666-8666-666666666666';
const SITE_ID = '77777777-7777-4777-8777-777777777777';
const ITEM_ID = '99999999-9999-4999-8999-999999999999';

function renderForm(
  opts: {
    defaults?: ItemFormDefaults;
    tags?: Array<{ id: string; name: string; color: null }>;
  } = {},
) {
  return render(
    <ItemForm
      defaults={{
        name: 'Spiral notebook',
        warehouseId: WAREHOUSE_ID,
        quantityOnHand: 3,
        ...opts.defaults,
      }}
      itemType="product"
      categories={[]}
      locations={[{ id: SITE_ID, name: 'DC4' }]}
      suppliers={[]}
      warehouses={[{ id: WAREHOUSE_ID, name: 'DC4' }]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
      {...(opts.tags ? { tags: opts.tags } : {})}
    />,
  );
}

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

describe('ItemForm when a save gets no answer', () => {
  it('a create says to check the Items list before trying again, and Create item works again', async () => {
    vi.mocked(createItemAction).mockRejectedValueOnce(offline());
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage('the item was created', 'the Items list'),
      ),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create item' })).toBeEnabled();
  });

  it('an edit says the item was not saved', async () => {
    vi.mocked(updateItemAction).mockRejectedValueOnce(offline());
    renderForm({ defaults: { id: ITEM_ID, name: 'Spiral notebook', warehouseId: WAREHOUSE_ID } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('save the item')),
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('a tags write with no answer after the create says the tags were not saved, and still opens the item', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({ ok: true, data: { id: ITEM_ID } } as never);
    vi.mocked(setItemTagsAction).mockRejectedValueOnce(offline());
    renderForm({ tags: [{ id: 'tag-1', name: 'Fragile', color: null }] });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Item saved, but tags couldn't be updated: check your connection and try again.",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Item created.');
    expect(push).toHaveBeenCalledWith(`/dashboard/inventory/${ITEM_ID}`);
  });

  it('a photo whose upload gets no answer counts as failed, and the item still opens', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({ ok: true, data: { id: ITEM_ID } } as never);
    vi.mocked(createImageUploadAction).mockRejectedValueOnce(offline());
    const { container } = renderForm();
    const input = container.querySelector('#item-form-photos') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'front.jpg', { type: 'image/jpeg' })] },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Create item & upload 1 photo' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Item created. 0 of 1 photos uploaded — 1 failed.',
      ),
    );
    expect(push).toHaveBeenCalledWith(`/dashboard/inventory/${ITEM_ID}`);
  });
});
