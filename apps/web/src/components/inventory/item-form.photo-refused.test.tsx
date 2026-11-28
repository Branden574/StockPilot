import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// New item with photos: a photo the server refused is told in the server's
// own plain sentence, and is never counted as uploaded (lab walk 5: the card
// says the person who sent a refused file was told so in a plain sentence).
//
// Lab walk 6, W6-F2: the summary toast was drawn on top of that sentence.
// The form goes on to the new item's page as before, and what became of each
// photo is handed to that page's uploader, which shows it in the page under
// the drop zone (a polite status region), as visible text. The toast only
// counts, and points to the Images section; no toast carries the sentence.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() },
  record: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/server/actions/inventory', () => ({
  createItemAction: vi.fn(async () => ({ ok: true, data: { id: 'item-new' } })),
  updateItemAction: vi.fn(),
  bulkCreateSizedVariantsAction: vi.fn(async () => ({ ok: true, data: { created: 2, ids: ['v-s', 'v-m'] } })),
  findGroupCandidatesAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(async () => ({
    ok: true,
    data: { signedUrl: 'https://storage.example/up', thumbSignedUrl: 'https://storage.example/t', path: 'p', thumbPath: 't' },
  })),
  recordImageAction: h.record,
  removeImageAction: vi.fn(),
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

import { ImageUploader } from './image-uploader';
import { ItemForm } from './item-form';

type Category = Parameters<typeof ItemForm>[0]['categories'][number];

const WAREHOUSE_ID = '66666666-6666-4666-8666-666666666666';
const SHIRTS_ID = '88888888-8888-4888-8888-888888888888';
const REFUSED =
  'This file did not pass our checks, so it was not added. Try exporting or saving the file again, or send it another way.';

function renderForm(opts: { categories?: Category[]; categoryId?: string } = {}) {
  return render(
    <ItemForm
      defaults={{
        name: 'Spiral notebook',
        warehouseId: WAREHOUSE_ID,
        quantityOnHand: 1,
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
      }}
      itemType="product"
      categories={opts.categories ?? []}
      locations={[]}
      suppliers={[]}
      warehouses={[{ id: WAREHOUSE_ID, name: 'DC4' }]}
      warehouseCharters={[]}
      charters={[]}
      warehouseLabel="Warehouse"
      charterLabel="Charter"
    />,
  );
}

function stagePhoto(container: HTMLElement, name: string) {
  const input = container.querySelector('#item-form-photos') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' })] },
  });
}

/** Every string any toast was given. */
function toastTexts(): string[] {
  return Object.values(h.toast).flatMap((fn) => fn.mock.calls.map((c) => String(c[0])));
}

/** The item page's uploader, as it opens after the form: its status region. */
function itemPageRegion(itemId: string): HTMLElement {
  const { container } = render(<ImageUploader itemId={itemId} initialImages={[]} />);
  const el = container.querySelector<HTMLElement>('[data-slot="photo-results"]');
  expect(el).not.toBeNull();
  expect(el!.getAttribute('role')).toBe('status');
  expect(el!.getAttribute('aria-live')).toBe('polite');
  return el!;
}

/** The sentence is visible text in the region: not a title, a tooltip or screen-reader-only text. */
function expectVisibleSentence(region: HTMLElement, sentence: string) {
  const el = within(region).getByText(sentence);
  for (let node: HTMLElement | null = el; node && node !== region.parentElement; node = node.parentElement) {
    expect(node.className).not.toMatch(/\bsr-only\b|\bhidden\b|\binvisible\b|\bopacity-0\b|\babsolute\b|\bfixed\b/);
    expect(node.hasAttribute('hidden')).toBe(false);
  }
  expect(region.querySelector(`[title]`)).toBeNull();
}

beforeEach(() => {
  for (const fn of Object.values(h.toast)) fn.mockReset();
  h.record.mockReset();
  h.push.mockReset();
});

describe('ItemForm, New item with a photo the server refuses', () => {
  it('tells the refusal in its own sentence, in the item page under the uploader, and does not count the photo as uploaded', async () => {
    h.record.mockImplementation(async () => ({ ok: false, error: { code: 'validation_error', message: REFUSED } }));
    const { container } = renderForm();
    stagePhoto(container, 'shelf.png');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(h.record).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/dashboard/inventory/item-new'));

    // A short toast that counts and points to the page; no toast carries the sentence.
    expect(h.toast.warning).toHaveBeenCalledWith('Item created. No photos added. 1 refused: see Images below.');
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(toastTexts().join('\n')).not.toContain(REFUSED);

    // The item page the form goes to shows it in the page, with the photo's name.
    const region = itemPageRegion('item-new');
    expectVisibleSentence(region, REFUSED);
    expect(region.textContent).toContain('shelf.png');
  });

  it('every photo added: the same success line as before, and nothing handed to the item page', async () => {
    h.record.mockImplementation(async () => ({ ok: true, data: { id: 'img' } }));
    const { container } = renderForm();
    stagePhoto(container, 'shelf.png');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/dashboard/inventory/item-new'));
    expect(h.toast.success).toHaveBeenCalledWith('Item created with 1 photo.');
    expect(h.toast.warning).not.toHaveBeenCalled();
    expect(itemPageRegion('item-new').textContent).toBe('');
  });

  it('a size run: each variant page gets its own photos’ results, and no toast carries the sentence', async () => {
    const SHIRTS = { id: SHIRTS_ID, name: 'Shirts', supports_sizes: true } as Category;
    // The first variant's photo is refused; the second variant's is added.
    h.record.mockImplementation(async () =>
      h.record.mock.calls.length === 1
        ? { ok: false, error: { code: 'validation_error', message: REFUSED } }
        : { ok: true, data: { id: 'img' } },
    );
    const { container } = renderForm({ categories: [SHIRTS], categoryId: SHIRTS_ID });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'S' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    stagePhoto(container, 'shirt.png');
    await user.click(screen.getByRole('button', { name: /create item/i }));
    await waitFor(() => expect(h.record).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/dashboard/inventory'));

    expect(h.toast.warning).toHaveBeenCalledWith(
      'Created 2 variants. 1 of 2 photo uploads succeeded — 1 failed. Open a variant to see why, under Images.',
    );
    expect(toastTexts().join('\n')).not.toContain(REFUSED);
    expectVisibleSentence(itemPageRegion('v-s'), REFUSED);
    expect(itemPageRegion('v-m').textContent).toBe('');
  });
});
