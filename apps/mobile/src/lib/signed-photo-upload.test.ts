import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PHOTO_PUT_FAILED_COPY,
  putSignedPhoto,
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
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
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

describe('the PUT session and its time limit (review finding 2026-09-27)', () => {
  // iOS: expo-file-system's upload task defaults to a BACKGROUND URLSession,
  // which waits for a connection for days and can finish on its own later: a
  // deferred send, which the owner ruled out for evidence (online only).

  function optionsOfPut(): Record<string, unknown> {
    return fsMock.createUploadTask.mock.calls[0]![2] as Record<string, unknown>;
  }

  it('with putOptions.foreground the PUT runs in a FOREGROUND session', async () => {
    const { e } = endpoints({ putOptions: { foreground: true, timeoutMs: 90_000 } });
    await uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {});
    expect(optionsOfPut()).toMatchObject({
      sessionType: fsMock.FileSystemSessionType.FOREGROUND,
      httpMethod: 'PUT',
    });
  });

  it('without putOptions (maintenance) the PUT is sent exactly as before: no session type, no limit', async () => {
    const { e } = endpoints();
    await uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {});
    expect(optionsOfPut()).toEqual({
      httpMethod: 'PUT',
      uploadType: fsMock.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  });

  it('a PUT still running at the time limit is CANCELLED and fails as upload_failed; finalize is never called', async () => {
    vi.useFakeTimers();
    try {
      const cancelAsync = vi.fn(async () => {});
      fsMock.createUploadTask.mockImplementation(() => ({
        uploadAsync: () => new Promise(() => {}),
        cancelAsync,
      }));
      const { e } = endpoints({ putOptions: { foreground: true, timeoutMs: 90_000 } });
      const settled = uploadSignedPhoto(e, { uri: 'file:///a.jpg' }, () => {}).catch(
        (x: unknown) => x,
      );
      await vi.advanceTimersByTimeAsync(89_999);
      expect(cancelAsync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const err = await settled;
      expect(err).toBeInstanceOf(UploadError);
      expect(err).toMatchObject({ kind: 'upload_failed', message: PHOTO_PUT_FAILED_COPY });
      expect(cancelAsync).toHaveBeenCalledTimes(1);
      expect(e.finalize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a PUT that answers in time is not cancelled, and its answer decides', async () => {
    const cancelAsync = vi.fn(async () => {});
    fsMock.createUploadTask.mockImplementation(() => ({
      uploadAsync: async () => ({ status: 403, headers: {}, mimeType: null, body: '' }),
      cancelAsync,
    }));
    await expect(
      putSignedPhoto(
        'https://signed/put',
        { uri: 'file:///a.jpg', declaredMime: 'image/jpeg' },
        () => {},
        {
          foreground: true,
          timeoutMs: 90_000,
        },
      ),
    ).rejects.toMatchObject({ kind: 'upload_failed' });
    expect(cancelAsync).not.toHaveBeenCalled();
  });

  it('a PUT that errors (the connection dropped) is still an error, not a hang', async () => {
    fsMock.createUploadTask.mockImplementation(() => ({
      uploadAsync: async () => {
        throw new Error('The network connection was lost.');
      },
      cancelAsync: vi.fn(async () => {}),
    }));
    await expect(
      putSignedPhoto(
        'https://signed/put',
        { uri: 'file:///a.jpg', declaredMime: 'image/jpeg' },
        () => {},
        {
          foreground: true,
          timeoutMs: 90_000,
        },
      ),
    ).rejects.toThrow('The network connection was lost.');
  });
});
