import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkPhotoCap,
  createPhotoAttemptGuard,
  uploadMaintenancePhoto,
  UploadError,
} from './maintenance-upload';

// './api' is mocked because maintenance-upload.ts imports the REAL `ApiError`
// class from it directly (for an `instanceof` check on a mint failure) —
// never the real module, which reaches for expo-constants/AsyncStorage/the
// Supabase client at import time and has no business running under the node
// test environment (same reasoning maintenance-api.test.ts documents for its
// own mock of './api'). vi.mock/vi.hoisted are hoisted above the imports by
// vitest's transform, so declaring them AFTER the import block above keeps
// import order lint-clean while still intercepting
// maintenance-upload.ts's own import of these modules (same idiom
// maintenance-api.test.ts uses for its own mock of './api').
const apiMock = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError, api: vi.fn(async () => ({}) as unknown) };
});
vi.mock('./api', () => apiMock);

const maintenanceApiMock = vi.hoisted(() => ({
  mintPhotoUpload: vi.fn(),
  finalizePhoto: vi.fn(),
}));
vi.mock('./maintenance-api', () => maintenanceApiMock);

const imageResizeMock = vi.hoisted(() => ({ resizeForUpload: vi.fn() }));
vi.mock('./image-resize', () => imageResizeMock);

const fsMock = vi.hoisted(() => ({
  createUploadTask: vi.fn(),
  uploadAsync: vi.fn(),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));
// Module id must stay in lockstep with maintenance-upload.ts's own import
// specifier — 'expo-file-system/legacy' since SDK 54 moved the URI-string API
// (createUploadTask/uploadAsync/FileSystemUploadType) there. Mocking the wrong
// id doesn't just weaken the test: vitest then loads the REAL module, which
// pulls in react-native's Flow-typed index.js and fails to parse.
vi.mock('expo-file-system/legacy', () => fsMock);

const manipulatorMock = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-image-manipulator', () => manipulatorMock);

const MINT = {
  path: 'org-1/req-1/uuid.jpg',
  signedUrl: 'https://signed/master',
  token: 'tok',
  thumbPath: 'org-1/req-1/uuid-thumb.webp',
  thumbSignedUrl: 'https://signed/thumb',
  thumbToken: 'thumb-tok',
};

type ProgressEvent = { totalBytesSent: number; totalBytesExpectedToSend: number };
type TaskFactory = (
  url: string,
  uri: string,
  opts: unknown,
  callback?: (p: ProgressEvent) => void,
) => { uploadAsync: () => Promise<{ status: number; headers: Record<string, string>; mimeType: null; body: string }> };

function taskWith(progressEvents: ProgressEvent[], status = 200): TaskFactory {
  return (_url, _uri, _opts, callback) => ({
    uploadAsync: async () => {
      for (const p of progressEvents) callback?.(p);
      return { status, headers: {}, mimeType: null, body: '' };
    },
  });
}

/** Overrides the NEXT createUploadTask() call ONLY, to report
 *  `progressEvents` (in order) through its callback, then resolve
 *  uploadAsync() with `status`. Layered on top of the persistent
 *  no-progress/200 default `beforeEach` installs below (mockImplementationOnce
 *  is always consumed before a mock's regular mockImplementation, regardless
 *  of which was registered first). */
function mockTask(progressEvents: ProgressEvent[], status = 200) {
  fsMock.createUploadTask.mockImplementationOnce(taskWith(progressEvents, status));
}

beforeEach(() => {
  apiMock.api.mockClear();
  maintenanceApiMock.mintPhotoUpload.mockReset();
  maintenanceApiMock.finalizePhoto.mockReset();
  imageResizeMock.resizeForUpload.mockReset();
  fsMock.createUploadTask.mockReset();
  fsMock.uploadAsync.mockReset();
  manipulatorMock.manipulateAsync.mockReset();

  imageResizeMock.resizeForUpload.mockResolvedValue({ uri: 'file:///resized.jpg', ext: 'jpg' });
  maintenanceApiMock.mintPhotoUpload.mockResolvedValue(MINT);
  maintenanceApiMock.finalizePhoto.mockResolvedValue({ id: 'att-1' });
  manipulatorMock.manipulateAsync.mockResolvedValue({ uri: 'file:///thumb.jpg' });
  fsMock.uploadAsync.mockResolvedValue({ status: 200, headers: {}, mimeType: null, body: '' });
  // Persistent DEFAULT (not "once"): a bare 200 with no progress events.
  // Individual tests override just their own call via mockTask()'s "once".
  fsMock.createUploadTask.mockImplementation(taskWith([]));
});

describe('uploadMaintenancePhoto', () => {
  it('resizes first, mints with the resized extension, PUTs binary content, then finalizes', async () => {
    const onProgress = vi.fn();
    await uploadMaintenancePhoto(
      'req-1',
      { uri: 'file:///camera.heic', fileName: 'IMG_001.HEIC' },
      onProgress,
    );

    // 1) resize ran against the ORIGINAL asset uri, not the resized one.
    expect(imageResizeMock.resizeForUpload).toHaveBeenCalledWith('file:///camera.heic');

    // 2) mint used the resized extension the mock returned ('jpg') — the
    // resize step is what forces JPEG; HEIC never reaches the server.
    // kind: 'requester' is the Task 10 default, sent EXPLICITLY (never
    // omitted) — matches web's MaintenancePhotosPanel.
    expect(maintenanceApiMock.mintPhotoUpload).toHaveBeenCalledWith('req-1', {
      fileExt: 'jpg',
      originalFilename: 'IMG_001.jpg',
      kind: 'requester',
    });

    // 3) the upload task PUT the RESIZED file (not the original) as raw
    // binary content, matching the arrayBuffer-not-blob upload precedent —
    // this is the OTA-safe, progress-capable native route, never a JS Blob.
    expect(fsMock.createUploadTask).toHaveBeenCalledWith(
      MINT.signedUrl,
      'file:///resized.jpg',
      expect.objectContaining({
        httpMethod: 'PUT',
        uploadType: fsMock.FileSystemUploadType.BINARY_CONTENT,
      }),
      expect.any(Function),
    );

    // 4) finalize used the mint's path/thumbPath, the correct MIME, and the
    // SAME kind:'requester' default sent explicitly (Task 10).
    expect(maintenanceApiMock.finalizePhoto).toHaveBeenCalledWith('req-1', {
      path: MINT.path,
      thumbPath: MINT.thumbPath,
      originalFilename: 'IMG_001.jpg',
      declaredMime: 'image/jpeg',
      kind: 'requester',
    });
  });

  it('forwards progress fractions from the upload task callback (0.5 forwarded)', async () => {
    mockTask([{ totalBytesSent: 50, totalBytesExpectedToSend: 100 }]);
    const onProgress = vi.fn();
    await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress);
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });

  it('ignores a progress event with no known total (totalBytesExpectedToSend <= 0)', async () => {
    mockTask([
      { totalBytesSent: 0, totalBytesExpectedToSend: 0 },
      { totalBytesSent: 40, totalBytesExpectedToSend: 80 },
    ]);
    const onProgress = vi.fn();
    await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });

  it('a failed PUT rejects with UploadError(upload_failed) and NEVER calls finalize (no orphan row)', async () => {
    mockTask([], 500);
    const onProgress = vi.fn();
    const err = await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe('upload_failed');
    expect(maintenanceApiMock.finalizePhoto).not.toHaveBeenCalled();
  });

  it('a rejected finalize (invalid_image) surfaces UploadError(rejected), not a network-failure message', async () => {
    maintenanceApiMock.finalizePhoto.mockRejectedValueOnce(
      new apiMock.ApiError('invalid_image', 400, 'validation_error'),
    );
    const onProgress = vi.fn();
    const err = await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe('rejected');
    // The UI must say the photo was refused, not "network error" / "check
    // your connection" — those words belong to the upload_failed kind only.
    expect((err as Error).message).not.toMatch(/network|connection/i);
  });

  it('maps a 409 mint rate-limit to UploadError(rate_limited) carrying the SERVER message, not a generic one', async () => {
    maintenanceApiMock.mintPhotoUpload.mockRejectedValueOnce(
      new apiMock.ApiError('Too many uploads in the last hour. Please try again later.', 409, 'conflict'),
    );
    const onProgress = vi.fn();
    const err = await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe('rate_limited');
    expect((err as Error).message).toBe('Too many uploads in the last hour. Please try again later.');
    // Mutation guard: a generic replacement (e.g. "Upload not allowed right
    // now.") must fail this assertion, not just "some string was thrown".
    expect((err as Error).message).not.toBe('Upload not allowed right now.');
  });

  it('does NOT wrap a non-409 mint failure — the original error (with its own message) passes through untouched', async () => {
    maintenanceApiMock.mintPhotoUpload.mockRejectedValueOnce(
      new apiMock.ApiError('Not your request.', 403, 'forbidden'),
    );
    const onProgress = vi.fn();
    const err = await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress).catch(
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(UploadError);
    expect((err as Error).message).toBe('Not your request.');
  });

  it('preserves a PNG source extension end to end instead of hardcoding jpg (a small already-web-safe PNG is returned unresized)', async () => {
    imageResizeMock.resizeForUpload.mockResolvedValueOnce({ uri: 'file:///screenshot.png', ext: 'png' });
    const onProgress = vi.fn();
    await uploadMaintenancePhoto(
      'req-1',
      { uri: 'file:///screenshot.png', fileName: 'Screenshot.png' },
      onProgress,
    );

    expect(maintenanceApiMock.mintPhotoUpload).toHaveBeenCalledWith('req-1', {
      fileExt: 'png',
      originalFilename: 'Screenshot.png',
      kind: 'requester',
    });
    expect(maintenanceApiMock.finalizePhoto).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ declaredMime: 'image/png', originalFilename: 'Screenshot.png' }),
    );
    const putOptions = fsMock.createUploadTask.mock.calls[0]?.[2] as { headers: Record<string, string> };
    expect(putOptions.headers['Content-Type']).toBe('image/png');
  });

  it('a missing/failed thumb never fails the whole upload (best-effort — the master is what matters)', async () => {
    manipulatorMock.manipulateAsync.mockRejectedValueOnce(new Error('manipulator crashed'));
    const onProgress = vi.fn();
    await expect(
      uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress),
    ).resolves.toEqual({ id: 'att-1' });
    expect(fsMock.uploadAsync).not.toHaveBeenCalled();
    expect(maintenanceApiMock.finalizePhoto).toHaveBeenCalled();
  });

  it('falls back to the literal filename "photo" when no fileName is given', async () => {
    const onProgress = vi.fn();
    await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress);
    expect(maintenanceApiMock.mintPhotoUpload).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ originalFilename: 'photo.jpg' }),
    );
  });
});

/**
 * Task 10 — `kind` threading. Proof photos on the maintenance detail
 * screen's Resolve flow reuse this SAME orchestration with kind:
 * 'resolution'; every other caller (app/maintenance/new.tsx's requester
 * photos) keeps calling with no 4th argument at all and must keep getting
 * the 'requester' default. T10-M2 (mutation self-check): dropping `kind`
 * from the finalize call ONLY must fail the second test below — finalize()
 * is the step that actually records the kind on the row
 * (maintenance-attachments.ts), so a mint-only threading would silently
 * record every proof photo as a requester photo server-side.
 */
describe('uploadMaintenancePhoto — kind threading (Task 10)', () => {
  it('defaults to kind:"requester", sent EXPLICITLY in BOTH the mint and finalize bodies, when no options are given', async () => {
    const onProgress = vi.fn();
    await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress);
    expect(maintenanceApiMock.mintPhotoUpload).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ kind: 'requester' }),
    );
    expect(maintenanceApiMock.finalizePhoto).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ kind: 'requester' }),
    );
  });

  it('threads kind:"resolution" into BOTH the mint and finalize bodies when given', async () => {
    const onProgress = vi.fn();
    await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress, { kind: 'resolution' });
    expect(maintenanceApiMock.mintPhotoUpload).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ kind: 'resolution' }),
    );
    expect(maintenanceApiMock.finalizePhoto).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ kind: 'resolution' }),
    );
  });

  it('a 3-arg call (no options bag) still compiles and behaves exactly like an explicit default — the existing new.tsx call sites are untouched', async () => {
    const onProgress = vi.fn();
    // No 4th argument at all — proves the options bag is genuinely
    // optional, not just typed optional while secretly required at runtime.
    await uploadMaintenancePhoto('req-1', { uri: 'file:///a.jpg' }, onProgress);
    expect(maintenanceApiMock.finalizePhoto).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ kind: 'requester' }),
    );
  });
});

describe('checkPhotoCap', () => {
  it('allows a selection that stays within the cap', () => {
    expect(checkPhotoCap({ existing: 2, pending: 1, incoming: 2, max: 8 })).toEqual({ ok: true });
  });

  it('allows landing EXACTLY on the cap', () => {
    expect(checkPhotoCap({ existing: 5, pending: 0, incoming: 3, max: 8 })).toEqual({ ok: true });
  });

  it('refuses a selection that would exceed the cap, with an accurate count in the message', () => {
    expect(checkPhotoCap({ existing: 6, pending: 1, incoming: 2, max: 8 })).toEqual({
      ok: false,
      message: 'A request can carry at most 8 photos.',
    });
  });

  it('counts already-queued (pending, not-yet-settled) uploads against the cap too', () => {
    // Two rapid-fire selections: the first is still uploading when the
    // second lands. Without counting `pending`, a user could queue past the
    // cap before the first batch's finalize calls ever return.
    expect(checkPhotoCap({ existing: 0, pending: 8, incoming: 1, max: 8 })).toEqual({
      ok: false,
      message: 'A request can carry at most 8 photos.',
    });
  });

  it('defaults max to MAINTENANCE_MAX_PHOTOS when not given', () => {
    expect(checkPhotoCap({ existing: 8, pending: 0, incoming: 1 })).toEqual({
      ok: false,
      message: 'A request can carry at most 8 photos.',
    });
  });
});

describe('createPhotoAttemptGuard', () => {
  it('the first attempt for a key is current until a retry starts a newer one', () => {
    const guard = createPhotoAttemptGuard();
    const t1 = guard.start('photo-1');
    expect(guard.isCurrent('photo-1', t1)).toBe(true);
  });

  it('a Retry tap invalidates the PRIOR attempt for the same photo', () => {
    const guard = createPhotoAttemptGuard();
    const t1 = guard.start('photo-1');
    const t2 = guard.start('photo-1');
    expect(guard.isCurrent('photo-1', t1)).toBe(false);
    expect(guard.isCurrent('photo-1', t2)).toBe(true);
  });

  it('a late report from a SUPERSEDED attempt must not win — the retry already owns the slot', () => {
    const guard = createPhotoAttemptGuard();
    // Simulates: first PUT is slow and still in flight when the user taps
    // Retry; the first attempt's failure/success then arrives LATE.
    const stale = guard.start('photo-1');
    const current = guard.start('photo-1');
    expect(guard.isCurrent('photo-1', stale)).toBe(false);
    expect(guard.isCurrent('photo-1', current)).toBe(true);
  });

  it('attempts are independent PER KEY — starting one photo never invalidates another', () => {
    const guard = createPhotoAttemptGuard();
    const a1 = guard.start('photo-a');
    const b1 = guard.start('photo-b');
    expect(guard.isCurrent('photo-a', a1)).toBe(true);
    expect(guard.isCurrent('photo-b', b1)).toBe(true);
  });

  it('a token for a key that was never started is never current', () => {
    const guard = createPhotoAttemptGuard();
    expect(guard.isCurrent('never-started', 1)).toBe(false);
  });

  it('tokens strictly increase per key across repeated retries', () => {
    const guard = createPhotoAttemptGuard();
    const t1 = guard.start('photo-1');
    const t2 = guard.start('photo-1');
    const t3 = guard.start('photo-1');
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  });
});
