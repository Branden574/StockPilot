import { beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadItemPhoto } from './item-photo-upload';

/**
 * B31: a photo taken on the phone is stored WITH a thumbnail, as a web upload
 * is, and the thumbnail never costs the photo.
 *
 * Before this the three phone uploaders (new item, replace photo, scan
 * capture) stored the photo only, so every list paid for the full-size master
 * (image-cache.ts signListThumbnails resized it on demand, billed per photo).
 */

const imageResizeMock = vi.hoisted(() => ({ resizeForUpload: vi.fn() }));
vi.mock('./image-resize', () => imageResizeMock);

const manipulatorMock = vi.hoisted(() => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));
vi.mock('expo-image-manipulator', () => manipulatorMock);

const rnMock = vi.hoisted(() => ({ getSize: vi.fn() }));
vi.mock('react-native', () => ({ Image: rnMock }));

vi.mock('@stockpilot/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stockpilot/core')>()),
  randomPhotoFileBase: () => 'k3x9q2m1a8zt',
}));

const ORG = '0a000000-0000-4000-8000-000000000001';
const ITEM = '0b000000-0000-4000-8000-000000000002';
const FOLDER = `${ORG}/items/${ITEM}`;

type UploadCall = { bucket: string; path: string; bytes: unknown; contentType: unknown };

function fakeClient(refuse: (path: string) => string | null = () => null) {
  const uploads: UploadCall[] = [];
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, bytes: unknown, opts: { contentType?: string }) {
            uploads.push({ bucket, path, bytes, contentType: opts?.contentType });
            const refused = refuse(path);
            return refused
              ? { data: null, error: { message: refused } }
              : { data: { path }, error: null };
          },
        };
      },
    },
  };
  return {
    client: client as unknown as Parameters<typeof uploadItemPhoto>[0]['supabase'],
    uploads,
  };
}

/** Bytes per local file, so a test can tell which file was uploaded where. */
const BYTES = new Map<string, ArrayBuffer>();
function bytesFor(uri: string): ArrayBuffer {
  let b = BYTES.get(uri);
  if (!b) {
    b = new ArrayBuffer(uri.length);
    BYTES.set(uri, b);
  }
  return b;
}

function stubSize(dims: { width: number; height: number } | null) {
  rnMock.getSize.mockImplementation(
    (_uri: string, ok: (w: number, h: number) => void, fail: () => void) => {
      if (dims) ok(dims.width, dims.height);
      else fail();
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  BYTES.clear();
  imageResizeMock.resizeForUpload.mockResolvedValue({
    uri: 'file:///cache/resized.jpg',
    ext: 'jpg',
  });
  manipulatorMock.manipulateAsync.mockImplementation(
    async (_uri: string, _actions: unknown, opts: { format: string }) => ({
      uri: `file:///cache/manipulated.${opts.format === 'png' ? 'png' : 'jpg'}`,
      width: 0,
      height: 0,
    }),
  );
  stubSize({ width: 1600, height: 1200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (uri: string) => ({ arrayBuffer: async () => bytesFor(uri) })),
  );
});

describe('uploadItemPhoto', () => {
  it('stores the photo, then a 200 px JPEG thumbnail beside it, and answers both paths', async () => {
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });

    expect(res).toEqual({
      ok: true,
      path: `${FOLDER}/k3x9q2m1a8zt.jpg`,
      thumbPath: `${FOLDER}/k3x9q2m1a8zt-thumb.jpg`,
    });
    expect(imageResizeMock.resizeForUpload).toHaveBeenCalledWith('file:///picked.jpg');
    // The photo first, then the thumbnail: a thumbnail never exists without its photo.
    expect(uploads.map((u) => [u.bucket, u.path, u.contentType])).toEqual([
      ['item-images', `${FOLDER}/k3x9q2m1a8zt.jpg`, 'image/jpeg'],
      ['item-images', `${FOLDER}/k3x9q2m1a8zt-thumb.jpg`, 'image/jpeg'],
    ]);
    // The photo's bytes are the resized file's; the thumbnail's are the encoded thumbnail's.
    expect(uploads[0]!.bytes).toBe(bytesFor('file:///cache/resized.jpg'));
    expect(uploads[1]!.bytes).toBe(bytesFor('file:///cache/manipulated.jpg'));
    // Drawn from the uploaded photo, 200 px on the long edge, aspect kept, at the web's quality.
    expect(manipulatorMock.manipulateAsync).toHaveBeenCalledTimes(1);
    expect(manipulatorMock.manipulateAsync).toHaveBeenCalledWith(
      'file:///cache/resized.jpg',
      [{ resize: { width: 200, height: 150 } }],
      { compress: 0.8, format: 'jpeg' },
    );
  });

  it('keeps a portrait photo upright: 200 px tall', async () => {
    stubSize({ width: 1200, height: 1600 });
    const { client } = fakeClient();
    await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });
    expect(manipulatorMock.manipulateAsync.mock.calls[0]?.[1]).toEqual([
      { resize: { width: 150, height: 200 } },
    ]);
  });

  it('never enlarges a photo smaller than the thumbnail: it is only re-encoded', async () => {
    stubSize({ width: 160, height: 90 });
    const { client } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///tiny.jpg',
    });
    expect(res.ok && res.thumbPath).toBe(`${FOLDER}/k3x9q2m1a8zt-thumb.jpg`);
    expect(manipulatorMock.manipulateAsync.mock.calls[0]?.[1]).toEqual([]);
  });

  it('makes a PNG thumbnail for a PNG photo, so a transparent background stays transparent', async () => {
    imageResizeMock.resizeForUpload.mockResolvedValue({
      uri: 'file:///cache/logo.png',
      ext: 'png',
    });
    stubSize({ width: 800, height: 800 });
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///logo.png',
    });

    expect(res).toEqual({
      ok: true,
      path: `${FOLDER}/k3x9q2m1a8zt.png`,
      thumbPath: `${FOLDER}/k3x9q2m1a8zt-thumb.png`,
    });
    expect(uploads.map((u) => u.contentType)).toEqual(['image/png', 'image/png']);
    expect(manipulatorMock.manipulateAsync.mock.calls[0]?.[2]).toEqual({
      compress: 0.8,
      format: 'png',
    });
  });

  it('makes a PNG thumbnail for a WEBP photo too (WEBP may be transparent)', async () => {
    imageResizeMock.resizeForUpload.mockResolvedValue({
      uri: 'file:///cache/shot.webp',
      ext: 'webp',
    });
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///shot.webp',
    });
    expect(res).toEqual({
      ok: true,
      path: `${FOLDER}/k3x9q2m1a8zt.webp`,
      thumbPath: `${FOLDER}/k3x9q2m1a8zt-thumb.png`,
    });
    expect(uploads.map((u) => u.contentType)).toEqual(['image/webp', 'image/png']);
  });

  it('turns a small GIF from the library into a JPEG first: the bucket refuses image/gif (0046)', async () => {
    // resizeForUpload keeps a small GIF as it is, and expo-image-picker keeps a
    // GIF pick as .gif, so every phone uploader used to send it as image/gif.
    imageResizeMock.resizeForUpload.mockResolvedValue({
      uri: 'file:///cache/anim.gif',
      ext: 'gif',
    });
    manipulatorMock.manipulateAsync.mockImplementation(
      async (uri: string, _a: unknown, opts: { format: string }) => ({
        uri:
          uri === 'file:///cache/anim.gif'
            ? 'file:///cache/anim-as.jpg'
            : `file:///cache/thumb.${opts.format === 'png' ? 'png' : 'jpg'}`,
        width: 0,
        height: 0,
      }),
    );
    stubSize({ width: 480, height: 270 });
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///anim.gif',
    });

    expect(res).toEqual({
      ok: true,
      path: `${FOLDER}/k3x9q2m1a8zt.jpg`,
      thumbPath: `${FOLDER}/k3x9q2m1a8zt-thumb.jpg`,
    });
    expect(manipulatorMock.manipulateAsync.mock.calls[0]).toEqual([
      'file:///cache/anim.gif',
      [],
      { compress: 0.85, format: 'jpeg' },
    ]);
    expect(uploads.map((u) => u.contentType)).toEqual(['image/jpeg', 'image/jpeg']);
    expect(uploads[0]!.bytes).toBe(bytesFor('file:///cache/anim-as.jpg'));
    // The thumbnail is drawn from the converted photo, the one that was stored.
    expect(manipulatorMock.manipulateAsync.mock.calls[1]?.[0]).toBe('file:///cache/anim-as.jpg');
    expect(uploads.some((u) => u.contentType === 'image/gif')).toBe(false);
  });

  it('a refused photo answers the error and makes no thumbnail', async () => {
    const { client, uploads } = fakeClient((p) =>
      p.endsWith('.jpg') && !p.includes('-thumb')
        ? 'new row violates row-level security policy'
        : null,
    );
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });
    expect(res).toEqual({ ok: false, error: 'new row violates row-level security policy' });
    expect(uploads).toHaveLength(1);
    expect(manipulatorMock.manipulateAsync).not.toHaveBeenCalled();
  });

  it('a refused thumbnail keeps the photo: thumbPath is null and the row is written as before', async () => {
    const { client, uploads } = fakeClient((p) =>
      p.includes('-thumb') ? 'The resource already exists' : null,
    );
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });
    expect(res).toEqual({ ok: true, path: `${FOLDER}/k3x9q2m1a8zt.jpg`, thumbPath: null });
    expect(uploads).toHaveLength(2);
  });

  it('a thumbnail that cannot be encoded keeps the photo', async () => {
    manipulatorMock.manipulateAsync.mockRejectedValue(new Error('decode failed'));
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });
    expect(res).toEqual({ ok: true, path: `${FOLDER}/k3x9q2m1a8zt.jpg`, thumbPath: null });
    expect(uploads.map((u) => u.path)).toEqual([`${FOLDER}/k3x9q2m1a8zt.jpg`]);
  });

  it('a photo whose size cannot be read gets no thumbnail rather than a guessed one', async () => {
    stubSize(null);
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });
    expect(res).toEqual({ ok: true, path: `${FOLDER}/k3x9q2m1a8zt.jpg`, thumbPath: null });
    expect(manipulatorMock.manipulateAsync).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(1);
  });

  it('a thumbnail whose bytes cannot be read keeps the photo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (uri: string) => {
        if (uri.startsWith('file:///cache/manipulated')) throw new Error('file gone');
        return { arrayBuffer: async () => bytesFor(uri) };
      }),
    );
    const { client, uploads } = fakeClient();
    const res = await uploadItemPhoto({
      supabase: client,
      orgId: ORG,
      itemId: ITEM,
      uri: 'file:///picked.jpg',
    });
    expect(res).toEqual({ ok: true, path: `${FOLDER}/k3x9q2m1a8zt.jpg`, thumbPath: null });
    expect(uploads).toHaveLength(1);
  });

  it('a photo that cannot be resized still throws, for the screen to report as it always did', async () => {
    imageResizeMock.resizeForUpload.mockRejectedValue(new Error('unsupported image'));
    const { client, uploads } = fakeClient();
    await expect(
      uploadItemPhoto({ supabase: client, orgId: ORG, itemId: ITEM, uri: 'file:///broken.heic' }),
    ).rejects.toThrow('unsupported image');
    expect(uploads).toHaveLength(0);
  });
});
