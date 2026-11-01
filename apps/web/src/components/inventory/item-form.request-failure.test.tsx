import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, recordEscapedRejections, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the item form's save awaited its actions with no catch. Its busy state
// is react-hook-form's, which clears itself, so a save that got no answer
// (offline, a server error, a deploy) ended in silence: no message, and on a
// create no way to know whether the item exists. A tags write or a photo that
// got no answer after the item was created threw the rest of the save away,
// so the person was never told the item had been created or taken to it.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
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
// The storage upload is the browser's XHR; here it lands.
vi.mock('@/lib/upload-with-progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-with-progress')>()),
  uploadWithProgress: vi.fn(async () => ({ ok: true, status: 200 })),
}));
// The canvas work is the browser's; here a photo is its own master.
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: file,
    thumbBlob: null,
    lqip: null,
  })),
}));

import { toast } from 'sonner';

import { createImageUploadAction, recordImageAction } from '@/server/actions/item-images';
import {
  bulkCreateSizedVariantsAction,
  createItemAction,
  updateItemAction,
} from '@/server/actions/inventory';
import { setItemTagsAction } from '@/server/actions/tags';

import { ItemForm, type ItemFormDefaults } from './item-form';

const WAREHOUSE_ID = '66666666-6666-4666-8666-666666666666';
const SITE_ID = '77777777-7777-4777-8777-777777777777';
const ITEM_ID = '99999999-9999-4999-8999-999999999999';
const SHIRTS_ID = '88888888-8888-4888-8888-888888888888';

type Category = Parameters<typeof ItemForm>[0]['categories'][number];

function renderForm(
  opts: {
    defaults?: ItemFormDefaults;
    tags?: Array<{ id: string; name: string; color: null }>;
    categories?: Category[];
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
      categories={opts.categories ?? []}
      locations={[{ id: SITE_ID, name: 'North site' }]}
      suppliers={[]}
      warehouses={[{ id: WAREHOUSE_ID, name: 'Main' }]}
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

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

describe('ItemForm when a save gets no answer', () => {
  it('a create says to check the Items list before trying again, and Create item works again', async () => {
    vi.mocked(createItemAction).mockRejectedValueOnce(offline());
    renderForm();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the item was created', 'the Items list'),
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
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'save the item')),
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

  // The file is up by the record step, so a record that got no answer may be
  // on the item already: "failed" would invite adding it a second time.
  it('a photo whose record step gets no answer says to look at the photos before adding it again', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({ ok: true, data: { id: ITEM_ID } } as never);
    vi.mocked(createImageUploadAction).mockResolvedValueOnce({
      ok: true,
      data: {
        signedUrl: 'https://storage.test/put',
        path: 'org/item/front.webp',
        thumbSignedUrl: 'https://storage.test/put-thumb',
        thumbPath: 'org/item/front-thumb.webp',
      },
    } as never);
    vi.mocked(recordImageAction).mockRejectedValueOnce(offline());
    const { container } = renderForm();
    const input = container.querySelector('#item-form-photos') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'front.jpg', { type: 'image/jpeg' })] },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Create item & upload 1 photo' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Item created. 0 of 1 photos uploaded. We couldn't confirm that 1 photo was saved. Check the item's photos before adding it again.",
      ),
    );
    expect(recordImageAction).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(`/dashboard/inventory/${ITEM_ID}`);
  });
  it('a photo answered with a redirect after the create says nothing, and nothing is left to escape', async () => {
    vi.mocked(createItemAction).mockResolvedValueOnce({ ok: true, data: { id: ITEM_ID } } as never);
    vi.mocked(createImageUploadAction).mockRejectedValueOnce(signInRedirect());
    const { container } = renderForm();
    const input = container.querySelector('#item-form-photos') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'front.jpg', { type: 'image/jpeg' })] },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Create item & upload 1 photo' }));
    await waitFor(() => expect(createImageUploadAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it("a size run's photo whose record step gets no answer says to look at each variant's photos", async () => {
    vi.mocked(bulkCreateSizedVariantsAction).mockResolvedValueOnce({
      ok: true,
      data: { created: 2, ids: ['item-s', 'item-m'] },
    } as never);
    vi.mocked(createImageUploadAction).mockResolvedValue({
      ok: true,
      data: {
        signedUrl: 'https://storage.test/put',
        path: 'org/item/front.webp',
        thumbSignedUrl: 'https://storage.test/put-thumb',
        thumbPath: 'org/item/front-thumb.webp',
      },
    } as never);
    vi.mocked(recordImageAction)
      .mockResolvedValueOnce({ ok: true, data: undefined } as never)
      .mockRejectedValueOnce(offline());
    const { container } = renderForm({
      categories: [{ id: SHIRTS_ID, name: 'Shirts', supports_sizes: true }],
      defaults: { categoryId: SHIRTS_ID },
    });
    const input = container.querySelector('#item-form-photos') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'front.jpg', { type: 'image/jpeg' })] },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'S' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: 'Create item & upload 1 photo' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Created 2 variants. 1 of 2 photo uploads succeeded. We couldn't confirm that 1 photo was saved. Check each variant's photos before adding it again.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
