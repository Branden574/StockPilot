import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the item page's Photos card.
//   - Remove awaited the action with no catch: a delete that got no answer
//     (offline, a server error, a deploy) closed the confirm and said nothing,
//     from the card and from the lightbox alike.
//   - An upload ran each photo with no catch: one photo with no answer threw
//     the whole batch away in silence, while the other photos kept going.
//   - "Photos uploaded." followed a photo that had just said it failed.
// ---------------------------------------------------------------------------

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
// The lightbox is loaded on demand and never opened here.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/image', () => ({
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ''} />
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: vi.fn(),
  recordImageAction: vi.fn(),
  removeImageAction: vi.fn(),
}));
// The canvas work is the browser's; here a photo is its own master.
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: file,
    thumbBlob: null,
    lqip: null,
  })),
}));
vi.mock('@/lib/upload-with-progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-with-progress')>()),
  uploadWithProgress: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import { toast } from 'sonner';

import {
  createImageUploadAction,
  recordImageAction,
  removeImageAction,
} from '@/server/actions/item-images';

import { ImageUploader } from './image-uploader';

const ITEM_ID = '99999999-9999-4999-8999-999999999999';
const PRESIGN = {
  ok: true,
  data: {
    path: 'org/item/front.jpg',
    thumbPath: 'org/item/front.thumb.webp',
    signedUrl: 'https://storage.example.com/upload/front',
    thumbSignedUrl: 'https://storage.example.com/upload/front-thumb',
  },
} as never;

function chooseFront(container: HTMLElement) {
  const input = container.querySelector('#image-upload') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'front.jpg', { type: 'image/jpeg' })] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImageUploader when a request gets no answer', () => {
  it('Remove says the photo was not deleted, closes the confirm and keeps the photo', async () => {
    vi.mocked(removeImageAction).mockRejectedValueOnce(offline());
    render(
      <ImageUploader
        itemId={ITEM_ID}
        initialImages={[{ id: 'img-1', url: 'https://img.example.com/1.jpg', isPrimary: true }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'delete the photo')),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Remove image' })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('an upload whose request gets no answer says that photo failed, and the card is ready again', async () => {
    vi.mocked(createImageUploadAction).mockRejectedValueOnce(offline());
    const { container } = render(<ImageUploader itemId={ITEM_ID} initialImages={[]} />);
    chooseFront(container);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'upload "front.jpg"'),
      ),
    );
    expect(await screen.findByText('Drop images, or click to browse')).toBeInTheDocument();
    // The button sits inside the drop zone's label, which names it.
    expect(screen.getByText(/Choose files/).closest('button')).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a photo whose record gets no answer says to check the item's photos", async () => {
    vi.mocked(createImageUploadAction).mockResolvedValueOnce(PRESIGN);
    vi.mocked(recordImageAction).mockRejectedValueOnce(offline());
    const { container } = render(<ImageUploader itemId={ITEM_ID} initialImages={[]} />);
    chooseFront(container);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), '"front.jpg" was saved', "the item's photos"),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says "Photos uploaded." only when no photo failed', async () => {
    vi.mocked(createImageUploadAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'Missing permission: items:update' },
    } as never);
    const { container } = render(<ImageUploader itemId={ITEM_ID} initialImages={[]} />);
    chooseFront(container);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Missing permission: items:update'),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();

    vi.mocked(createImageUploadAction).mockResolvedValueOnce(PRESIGN);
    vi.mocked(recordImageAction).mockResolvedValueOnce({
      ok: true,
      data: { id: 'img-2' },
    } as never);
    chooseFront(container);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Photos uploaded.'));
  });
});
