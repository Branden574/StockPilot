import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, MAINTENANCE_MAX_PHOTO_BYTES, type ModuleId } from '@stockpilot/core';

import { reencodeWithoutMetadata } from '@/lib/image-reencode';
import { sniffImage } from '@/lib/image-signature';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Security invariant (listed in scripts/security-test.sh).
 *
 * PRIVACY: a maintenance photo is stored WITHOUT its metadata. A phone photo's
 * EXIF can say where it was taken (GPS), with which device, and by whom; the
 * clients do not always remove it (the web uploads the original when its own
 * re-encode is not smaller or cannot decode, the iOS picker hands WEBP back
 * byte for byte, Android copies EXIF), so finalize re-encodes what was
 * uploaded (lib/image-reencode.ts, the same step exception evidence uses) and
 * writes the clean file over the upload. The thumbnail is made on the server
 * from the clean photo and written at the name the mint handed out
 * ({uuid}-thumb.webp), replacing whatever the client sent there.
 *
 * Real sharp on real GPS-tagged JPEG, PNG and WEBP bytes made here; storage is
 * a small in-memory bucket (the signed range read the finalize makes first is
 * served from it too), and every assertion reads the bytes the bucket holds
 * after finalize. The re-encode is the real one except in the two tests that
 * replace a single call to reach a branch sharp cannot be made to hit.
 */

vi.mock('server-only', () => ({}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const notify = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => undefined));
vi.mock('./maintenance-notify', () => ({ notifyMaintenanceEvent: notify }));

const limiter = vi.hoisted(() => ({
  allowed: true,
  calls: [] as Array<{ key: string; limit: number; windowMs: number; mode: string | undefined }>,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (key: string, limit: number, windowMs: number, mode?: string) => {
    limiter.calls.push({ key, limit, windowMs, mode });
    return { allowed: limiter.allowed, count: 1, resetAt: Date.now() + windowMs };
  }),
}));

vi.mock('@/lib/image-reencode', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/image-reencode')>();
  return { ...real, reencodeWithoutMetadata: vi.fn(real.reencodeWithoutMetadata) };
});

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import { MaintenanceAttachmentsService } from './maintenance-attachments';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const REQ = '11111111-1111-4111-8111-111111111111';
const FILE = '33333333-3333-4333-8333-333333333333';
const stem = `${ORG}/${REQ}/${FILE}`;
const THUMB = `${stem}-thumb.webp`;
const ENABLED = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);
const OPEN_REQUEST = {
  id: REQ,
  requester_user_id: 'user-test',
  archived_at: null,
  cancelled_at: null,
  resolved_at: null,
  request_number: 7,
  created_at: '2026-09-27T10:00:00Z',
  subject: 'Leak',
};

type Kind = 'jpeg' | 'png' | 'webp';
const EXT: Record<Kind, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME: Record<Kind, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const EXIF = {
  IFD0: { Make: 'PinCam', Model: 'Privacy 1', Artist: 'Jo Tester' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '37/1 46/1 30/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '122/1 25/1 10/1',
  },
};
/** An XMP packet that carries a location too (exif:GPSLatitude). */
const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
  'exif:GPSLatitude="37,46.5N" exif:GPSLongitude="122,25.16W"/></rdf:RDF></x:xmpmeta>';

/** The GPS IFD pointer tag (0x8825) in either byte order. */
function hasGpsIfd(exif: Buffer | undefined): boolean {
  return (
    !!exif && (exif.includes(Buffer.from([0x25, 0x88])) || exif.includes(Buffer.from([0x88, 0x25])))
  );
}

/** A photo as a phone would send it: EXIF with GPS and camera details, an XMP
 *  packet with GPS, and an ICC profile. `noise` makes it large (past the 4 KB
 *  range-read window); `pad` pushes the first frame header past 4 KB (a
 *  camera original with a big metadata block). */
async function phonePhoto(
  kind: Kind,
  opts: { width?: number; height?: number; orientation?: number; noise?: boolean; pad?: number; color?: string } = {},
): Promise<Uint8Array> {
  const width = opts.width ?? 60;
  const height = opts.height ?? 30;
  let img = opts.noise
    ? sharp(Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 7919) % 251)), {
        raw: { width, height, channels: 3 },
      })
    : sharp({ create: { width, height, channels: 3, background: opts.color ?? '#0ac83c' } });
  img = kind === 'jpeg' ? img.jpeg() : kind === 'png' ? img.png() : img.webp();
  const exif = opts.pad
    ? { ...EXIF, IFD0: { ...EXIF.IFD0, ImageDescription: 'x'.repeat(opts.pad) } }
    : EXIF;
  img = img.withExif(exif).withXmp(XMP).withIccProfile('p3');
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return new Uint8Array(await img.toBuffer());
}

/** Everything that must NOT be in a stored photo or thumbnail. */
async function expectNoMetadata(bytes: Uint8Array, label: string): Promise<void> {
  const buf = Buffer.from(bytes);
  const meta = await sharp(buf).metadata();
  expect(meta.exif, `${label}: exif`).toBeUndefined();
  expect(meta.xmp, `${label}: xmp`).toBeUndefined();
  expect(meta.iptc, `${label}: iptc`).toBeUndefined();
  expect(meta.icc, `${label}: icc`).toBeUndefined();
  expect(meta.orientation, `${label}: orientation`).toBeUndefined();
  expect(buf.includes(Buffer.from('Exif\0\0')), `${label}: Exif marker`).toBe(false);
  expect(buf.includes(Buffer.from('PinCam')), `${label}: camera make`).toBe(false);
  expect(buf.includes(Buffer.from('Jo Tester')), `${label}: artist`).toBe(false);
  expect(buf.includes(Buffer.from('GPSLatitude')), `${label}: XMP location`).toBe(false);
  expect(buf.includes(Buffer.from('ns.adobe.com')), `${label}: XMP packet`).toBe(false);
}

/**
 * An in-memory maintenance-photos bucket. Uploads honour `upsert` the way
 * Storage does (no upsert onto an existing name is refused). createSignedUrl
 * refuses a missing object, like Storage; the URL it mints is served by the
 * fetch stub below, with Range support, so the service's real range read
 * (fetchObjectPrefix) runs against these bytes.
 */
class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  failUpload = new Set<string>();
  failDownload = false;
  /** When set, download() answers these bytes instead of the object. */
  downloadOverride: Uint8Array | null = null;
  calls = {
    download: [] as string[],
    upload: [] as Array<{ path: string; contentType: string | undefined; upsert: boolean | undefined }>,
    remove: [] as string[][],
  };

  put(path: string, bytes: Uint8Array, contentType: string) {
    this.objects.set(path, { bytes: new Uint8Array(bytes), contentType });
  }
  bytes(path: string): Uint8Array | undefined {
    return this.objects.get(path)?.bytes;
  }
  async createSignedUrl(path: string, _ttl: number) {
    if (!this.objects.has(path)) return { data: null, error: { message: 'Object not found' } };
    return {
      data: { signedUrl: `https://storage.test/sign/${encodeURIComponent(path)}?token=t` },
      error: null,
    };
  }
  async download(path: string) {
    this.calls.download.push(path);
    const obj = this.objects.get(path);
    if (this.failDownload || !obj) return { data: null, error: { message: 'Object not found' } };
    const bytes = this.downloadOverride ?? obj.bytes;
    return { data: { arrayBuffer: async () => bytes.slice().buffer }, error: null };
  }
  async upload(path: string, body: Uint8Array, opts?: { contentType?: string; upsert?: boolean }) {
    this.calls.upload.push({ path, contentType: opts?.contentType, upsert: opts?.upsert });
    if (this.failUpload.has(path)) return { data: null, error: { message: 'write failed' } };
    if (this.objects.has(path) && !opts?.upsert) {
      return { data: null, error: { message: 'The resource already exists' } };
    }
    this.put(path, body, opts?.contentType ?? 'application/octet-stream');
    return { data: { path }, error: null };
  }
  async remove(paths: string[]) {
    this.calls.remove.push([...paths]);
    for (const p of paths) this.objects.delete(p);
    return { data: [], error: null };
  }
  async createSignedUrls() {
    return { data: [], error: null };
  }
}

let bucket: FakeBucket;

/** Storage's signed-URL GET, with Range (206 + Content-Range), over `bucket`. */
async function storageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const path = decodeURIComponent(url.pathname.replace(/^\/sign\//, ''));
  const obj = bucket.objects.get(path);
  if (!obj) return new Response('not found', { status: 404 });
  const range = new Headers(init?.headers).get('range');
  const total = obj.bytes.byteLength;
  const m = range?.match(/^bytes=(\d+)-(\d+)$/);
  if (m) {
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), total - 1);
    return new Response(obj.bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${total}` },
    });
  }
  return new Response(obj.bytes.slice(), {
    status: 200,
    headers: { 'content-length': String(total) },
  });
}

/**
 * One service. `recorded` is what the maintenance_request_attachments table
 * holds for the admin's "is this upload recorded?" look (or 'error');
 * `live` the per-kind count the cap reads; `insert` the insert's answer.
 */
function setup(
  opts: {
    recorded?: Array<Record<string, unknown>> | 'error';
    live?: number;
    insert?: { data: unknown; error: { message: string; code?: string } | null };
  } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const user = makeSupabaseStub({
    'maintenance_requests.select': { data: OPEN_REQUEST, error: null },
    'maintenance_request_attachments.select': { data: null, error: null, count: opts.live ?? 0 },
    'maintenance_request_attachments.insert': (call) => {
      inserted.push(call.args[0]![0] as Record<string, unknown>);
      return opts.insert ?? { data: { id: 'att-1' }, error: null };
    },
  });
  const recordedRows = opts.recorded ?? [];
  const admin = makeSupabaseStub({
    'maintenance_request_attachments.select':
      recordedRows === 'error'
        ? { data: null, error: { message: 'lookup failed' } }
        : servedLikePostgrest(recordedRows),
  });
  admin.client.storage.from = vi.fn(() => bucket);
  adminHolder.client = admin.client;
  const ctx = makeServiceContext(user.client, { organizationId: ORG, enabledModules: ENABLED });
  return { svc: new MaintenanceAttachmentsService(ctx), user, admin, inserted };
}

const finalizeArgs = (kind: Kind, path = `${stem}.${EXT[kind]}`) => ({
  path,
  originalFilename: `leak.${EXT[kind]}`,
  declaredMime: MIME[kind],
});

/** The client's own thumbnail as an old phone build PUTs it: JPEG bytes
 *  under the .webp name, with GPS, and a different picture (red). */
let clientThumb: Uint8Array;

beforeAll(async () => {
  clientThumb = new Uint8Array(
    await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } })
      .jpeg()
      .withExif(EXIF)
      .toBuffer(),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowed = true;
  limiter.calls = [];
  bucket = new FakeBucket();
  vi.stubGlobal('fetch', vi.fn(storageFetch));
});

// ═══════════════════════════════════════════════════════════════════════════
describe('finalize stores the photo without its metadata (real sharp)', () => {
  it('the fixtures really carry GPS, XMP, ICC and camera details (a vacuous test proves nothing)', async () => {
    for (const kind of ['jpeg', 'png', 'webp'] as const) {
      const bytes = await phonePhoto(kind);
      const meta = await sharp(Buffer.from(bytes)).metadata();
      expect(hasGpsIfd(meta.exif), kind).toBe(true);
      expect(meta.xmp, kind).toBeDefined();
      expect(meta.icc, kind).toBeDefined();
      expect(Buffer.from(bytes).includes(Buffer.from('PinCam')), kind).toBe(true);
    }
    expect(hasGpsIfd((await sharp(Buffer.from(clientThumb)).metadata()).exif)).toBe(true);
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    '%s: the stored photo has no EXIF, GPS, XMP, ICC or camera details, keeps its format, and the row describes the stored file',
    async (kind) => {
      const path = `${stem}.${EXT[kind]}`;
      bucket.put(path, await phonePhoto(kind), MIME[kind]);
      bucket.put(THUMB, clientThumb, 'image/jpeg');
      const { svc, inserted } = setup();

      const res = await svc.finalize(REQ, finalizeArgs(kind));

      const stored = bucket.bytes(path)!;
      await expectNoMetadata(stored, `${kind} photo`);
      expect(sniffImage(stored)?.kind).toBe(kind);
      expect(bucket.objects.get(path)!.contentType).toBe(MIME[kind]);
      const meta = await sharp(Buffer.from(stored)).metadata();
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        storage_path: path,
        thumbnail_path: THUMB,
        mime_type: MIME[kind],
        byte_size: stored.byteLength,
        width: meta.width,
        height: meta.height,
      });
      // The finalize answer keeps its shape for old phone builds.
      expect(res).toEqual({ id: 'att-1', width: 60, height: 30 });
    },
  );

  it('a photo larger than the 4 KB range window is read whole and stored clean', async () => {
    const photo = await phonePhoto('jpeg', { width: 320, height: 240, noise: true });
    expect(photo.byteLength).toBeGreaterThan(4096);
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    const { svc, inserted } = setup();

    await svc.finalize(REQ, finalizeArgs('jpeg'));

    expect(bucket.calls.download).toEqual([`${stem}.jpg`]);
    const stored = bucket.bytes(`${stem}.jpg`)!;
    await expectNoMetadata(stored, 'large photo');
    expect(inserted[0]!.byte_size).toBe(stored.byteLength);
    expect([inserted[0]!.width, inserted[0]!.height]).toEqual([320, 240]);
  });

  it('a camera-style JPEG whose metadata runs past 4 KB is stored clean', async () => {
    const photo = await phonePhoto('jpeg', { pad: 6000 });
    expect(photo.byteLength).toBeGreaterThan(6000);
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    const { svc } = setup();

    await svc.finalize(REQ, finalizeArgs('jpeg'));

    await expectNoMetadata(bucket.bytes(`${stem}.jpg`)!, 'metadata-heavy photo');
  });

  it('a portrait photo (EXIF orientation 6) is stored upright with the tag gone, and the row and the answer give the stored size', async () => {
    const photo = await phonePhoto('jpeg', { orientation: 6 });
    expect((await sharp(Buffer.from(photo)).metadata()).orientation).toBe(6);
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    const { svc, inserted } = setup();

    const res = await svc.finalize(REQ, finalizeArgs('jpeg'));

    const meta = await sharp(Buffer.from(bucket.bytes(`${stem}.jpg`)!)).metadata();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([30, 60]);
    expect([inserted[0]!.width, inserted[0]!.height]).toEqual([30, 60]);
    expect(res).toEqual({ id: 'att-1', width: 30, height: 60 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the thumbnail: made on the server from the clean photo, at the name the mint handed out', () => {
  it('replaces the client thumbnail (a GPS JPEG of another picture) with a WEBP of the stored photo, at most 400 px, with no metadata; the row names that same path', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg', { width: 1200, height: 900 }), 'image/jpeg');
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    const { svc, inserted } = setup();

    await svc.finalize(REQ, finalizeArgs('jpeg'));

    const thumb = bucket.bytes(THUMB)!;
    await expectNoMetadata(thumb, 'thumbnail');
    const meta = await sharp(Buffer.from(thumb)).metadata();
    expect(meta.format).toBe('webp');
    expect(bucket.objects.get(THUMB)!.contentType).toBe('image/webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(400);
    // The same picture as the photo (green), not the client's (red).
    const { channels } = await sharp(Buffer.from(thumb)).stats();
    expect(channels[1]!.mean).toBeGreaterThan(150);
    expect(channels[0]!.mean).toBeLessThan(60);
    expect(inserted[0]!.thumbnail_path).toBe(THUMB);
    // Written where the mint's ticket points, replacing what was there.
    expect(bucket.calls.upload).toContainEqual({ path: THUMB, contentType: 'image/webp', upsert: true });
  });

  it('writes one even when the client sent none (a thumbnail PUT that failed)', async () => {
    bucket.put(`${stem}.png`, await phonePhoto('png'), 'image/png');
    const { svc, inserted } = setup();

    await svc.finalize(REQ, finalizeArgs('png'));

    expect(bucket.objects.has(THUMB)).toBe(true);
    await expectNoMetadata(bucket.bytes(THUMB)!, 'thumbnail');
    expect(inserted[0]!.thumbnail_path).toBe(THUMB);
  });

  it("the mint's thumbPath is the name finalize records and writes (the contract old phone builds PUT against)", async () => {
    const { svc, user, inserted } = setup();
    const createSignedUploadUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://storage.test/upload', token: 'tok' },
      error: null,
    }));
    user.client.storage.from = vi.fn(() => ({ createSignedUploadUrl }));

    const ticket = await svc.createUploadUrl(REQ, { fileExt: 'webp', originalFilename: 'x.webp' });
    expect(Object.keys(ticket).sort()).toEqual(
      ['path', 'signedUrl', 'thumbPath', 'thumbSignedUrl', 'thumbToken', 'token'].sort(),
    );
    bucket.put(ticket.path, await phonePhoto('webp'), 'image/webp');
    bucket.put(ticket.thumbPath, clientThumb, 'image/jpeg');

    await svc.finalize(REQ, { path: ticket.path, originalFilename: 'x.webp', declaredMime: 'image/webp' });

    expect(inserted[0]!.thumbnail_path).toBe(ticket.thumbPath);
    expect(ticket.thumbPath).toBe(ticket.path.replace(/\.webp$/, '-thumb.webp'));
    await expectNoMetadata(bucket.bytes(ticket.thumbPath)!, 'thumbnail');
    await expectNoMetadata(bucket.bytes(ticket.path)!, 'photo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('refusals: nothing recorded, and the upload (still the original) deleted', () => {
  async function expectDeletedAndUnrecorded(
    path: string,
    inserted: Array<Record<string, unknown>>,
  ): Promise<void> {
    expect(bucket.objects.has(path)).toBe(false);
    expect(bucket.objects.has(THUMB)).toBe(false);
    expect(bucket.calls.remove).toContainEqual([path, THUMB]);
    expect(inserted).toHaveLength(0);
  }

  it('bytes that pass the sniff but do not decode: invalid_image, nothing written back, the upload and the client thumbnail deleted, the uploader told', async () => {
    // A JPEG header whose frame header (SOF0, 60x30) is real, then nothing.
    const broken = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x1e, 0x00, 0x3c, 0x01, 0x00,
    ]);
    expect(sniffImage(broken)?.kind).toBe('jpeg');
    bucket.put(`${stem}.jpg`, broken, 'image/jpeg');
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'validation_error',
      message: 'invalid_image',
    });
    expect(vi.mocked(reencodeWithoutMetadata)).toHaveBeenCalledTimes(1);
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'photo_rejected' }));
  });

  it.each([
    ['the photo', `${stem}.jpg`],
    ['the thumbnail', THUMB],
  ])('writing %s back fails: internal_error, both files deleted, nothing recorded', async (_label, failing) => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    bucket.failUpload.add(failing);
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'internal_error',
    });
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('the whole read fails after the range read: invalid_image, deleted, nothing recorded', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg', { width: 320, height: 240, noise: true }), 'image/jpeg');
    bucket.failDownload = true;
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      message: 'invalid_image',
    });
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('the whole read is not the object the range read measured: refused, deleted, nothing recorded', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg', { width: 320, height: 240, noise: true }), 'image/jpeg');
    bucket.downloadOverride = await phonePhoto('jpeg', { width: 20, height: 20 });
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      message: 'invalid_image',
    });
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('a clean photo over the 10 MB cap: refused, deleted, nothing recorded', async () => {
    const photo = await phonePhoto('jpeg');
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    const big = new Uint8Array(MAINTENANCE_MAX_PHOTO_BYTES + 1);
    big.set(photo);
    vi.mocked(reencodeWithoutMetadata).mockResolvedValueOnce({
      master: big,
      thumb: new Uint8Array(8),
      contentType: 'image/jpeg',
      width: 60,
      height: 30,
    });
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      message: 'invalid_image',
    });
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('a re-encode that answers another format than the upload: refused, deleted, nothing recorded', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    vi.mocked(reencodeWithoutMetadata).mockResolvedValueOnce({
      master: await phonePhoto('png'),
      thumb: new Uint8Array(8),
      contentType: 'image/jpeg',
      width: 60,
      height: 30,
    });
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      message: 'invalid_image',
    });
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('at the cap: refused before anything is read whole or re-encoded, deleted', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, inserted } = setup({ live: 8 });

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({ code: 'conflict' });
    expect(vi.mocked(reencodeWithoutMetadata)).not.toHaveBeenCalled();
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('the database refuses the row after the write-back: the files are deleted (as before), nothing recorded', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, inserted } = setup({
      insert: { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } },
    });

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(inserted).toHaveLength(1); // attempted, refused
    expect(bucket.objects.has(`${stem}.jpg`)).toBe(false);
    expect(bucket.objects.has(THUMB)).toBe(false);
  });

  it('a racing finalize won the row (23505 after the write-back): nothing is deleted, and what is stored is clean', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc } = setup({
      insert: { data: null, error: { message: 'duplicate key', code: '23505' } },
    });

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'conflict',
      message: 'This photo was already recorded.',
    });
    expect(bucket.calls.remove).toEqual([]);
    await expectNoMetadata(bucket.bytes(`${stem}.jpg`)!, 'photo');
    await expectNoMetadata(bucket.bytes(THUMB)!, 'thumbnail');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the finalize limiter (each finalize now decodes and re-encodes up to 10 MB)', () => {
  it('is 30 a minute per person and FAILS CLOSED (literal pin)', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc } = setup();
    await svc.finalize(REQ, finalizeArgs('jpeg'));
    expect(limiter.calls).toEqual([
      { key: 'maintenance:finalize:user-test', limit: 30, windowMs: 60_000, mode: 'closed' },
    ]);
  });

  it('refused: conflict, nothing read or re-encoded, the upload and the client thumbnail deleted (a maintenance retry starts from a new mint)', async () => {
    limiter.allowed = false;
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({ code: 'conflict' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(bucket.calls.download).toEqual([]);
    expect(vi.mocked(reencodeWithoutMetadata)).not.toHaveBeenCalled();
    expect(bucket.objects.size).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a recorded photo is never rewritten or deleted by a later finalize', () => {
  const recordedJpg = () => [
    { organization_id: ORG, storage_path: `${stem}.jpg`, thumbnail_path: THUMB },
  ];

  it.each([
    ['under the cap', 0],
    ['at the cap', 8],
  ])('finalizing a recorded path again (%s): "already recorded", its files byte-identical, nothing read, written or deleted', async (_l, live) => {
    const photo = await phonePhoto('jpeg');
    const thumb = new Uint8Array(await sharp(Buffer.from(photo)).webp().toBuffer());
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    bucket.put(THUMB, thumb, 'image/webp');
    const { svc, inserted } = setup({ recorded: recordedJpg(), live });

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'conflict',
      message: 'This photo was already recorded.',
    });
    expect(bucket.bytes(`${stem}.jpg`)).toEqual(photo);
    expect(bucket.bytes(THUMB)).toEqual(thumb);
    expect(bucket.calls.upload).toEqual([]);
    expect(bucket.calls.remove).toEqual([]);
    expect(bucket.calls.download).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it("another extension of a recorded upload's uuid: forbidden, only that upload deleted, the recorded photo and its thumbnail untouched", async () => {
    const photo = await phonePhoto('jpeg');
    const thumb = new Uint8Array(await sharp(Buffer.from(photo)).webp().toBuffer());
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    bucket.put(THUMB, thumb, 'image/webp');
    bucket.put(`${stem}.png`, await phonePhoto('png', { color: '#ff00ff' }), 'image/png');
    const { svc, inserted } = setup({ recorded: recordedJpg() });

    await expect(svc.finalize(REQ, finalizeArgs('png'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(bucket.objects.has(`${stem}.png`)).toBe(false);
    expect(bucket.bytes(`${stem}.jpg`)).toEqual(photo);
    expect(bucket.bytes(THUMB)).toEqual(thumb);
    expect(bucket.calls.upload).toEqual([]);
    expect(bucket.calls.remove).toEqual([[`${stem}.png`]]);
    expect(inserted).toHaveLength(0);
  });

  it('when the look itself fails: internal_error, nothing read, written or deleted', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, inserted } = setup({ recorded: 'error' });

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(bucket.calls.upload).toEqual([]);
    expect(bucket.calls.remove).toEqual([]);
    expect(bucket.calls.download).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it('the look is scoped to this org and asks for every extension of the upload name', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, admin } = setup();
    await svc.finalize(REQ, finalizeArgs('jpeg'));
    const args = admin.chainArgs.get('maintenance_request_attachments.select')!;
    expect(args).toContainEqual(['organization_id', ORG]);
    expect(args).toContainEqual([
      'storage_path',
      [`${stem}.jpg`, `${stem}.jpeg`, `${stem}.png`, `${stem}.webp`],
    ]);
  });
});
