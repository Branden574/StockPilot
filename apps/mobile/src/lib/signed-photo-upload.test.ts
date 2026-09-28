import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PHOTO_PUT_FAILED_COPY,
  UploadError,
  uploadSignedPhoto,
  type PreparedPhoto,
  type SignedPhotoEndpoints,
} from './signed-photo-upload';

/**
 * The generic signed-photo upload (F1-4), extracted from maintenance-upload.ts.
 * The maintenance behaviour is pinned by maintenance-upload.test.ts (it runs
 * against the thin wrapper); these pin what the extraction ADDED for other
 * callers: no client thumbnail unless the endpoints ask for one, the
 * extension allow-list, the "bytes are on the server" hook, and the error
 * mappers.
 */

const imageResizeMock = vi.hoisted(() => ({ resizeForUpload: vi.fn() }));
vi.mock('./image-resize', () => imageResizeMock);

const fsMock = vi.hoisted(() => ({
  createUploadTask: vi.fn(),
  uploadAsync: vi.fn(),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));
vi.mock('expo-file-system/legacy', () => fsMock);

const manipulatorMock = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-image-manipulator', () => manipulatorMock);

type Ticket = { signedUrl: string; path: string };

function putAnswers(status: number) {
  fsMock.createUploadTask.mockImplementation(() => ({
    uploadAsync: async () => ({ status, headers: {}, mimeType: null, body: '' }),
  }));
}

function endpoints(over: Partial<SignedPhotoEndpoints<Ticket, { id: string }>> = {}) {
  const calls: string[] = [];
  const e: SignedPhotoEndpoints<Ticket, { id: string }> = {
    mint: vi.fn(async (photo: PreparedPhoto) => {
      calls.push(`mint:${photo.ext}`);
      return { signedUrl: 'https://signed/put', path: 'org/occ/uuid.jpg' };
    }),
    finalize: vi.fn(async () => {
      calls.push('finalize');
      return { id: 'row-1' };
    }),
    ...over,
  };
  return { e, calls };
}

beforeEach(() => {
  imageResizeMock.resizeForUpload.mockReset();
  fsMock.createUploadTask.mockReset();
  fsMock.uploadAsync.mockReset();
  manipulatorMock.manipulateAsync.mockReset();
  imageResizeMock.resizeForUpload.mockResolvedValue({ uri: 'file:///resized.jpg', ext: 'jpg' });
  manipulatorMock.manipulateAsync.mockResolvedValue({ uri: 'file:///converted.jpg' });
  fsMock.uploadAsync.mockResolvedValue({ status: 200 });
  putAnswers(200);
});

describe('uploadSignedPhoto', () => {
  it('makes and sends NO thumbnail when the endpoints do not ask for one (the server makes it)', async () => {
    const { e } = endpoints();
    await expect(uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {})).resolves.toEqual({ id: 'row-1' });
    expect(manipulatorMock.manipulateAsync).not.toHaveBeenCalled();
    expect(fsMock.uploadAsync).not.toHaveBeenCalled();
  });

  it('sends a best-effort thumbnail to the URL the endpoints name', async () => {
    const { e } = endpoints({ thumbUploadUrl: () => 'https://signed/thumb' });
    await uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {});
    expect(fsMock.uploadAsync).toHaveBeenCalledWith(
      'https://signed/thumb',
      'file:///converted.jpg',
      expect.objectContaining({ httpMethod: 'PUT' }),
    );
  });

  it('PUTs the resized file with its declared type, then finalizes with the ticket', async () => {
    const { e } = endpoints();
    await uploadSignedPhoto(e, { uri: 'file:///camera.heic', fileName: 'IMG_1.HEIC' }, () => {});
    expect(fsMock.createUploadTask).toHaveBeenCalledWith(
      'https://signed/put',
      'file:///resized.jpg',
      expect.objectContaining({ httpMethod: 'PUT', headers: { 'Content-Type': 'image/jpeg' } }),
      expect.any(Function),
    );
    expect(e.finalize).toHaveBeenCalledWith(
      { signedUrl: 'https://signed/put', path: 'org/occ/uuid.jpg' },
      { uri: 'file:///resized.jpg', ext: 'jpg', declaredMime: 'image/jpeg', originalFilename: 'IMG_1.jpg' },
    );
  });

  it('converts a kind outside acceptedExtensions (a small GIF kept by the resize) to JPEG before the mint', async () => {
    imageResizeMock.resizeForUpload.mockResolvedValueOnce({ uri: 'file:///small.gif', ext: 'gif' });
    const { e, calls } = endpoints({ acceptedExtensions: ['jpg', 'jpeg', 'png', 'webp'] });
    await uploadSignedPhoto(e, { uri: 'file:///small.gif', fileName: 'anim.gif' }, () => {});
    expect(manipulatorMock.manipulateAsync).toHaveBeenCalledWith('file:///small.gif', [], {
      compress: 0.85,
      format: 'jpeg',
    });
    expect(calls[0]).toBe('mint:jpg');
    const put = fsMock.createUploadTask.mock.calls[0]!;
    expect(put[1]).toBe('file:///converted.jpg');
    expect((put[2] as { headers: Record<string, string> }).headers['Content-Type']).toBe('image/jpeg');
  });

  it('keeps what the resize returned when no allow-list is given (the maintenance behaviour)', async () => {
    imageResizeMock.resizeForUpload.mockResolvedValueOnce({ uri: 'file:///shot.png', ext: 'png' });
    const { e, calls } = endpoints();
    await uploadSignedPhoto(e, { uri: 'file:///shot.png' }, () => {});
    expect(manipulatorMock.manipulateAsync).not.toHaveBeenCalled();
    expect(calls[0]).toBe('mint:png');
  });

  it('calls onUploaded once the bytes are on the server, before finalize, and never after a failed PUT', async () => {
    const order: string[] = [];
    const { e } = endpoints({
      onUploaded: (t) => order.push(`uploaded:${t.path}`),
      finalize: vi.fn(async () => {
        order.push('finalize');
        return { id: 'row-1' };
      }),
    });
    await uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {});
    expect(order).toEqual(['uploaded:org/occ/uuid.jpg', 'finalize']);

    putAnswers(403);
    const onUploaded = vi.fn();
    const { e: e2 } = endpoints({ onUploaded });
    await expect(uploadSignedPhoto(e2, { uri: 'file:///a.jpg' }, () => {})).rejects.toBeInstanceOf(UploadError);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('a failed PUT is UploadError(upload_failed) and finalize is never called', async () => {
    putAnswers(500);
    const { e } = endpoints();
    const err = await uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {}).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe('upload_failed');
    expect((err as Error).message).toBe(PHOTO_PUT_FAILED_COPY);
    expect(e.finalize).not.toHaveBeenCalled();
  });

  it('throws what the mappers return, and the raw error without them', async () => {
    const raw = new Error('raw');
    const mapped = new Error('mapped');
    const { e } = endpoints({ mint: vi.fn(async () => Promise.reject(raw)) });
    await expect(uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {})).rejects.toBe(raw);
    const { e: e2 } = endpoints({ mint: vi.fn(async () => Promise.reject(raw)), mapMintError: () => mapped });
    await expect(uploadSignedPhoto(e2, { uri: 'file:///a.jpg' }, () => {})).rejects.toBe(mapped);

    const { e: e3 } = endpoints({ finalize: vi.fn(async () => Promise.reject(raw)) });
    await expect(uploadSignedPhoto(e3, { uri: 'file:///a.jpg' }, () => {})).rejects.toBe(raw);
    const mapFinalizeError = vi.fn(() => mapped);
    const { e: e4 } = endpoints({ finalize: vi.fn(async () => Promise.reject(raw)), mapFinalizeError });
    await expect(uploadSignedPhoto(e4, { uri: 'file:///a.jpg' }, () => {})).rejects.toBe(mapped);
    expect(mapFinalizeError).toHaveBeenCalledWith(
      raw,
      { signedUrl: 'https://signed/put', path: 'org/occ/uuid.jpg' },
      expect.objectContaining({ ext: 'jpg' }),
    );
  });
});
