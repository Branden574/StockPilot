import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The item photo uploader's last word on a batch (lab walk 5, F4): a photo
// the server refused is never counted as uploaded. The summary says how many
// were added and how many were not, beside each photo's own sentence.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  refresh: vi.fn(),
  record: vi.fn(),
  presign: vi.fn(),
  put: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/lib/image-variants', () => ({
  compressImageVariants: vi.fn(async (file: File) => ({
    master: new File([new Uint8Array([1, 2, 3])], `${file.name}.webp`, { type: 'image/webp' }),
    thumbBlob: null,
    lqip: null,
  })),
}));
vi.mock('@/lib/upload-with-progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-with-progress')>()),
  uploadWithProgress: h.put,
}));
vi.mock('@/server/actions/item-images', () => ({
  createImageUploadAction: h.presign,
  recordImageAction: h.record,
  removeImageAction: vi.fn(),
}));

import { ImageUploader } from './image-uploader';

const REFUSED = 'This file did not pass our checks, so it was not added.';

function photo(name: string): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

async function upload(files: File[]) {
  const { container } = render(<ImageUploader itemId="item-1" initialImages={[]} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: files } });
  await waitFor(() => expect(h.refresh).toHaveBeenCalled());
}

beforeEach(() => {
  for (const fn of [h.toast.success, h.toast.error, h.toast.warning, h.refresh, h.record, h.presign, h.put]) {
    fn.mockReset();
  }
  h.presign.mockImplementation(async () => ({
    ok: true,
    data: { signedUrl: 'https://storage.example/up', thumbSignedUrl: 'https://storage.example/t', path: 'p', thumbPath: 't' },
  }));
  h.put.mockImplementation(async () => ({ ok: true }));
  h.record.mockImplementation(async () => ({ ok: true, data: { id: 'img' } }));
});

describe('the uploader counts what was added (lab walk 5, F4)', () => {
  it('every photo added: one success line with the count', async () => {
    await upload([photo('a.png'), photo('b.png')]);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.success).toHaveBeenCalledWith('2 photos added.');
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.warning).not.toHaveBeenCalled();
  });

  it('a refused photo is not counted as uploaded: its own sentence, then how many were added and refused', async () => {
    h.record.mockImplementation(async (input: { storagePath: string }) =>
      input.storagePath === 'p' && h.record.mock.calls.length === 2
        ? { ok: false, error: { code: 'validation_error', message: REFUSED } }
        : { ok: true, data: { id: 'img' } },
    );
    await upload([photo('a.png'), photo('b.png')]);
    expect(h.toast.error).toHaveBeenCalledWith(REFUSED);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.warning).toHaveBeenCalledWith('1 photo added. 1 was refused.');
  });

  it('every photo refused: nothing said to be added', async () => {
    h.record.mockImplementation(async () => ({ ok: false, error: { code: 'validation_error', message: REFUSED } }));
    await upload([photo('a.png')]);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith(REFUSED);
    expect(h.toast.error).toHaveBeenLastCalledWith('No photos were added. 1 was refused.');
  });

  it('a photo that could not be sent is counted apart from a refused one', async () => {
    h.put.mockImplementationOnce(async () => ({ ok: false }));
    h.record.mockImplementation(async () =>
      h.record.mock.calls.length === 1
        ? { ok: false, error: { code: 'validation_error', message: REFUSED } }
        : { ok: true, data: { id: 'img' } },
    );
    await upload([photo('a.png'), photo('b.png'), photo('c.png')]);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.warning).toHaveBeenCalledWith('1 photo added. 1 was refused. 1 could not be sent.');
  });
});
