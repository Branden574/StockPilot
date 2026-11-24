import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// New item with photos: a photo the server refused is told in the server's
// own plain sentence, and is never counted as uploaded (lab walk 5: the card
// says the person who sent a refused file was told so in a plain sentence).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
  record: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(async () => ({ ok: true, data: { id: 'item-new' } })),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(),
  findGroupCandidatesAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(async () => ({
    ok: true,
    data: { signedUrl: 'https://storage.example/up', thumbSignedUrl: 'https://storage.example/t', path: 'p', thumbPath: 't' },
  })),
  recordImageAction: h.record,
}));
vi.mock('@/server/actions/tags', () => ({ setItemTagsAction: vi.fn() }));
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: new File([new Uint8Array([1, 2, 3])], `${file.name}.webp`, { type: 'image/webp' }),
    thumbBlob: null,
    lqip: null,
  })),
}));
vi.mock('@/lib/upload-with-progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-with-progress')>()),
  uploadWithProgress: vi.fn(async () => ({ ok: true })),
}));

import { ItemForm } from './item-form';

const WAREHOUSE_ID = '66666666-6666-4666-8666-666666666666';
const REFUSED = 'This file did not pass our checks, so it was not added.';

beforeEach(() => {
  for (const fn of Object.values(h.toast)) fn.mockReset();
  h.record.mockReset();
});

describe('ItemForm, New item with a photo the server refuses', () => {
  it('tells the refusal in its own sentence and does not count the photo as uploaded', async () => {
    h.record.mockImplementation(async () => ({ ok: false, error: { code: 'validation_error', message: REFUSED } }));
    const { container } = render(
      <ItemForm
        defaults={{ name: 'Spiral notebook', warehouseId: WAREHOUSE_ID, quantityOnHand: 1 }}
        itemType="product"
        categories={[]}
        locations={[]}
        suppliers={[]}
        warehouses={[{ id: WAREHOUSE_ID, name: 'DC4' }]}
        warehouseCharters={[]}
        charters={[]}
        warehouseLabel="Warehouse"
        charterLabel="Charter"
      />,
    );
    const input = container.querySelector('#item-form-photos') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3, 4])], 'shelf.png', { type: 'image/png' })] },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(h.record).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalled());
    expect(h.toast.error).toHaveBeenCalledWith(REFUSED);
    expect(h.toast.warning).toHaveBeenCalledWith('Item created. 0 of 1 photos uploaded — 1 failed.');
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});
