import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadBatchProgress, fileSizeOf, uploadFileToBucket } from './storage-upload';

// './supabase' is mocked because the real module reaches for expo-constants /
// AsyncStorage at import time and has no business running under the node test
// environment (same reasoning maintenance-upload.test.ts documents for its own
// mocks). vi.mock/vi.hoisted are hoisted above the import block by vitest's
// transform, so declaring them here still intercepts storage-upload.ts's own
// imports.
const supabaseMock = vi.hoisted(() => {
  const createSignedUploadUrl = vi.fn();
  const from = vi.fn(() => ({ createSignedUploadUrl }));
  return { createSignedUploadUrl, from, supabase: { storage: { from } } };
});
vi.mock('./supabase', () => ({ supabase: supabaseMock.supabase }));

const fsMock = vi.hoisted(() => ({
  createUploadTask: vi.fn(),
  getInfoAsync: vi.fn(),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));
// Module id must stay in lockstep with storage-upload.ts's own import
// specifier — 'expo-file-system/legacy' (see that module's doc comment for
// why the bare 'expo-file-system' id would throw at runtime on SDK 54+).
vi.mock('expo-file-system/legacy', () => fsMock);

const SIGNED_URL = 'https://storage.test/object/upload/sign/po-attachments/org-1/po-1/abc.pdf?token=t';

type ProgressEvent = { totalBytesSent: number; totalBytesExpectedToSend: number };
type TaskFactory = (
  url: string,
  uri: string,
  opts: unknown,
  callback?: (p: ProgressEvent) => void,
) => { uploadAsync: () => Promise<{ status: number }> };

/** Overrides the NEXT createUploadTask() call to report `progressEvents` (in
 *  order) through its callback, then resolve uploadAsync() with `status`. */
function mockTask(progressEvents: ProgressEvent[], status = 200) {
  const factory: TaskFactory = (_url, _uri, _opts, callback) => ({
    uploadAsync: async () => {
      for (const p of progressEvents) callback?.(p);
      return { status };
    },
  });
  fsMock.createUploadTask.mockImplementationOnce(factory);
}

beforeEach(() => {
  supabaseMock.createSignedUploadUrl.mockReset();
  supabaseMock.from.mockClear();
  fsMock.createUploadTask.mockReset();
  fsMock.getInfoAsync.mockReset();

  supabaseMock.createSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: SIGNED_URL, token: 't', path: 'org-1/po-1/abc.pdf' },
    error: null,
  });
  fsMock.createUploadTask.mockImplementation(((_url, _uri, _opts, _cb) => ({
    uploadAsync: async () => ({ status: 200 }),
  })) as TaskFactory);
});

describe('uploadFileToBucket — request shape', () => {
  it('mints for the exact bucket + path, then PUTs the file uri as raw binary with the declared Content-Type (literal-pinned)', async () => {
    const res = await uploadFileToBucket({
      bucket: 'po-attachments',
      path: 'org-1/po-1/abc.pdf',
      fileUri: 'file:///scan.pdf',
      contentType: 'application/pdf',
    });
    expect(res).toEqual({ ok: true });

    // Mint leg: the RLS-gated signed-URL request names OUR bucket and the
    // caller's exact path — this is where storage enforces the same insert
    // policy the old direct .upload() was gated by.
    expect(supabaseMock.from).toHaveBeenCalledWith('po-attachments');
    expect(supabaseMock.createSignedUploadUrl).toHaveBeenCalledWith('org-1/po-1/abc.pdf');

    // Byte leg: literal-pinned against what Supabase Storage's signed-upload
    // endpoint expects (PUT + Content-Type; the auth is the token already in
    // the signed URL) — the same shape maintenance-upload.ts sends. The file
    // goes by URI so the native task streams it off disk: no
    // fetch('file://').arrayBuffer(), no JS Blob.
    expect(fsMock.createUploadTask).toHaveBeenCalledTimes(1);
    const [url, uri, opts, callback] = fsMock.createUploadTask.mock.calls[0]!;
    expect(url).toBe(SIGNED_URL);
    expect(uri).toBe('file:///scan.pdf');
    expect(opts).toEqual({
      httpMethod: 'PUT',
      uploadType: fsMock.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': 'application/pdf' },
    });
    expect(callback).toBeInstanceOf(Function);
  });

  it('refuses to send a single byte when the mint is denied — RLS gates BEFORE transport, and the storage error surfaces verbatim', async () => {
    supabaseMock.createSignedUploadUrl.mockResolvedValueOnce({
      data: null,
      error: { message: 'new row violates row-level security policy' },
    });
    const res = await uploadFileToBucket({
      bucket: 'po-attachments',
      path: 'org-1/po-1/abc.pdf',
      fileUri: 'file:///scan.pdf',
      contentType: 'application/pdf',
    });
    expect(res).toEqual({ ok: false, error: 'new row violates row-level security policy' });
    expect(fsMock.createUploadTask).not.toHaveBeenCalled();
  });
});

describe('uploadFileToBucket — progress honesty', () => {
  it('forwards transport-reported fractions (0.5 forwarded)', async () => {
    mockTask([{ totalBytesSent: 50, totalBytesExpectedToSend: 100 }]);
    const onProgress = vi.fn();
    await uploadFileToBucket({
      bucket: 'order-attachments',
      path: 'org-1/order-1/a.jpg',
      fileUri: 'file:///a.jpg',
      contentType: 'image/jpeg',
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });

  it('ignores a progress event with no known total instead of fabricating a fraction', async () => {
    mockTask([
      { totalBytesSent: 10, totalBytesExpectedToSend: 0 },
      { totalBytesSent: 40, totalBytesExpectedToSend: 80 },
    ]);
    const onProgress = vi.fn();
    await uploadFileToBucket({
      bucket: 'order-attachments',
      path: 'p',
      fileUri: 'file:///a.jpg',
      contentType: 'image/jpeg',
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });

  it('clamps an over-reported byte count to 1 rather than exceeding it', async () => {
    mockTask([{ totalBytesSent: 250, totalBytesExpectedToSend: 100 }]);
    const onProgress = vi.fn();
    await uploadFileToBucket({
      bucket: 'order-attachments',
      path: 'p',
      fileUri: 'file:///a.jpg',
      contentType: 'image/jpeg',
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith(1);
  });

  it('a failed PUT resolves ok:false with the literal HTTP status in the error, and NEVER reports completion', async () => {
    mockTask([{ totalBytesSent: 60, totalBytesExpectedToSend: 100 }], 500);
    const onProgress = vi.fn();
    const res = await uploadFileToBucket({
      bucket: 'order-attachments',
      path: 'p',
      fileUri: 'file:///a.jpg',
      contentType: 'image/jpeg',
      onProgress,
    });
    expect(res).toEqual({
      ok: false,
      error: 'Upload failed (HTTP 500). Check your connection and retry.',
    });
    // The honesty rule this whole PR exists for: a failure must keep the
    // fraction where the transport stopped — 1 (100%) must never appear.
    expect(onProgress).toHaveBeenCalledWith(0.6);
    expect(onProgress).not.toHaveBeenCalledWith(1);
  });

  it('a transport-level throw (network drop) resolves ok:false with the thrown message and no completion report', async () => {
    fsMock.createUploadTask.mockImplementationOnce(((_url, _uri, _opts, _cb) => ({
      uploadAsync: async () => {
        throw new Error('Network request failed');
      },
    })) as TaskFactory);
    const onProgress = vi.fn();
    const res = await uploadFileToBucket({
      bucket: 'order-attachments',
      path: 'p',
      fileUri: 'file:///a.jpg',
      contentType: 'image/jpeg',
      onProgress,
    });
    expect(res).toEqual({ ok: false, error: 'Network request failed' });
    expect(onProgress).not.toHaveBeenCalledWith(1);
  });
});

describe('fileSizeOf', () => {
  it('returns the filesystem-reported size', async () => {
    fsMock.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 1234 });
    await expect(fileSizeOf('file:///a.pdf')).resolves.toBe(1234);
    expect(fsMock.getInfoAsync).toHaveBeenCalledWith('file:///a.pdf');
  });

  it('returns null for a missing file instead of inventing a size', async () => {
    fsMock.getInfoAsync.mockResolvedValueOnce({ exists: false });
    await expect(fileSizeOf('file:///gone.pdf')).resolves.toBeNull();
  });

  it('returns null when the platform call throws', async () => {
    fsMock.getInfoAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(fileSizeOf('file:///a.pdf')).resolves.toBeNull();
  });
});

describe('UploadBatchProgress — the honesty properties (mobile sibling of web BatchProgress)', () => {
  it('NEVER reports 100% when a file failed', () => {
    const batch = new UploadBatchProgress(['a', 'b']);
    batch.settle('a', true);
    batch.report('b', 0.8);
    batch.settle('b', false); // failed at 80%
    expect(batch.percent).not.toBe(100);
    expect(batch.percent).toBe(90);
  });

  it('reaches 100% only when every file genuinely succeeded', () => {
    const batch = new UploadBatchProgress(['a', 'b']);
    batch.settle('a', true);
    expect(batch.percent).toBeLessThan(100);
    batch.settle('b', true);
    expect(batch.percent).toBe(100);
  });

  it('holds at 99 rather than rounding up to 100 while bytes are still moving', () => {
    const batch = new UploadBatchProgress(['a']);
    batch.report('a', 0.996);
    expect(batch.percent).toBe(99);
  });

  it('never travels backwards, even if a transport re-reports a smaller fraction', () => {
    const batch = new UploadBatchProgress(['a']);
    batch.report('a', 0.7);
    expect(batch.percent).toBe(70);
    batch.report('a', 0.1);
    expect(batch.percent).toBe(70);
  });

  it('clamps a nonsense fraction instead of exceeding 100', () => {
    const batch = new UploadBatchProgress(['a']);
    batch.report('a', 4.2);
    expect(batch.percent).toBe(100);
  });

  it('ignores keys it does not track, rather than inventing progress', () => {
    const batch = new UploadBatchProgress(['a']);
    batch.report('ghost', 1);
    batch.settle('ghost', true);
    expect(batch.percent).toBe(0);
  });

  it('reports 0 for an empty batch rather than NaN', () => {
    const batch = new UploadBatchProgress([]);
    expect(batch.fraction).toBe(0);
    expect(batch.percent).toBe(0);
  });
});
