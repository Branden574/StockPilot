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
/** The photo cap, lowered by the tests that need a photo to grow past it on
 *  re-encode (a real 10 MB case is a 30 MP photo; the rule is the same). */
const cap = vi.hoisted(() => ({ bytes: null as number | null }));
vi.mock('@stockpilot/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@stockpilot/core')>();
  return {
    ...real,
    get MAINTENANCE_MAX_PHOTO_BYTES() {
      return cap.bytes ?? real.MAINTENANCE_MAX_PHOTO_BYTES;
    },
  };
});
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
 * One service over one maintenance_request_attachments table. `recorded` is
 * what the table holds at the start (or 'error': every admin look fails);
 * `live` the per-kind count the cap reads; `insert` forces the insert's
 * answer. Otherwise the insert behaves like the table: a second row for the
 * same (organization_id, storage_path) answers 23505, and a written row is
 * seen by every later admin look ("is this upload recorded?").
 *   - `insertCommits`: the forced `insert` answer comes back, but the row IS
 *     written (an answer lost after the commit).
 *   - `recordAfterFirstLook`: another finalize records this row right after
 *     this finalize's step-0 look, so every later step sees it.
 *   - `lookFailsFrom`: the Nth admin look (1-based) and every later one fail.
 */
function setup(
  opts: {
    recorded?: Array<Record<string, unknown>> | 'error';
    live?: number;
    insert?: { data: unknown; error: { message: string; code?: string } | null };
    insertCommits?: boolean;
    recordAfterFirstLook?: Record<string, unknown>;
    lookFailsFrom?: number;
  } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const table: Array<Record<string, unknown>> =
    opts.recorded === 'error' ? [] : [...(opts.recorded ?? [])];
  const user = makeSupabaseStub({
    'maintenance_requests.select': { data: OPEN_REQUEST, error: null },
    'maintenance_request_attachments.select': { data: null, error: null, count: opts.live ?? 0 },
    'maintenance_request_attachments.insert': (call) => {
      const row = call.args[0]![0] as Record<string, unknown>;
      inserted.push(row);
      if (opts.insert) {
        if (opts.insertCommits) table.push(row);
        return opts.insert;
      }
      if (
        table.some((r) => r.organization_id === row.organization_id && r.storage_path === row.storage_path)
      ) {
        return { data: null, error: { message: 'duplicate key value', code: '23505' } };
      }
      table.push(row);
      return { data: { id: 'att-1' }, error: null };
    },
  });
  const serve = servedLikePostgrest(() => table);
  let looks = 0;
  const admin = makeSupabaseStub({
    'maintenance_request_attachments.select': (call) => {
      looks += 1;
      if (opts.recorded === 'error' || (opts.lookFailsFrom !== undefined && looks >= opts.lookFailsFrom)) {
        return { data: null, error: { message: 'lookup failed' } };
      }
      const answer = serve(call);
      if (looks === 1 && opts.recordAfterFirstLook) table.push(opts.recordAfterFirstLook);
      return answer;
    },
  });
  admin.client.storage.from = vi.fn(() => bucket);
  adminHolder.client = admin.client;
  const ctx = makeServiceContext(user.client, { organizationId: ORG, enabledModules: ENABLED });
  return { svc: new MaintenanceAttachmentsService(ctx), user, admin, inserted, table, looks: () => looks };
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
  cap.bytes = null;
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

  it('the whole read is not the object the range read measured (another finalize wrote over it): "already being saved", nothing deleted, written or recorded', async () => {
    // Only the service role can change an upload once it is in the bucket
    // (the bucket has no UPDATE policy), so a changed object means another
    // finalize of this upload is writing it back. Deleting it here would
    // delete the photo that finalize is about to record (review 2026-09-27).
    const photo = await phonePhoto('jpeg', { width: 320, height: 240, noise: true });
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    bucket.downloadOverride = await phonePhoto('jpeg', { width: 20, height: 20 });
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'conflict',
      message: 'This photo is already being saved.',
    });
    expect(bucket.calls.upload).toEqual([]);
    expect(bucket.calls.remove).toEqual([]);
    expect(bucket.bytes(`${stem}.jpg`)).toEqual(photo);
    expect(bucket.objects.has(THUMB)).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a clean JPEG over the 10 MB cap even at the retry quality: refused, deleted, nothing recorded', async () => {
    const photo = await phonePhoto('jpeg');
    bucket.put(`${stem}.jpg`, photo, 'image/jpeg');
    const big = new Uint8Array(MAINTENANCE_MAX_PHOTO_BYTES + 1);
    big.set(photo);
    const tooBig = {
      master: big,
      thumb: new Uint8Array(8),
      contentType: 'image/jpeg' as const,
      width: 60,
      height: 30,
    };
    vi.mocked(reencodeWithoutMetadata).mockResolvedValueOnce(tooBig).mockResolvedValueOnce(tooBig);
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      message: 'invalid_image',
    });
    expect(vi.mocked(reencodeWithoutMetadata)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reencodeWithoutMetadata).mock.calls[1]![2]).toEqual({
      maxInputPixels: 50_000_000,
      quality: 75,
    });
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.jpg`, inserted);
  });

  it('a clean PNG over the cap: refused without a retry (PNG is lossless; a quality does not shrink it)', async () => {
    const photo = await phonePhoto('png');
    bucket.put(`${stem}.png`, photo, 'image/png');
    const big = new Uint8Array(MAINTENANCE_MAX_PHOTO_BYTES + 1);
    big.set(photo);
    vi.mocked(reencodeWithoutMetadata).mockResolvedValueOnce({
      master: big,
      thumb: new Uint8Array(8),
      contentType: 'image/png',
      width: 60,
      height: 30,
    });
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('png'))).rejects.toMatchObject({
      message: 'invalid_image',
    });
    expect(vi.mocked(reencodeWithoutMetadata)).toHaveBeenCalledTimes(1);
    expect(bucket.calls.upload).toEqual([]);
    await expectDeletedAndUnrecorded(`${stem}.png`, inserted);
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

// ═══════════════════════════════════════════════════════════════════════════
/**
 * Review 2026-09-27, finding 1: a small file can decode to a very large image
 * (measured on sharp 0.35.4: a 178 KB 10000x10000 WEBP with orientation 6
 * peaked at 1.78 GB of memory in the re-encode). Maintenance refuses a photo
 * over 50 megapixels (a 48 MP phone original is 48.8e6): before anything is
 * read whole when the header gives the size (JPEG, PNG), and in the re-encode
 * itself, from the header, before any pixel is decoded (every format; WEBP's
 * size is not in the sniff).
 */
describe('a photo over 50 megapixels is refused before it is decoded', () => {
  /** A real frame header (SOF0) of the given size, then filler past the 4 KB
   *  range window, so reading it whole would take a download. */
  function jpegHeader(width: number, height: number): Uint8Array {
    const b = new Uint8Array(8192);
    b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
    return b;
  }
  /** A PNG signature and IHDR of the given size, then filler past 4 KB. */
  function pngHeader(width: number, height: number): Uint8Array {
    const b = new Uint8Array(8192);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, width);
    new DataView(b.buffer).setUint32(20, height);
    return b;
  }

  it.each([
    ['jpeg', () => jpegHeader(10000, 10000)],
    ['png', () => pngHeader(10000, 5001)],
  ] as const)(
    '%s whose header says more than 50e6 pixels: invalid_image, never read whole or re-encoded, deleted, the uploader told',
    async (kind, make) => {
      const bytes = make();
      const sniffed = sniffImage(bytes)!;
      expect(sniffed.kind).toBe(kind);
      expect(sniffed.width! * sniffed.height!).toBeGreaterThan(50_000_000);
      const path = `${stem}.${EXT[kind]}`;
      bucket.put(path, bytes, MIME[kind]);
      bucket.put(THUMB, clientThumb, 'image/jpeg');
      const { svc, inserted } = setup();

      await expect(svc.finalize(REQ, finalizeArgs(kind))).rejects.toMatchObject({
        code: 'validation_error',
        message: 'invalid_image',
      });
      expect(bucket.calls.download).toEqual([]);
      expect(vi.mocked(reencodeWithoutMetadata)).not.toHaveBeenCalled();
      expect(bucket.objects.has(path)).toBe(false);
      expect(bucket.objects.has(THUMB)).toBe(false);
      expect(bucket.calls.remove).toEqual([[path, THUMB]]);
      expect(inserted).toHaveLength(0);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'photo_rejected' }));
    },
  );

  it('exactly 50e6 pixels is not refused by the size rule (it goes on to be read whole)', async () => {
    bucket.put(`${stem}.jpg`, jpegHeader(10000, 5000), 'image/jpeg');
    const { svc } = setup();

    // The filler does not decode, so the re-encode refuses it later; what
    // matters here is that it got that far.
    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({ message: 'invalid_image' });
    expect(bucket.calls.download).toEqual([`${stem}.jpg`]);
    expect(vi.mocked(reencodeWithoutMetadata)).toHaveBeenCalledTimes(1);
  });

  it('the re-encode is always given the 50e6 limit (it refuses from the header, so a WEBP is covered too)', async () => {
    bucket.put(`${stem}.webp`, await phonePhoto('webp'), 'image/webp');
    const { svc } = setup();

    await svc.finalize(REQ, finalizeArgs('webp'));

    expect(vi.mocked(reencodeWithoutMetadata)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reencodeWithoutMetadata).mock.calls[0]!.slice(1)).toEqual([
      'webp',
      { maxInputPixels: 50_000_000 },
    ]);
  });

  it('a real 7072x7072 WEBP (50.01e6 pixels, 1972 bytes): refused by the re-encode from its header, deleted, nothing recorded', async () => {
    // Made with sharp 0.35.4: sharp({ create: { width: 7072, height: 7072,
    // channels: 3, background: '#0ac83c' } }).webp({ lossless: true }). Kept
    // as bytes because making it takes about 600 MB; reading its header is
    // cheap.
    const bytes = new Uint8Array(Buffer.from(WEBP_50MP_B64, 'base64'));
    const meta = await sharp(Buffer.from(bytes), { limitInputPixels: false }).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 7072, 7072]);
    expect(sniffImage(bytes)).toEqual({ kind: 'webp', width: null, height: null });
    bucket.put(`${stem}.webp`, bytes, 'image/webp');
    const { svc, inserted } = setup();

    await expect(svc.finalize(REQ, finalizeArgs('webp'))).rejects.toMatchObject({ message: 'invalid_image' });
    await expect(vi.mocked(reencodeWithoutMetadata).mock.results[0]!.value).resolves.toBeNull();
    expect(bucket.calls.upload).toEqual([]);
    expect(bucket.objects.has(`${stem}.webp`)).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

const WEBP_50MP_B64 =
  'UklGRqwHAABXRUJQVlA4TJ8HAAAvn9vnBgdQ5CqUp/9BExIk+H+7PSJSMwKSpP//yYj+J1Ag/v6jiMj47z///fef//77z3///ffff/777z///fef//7z33//+e+///z333///ee///7z33//+e+///77z3///ee///777z///fef//7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///vvvv//++++///7777///Pfff//9999///nvv//++++///7777///Pfff//9999//6cTAA==';

// ═══════════════════════════════════════════════════════════════════════════
/**
 * Review 2026-09-27, finding 3: the re-encode (quality 90) makes a photo that
 * was saved at a lower quality BIGGER, so one that fit under the cap before
 * could be refused. Measured on a 30 MP photo-like JPEG saved at quality 75:
 * 8.87 MB, 10.39 MB at 90 (over the 10 MB cap), 7.70 MB at 75. A JPEG or WEBP
 * over the cap is re-encoded once more at quality 75 before it is refused.
 * Here the cap is lowered to the original's size, so a 320x240 photo shows
 * the same thing with real sharp.
 */
describe('a lossy photo that grows past the cap when re-encoded is re-encoded once more at quality 75', () => {
  /** Photo-like (blurred noise, as camera grain), saved at a LOW quality, with GPS. */
  async function lowQualityPhoto(kind: 'jpeg' | 'webp', quality: number): Promise<Uint8Array> {
    const W = 320;
    const H = 240;
    const raw = Buffer.alloc(W * H * 3);
    let s = 12345;
    for (let i = 0; i < raw.length; i += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = s >> 23;
    }
    let img = sharp(raw, { raw: { width: W, height: H, channels: 3 } }).blur(0.8);
    img = kind === 'jpeg' ? img.jpeg({ quality }) : img.webp({ quality });
    return new Uint8Array(await img.withExif(EXIF).toBuffer());
  }

  it.each([
    ['jpeg', 75],
    ['webp', 70],
  ] as const)('%s saved at quality %i, exactly at the cap: stored clean and under the cap', async (kind, quality) => {
    const photo = await lowQualityPhoto(kind, quality);
    cap.bytes = photo.byteLength;
    const path = `${stem}.${EXT[kind]}`;
    bucket.put(path, photo, MIME[kind]);
    const { svc, inserted } = setup();

    await svc.finalize(REQ, finalizeArgs(kind));

    const calls = vi.mocked(reencodeWithoutMetadata).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![2]).toEqual({ maxInputPixels: 50_000_000, quality: 75 });
    // Not vacuous: the first (quality 90) re-encode really was over the cap.
    const first = (await vi.mocked(reencodeWithoutMetadata).mock.results[0]!.value)!;
    expect(first.master.byteLength).toBeGreaterThan(photo.byteLength);
    const stored = bucket.bytes(path)!;
    expect(stored.byteLength).toBeLessThanOrEqual(photo.byteLength);
    await expectNoMetadata(stored, `${kind} photo`);
    expect(sniffImage(stored)?.kind).toBe(kind);
    expect(inserted[0]).toMatchObject({ storage_path: path, byte_size: stored.byteLength });
  });

  it('a photo the first re-encode keeps under the cap is not re-encoded twice', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc } = setup();
    await svc.finalize(REQ, finalizeArgs('jpeg'));
    expect(vi.mocked(reencodeWithoutMetadata)).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * Review 2026-09-27, finding 2: two finalizes of the same upload at once. A
 * refusal deletes the upload and its thumbnail name, which are the files of
 * the photo a racing finalize records. So every refusal after step 0 looks
 * first: a photo recorded at this path keeps its files and the answer is
 * "already recorded"; a recorded sibling (another extension of the uuid)
 * keeps the shared thumbnail name; a failed look deletes nothing.
 */
describe('a refusal never deletes the files of a photo another finalize recorded', () => {
  it("the reviewer's interleaving: A writes back while B is between its range read and its whole read; A's photo keeps its files", async () => {
    const path = `${stem}.jpg`;
    const photo = await phonePhoto('jpeg', { width: 320, height: 240, noise: true });
    expect(photo.byteLength).toBeGreaterThan(4096);
    bucket.put(path, photo, 'image/jpeg');
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    const { svc, inserted, table } = setup();

    // Hold the SECOND whole read until the first finalize's write-back of the
    // photo has landed (B measured the original, then reads A's clean file).
    let signalUploaded!: () => void;
    const uploaded = new Promise<void>((r) => (signalUploaded = r));
    const realUpload = bucket.upload.bind(bucket);
    bucket.upload = async (p: string, b: Uint8Array, o?: { contentType?: string; upsert?: boolean }) => {
      const res = await realUpload(p, b, o);
      if (p === path) signalUploaded();
      return res;
    };
    const realDownload = bucket.download.bind(bucket);
    let downloads = 0;
    bucket.download = async (p: string) => {
      downloads += 1;
      if (downloads === 2) await uploaded;
      return realDownload(p);
    };

    const [a, b] = await Promise.allSettled([
      svc.finalize(REQ, finalizeArgs('jpeg')),
      svc.finalize(REQ, finalizeArgs('jpeg')),
    ]);

    expect(a).toEqual({ status: 'fulfilled', value: { id: 'att-1', width: 320, height: 240 } });
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
    expect(inserted).toHaveLength(1);
    expect(table.map((r) => r.storage_path)).toEqual([path]);
    expect(bucket.calls.remove).toEqual([]);
    await expectNoMetadata(bucket.bytes(path)!, 'photo');
    await expectNoMetadata(bucket.bytes(THUMB)!, 'thumbnail');
    expect(notify).not.toHaveBeenCalled();
  });

  /** Each refusal after step 0, and how to cause it. */
  const REFUSALS: Array<
    [string, { kind: Kind; declaredMime?: string; live?: number; bytes?: () => Promise<Uint8Array>; arrange?: () => void }]
  > = [
    ['the finalize limiter', { kind: 'jpeg', arrange: () => (limiter.allowed = false) }],
    ['the byte checks (declared type)', { kind: 'jpeg', declaredMime: 'image/png' }],
    ['the cap', { kind: 'jpeg', live: 8 }],
    [
      'the re-encode (bytes that do not decode)',
      {
        kind: 'jpeg',
        bytes: async () =>
          new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x1e, 0x00, 0x3c, 0x01, 0x00]),
      },
    ],
    ['the write-back', { kind: 'jpeg', arrange: () => bucket.failUpload.add(`${stem}.jpg`) }],
  ];

  async function arrange(
    how: (typeof REFUSALS)[number][1],
    extra: Parameters<typeof setup>[0],
  ): Promise<{ run: () => Promise<unknown>; photo: Uint8Array; inserted: Array<Record<string, unknown>> }> {
    const photo = how.bytes ? await how.bytes() : await phonePhoto(how.kind);
    bucket.put(`${stem}.${EXT[how.kind]}`, photo, MIME[how.kind]);
    bucket.put(THUMB, clientThumb, 'image/jpeg');
    how.arrange?.();
    const { svc, inserted } = setup({ live: how.live, ...extra });
    const args = { ...finalizeArgs(how.kind), ...(how.declaredMime ? { declaredMime: how.declaredMime } : {}) };
    return { run: () => svc.finalize(REQ, args), photo, inserted };
  }

  it.each(REFUSALS)(
    'refused by %s after another finalize recorded this upload: "already recorded", nothing deleted, the uploader not told',
    async (_label, how) => {
      const { run, photo, inserted } = await arrange(how, {
        recordAfterFirstLook: { organization_id: ORG, storage_path: `${stem}.jpg`, thumbnail_path: THUMB },
      });

      await expect(run()).rejects.toMatchObject({ code: 'conflict', message: 'This photo was already recorded.' });
      expect(bucket.calls.remove).toEqual([]);
      expect(bucket.objects.has(THUMB)).toBe(true);
      if (bucket.calls.upload.length === 0) expect(bucket.bytes(`${stem}.jpg`)).toEqual(photo);
      expect(inserted).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it.each(REFUSALS)(
    'refused by %s after a sibling upload (same uuid, .png) was recorded: only this upload is deleted, the shared thumbnail name kept',
    async (_label, how) => {
      const { run, inserted } = await arrange(how, {
        recordAfterFirstLook: { organization_id: ORG, storage_path: `${stem}.png`, thumbnail_path: THUMB },
      });

      await expect(run()).rejects.toBeInstanceOf(Error);
      expect(bucket.calls.remove).toEqual([[`${stem}.jpg`]]);
      expect(bucket.objects.has(`${stem}.jpg`)).toBe(false);
      expect(bucket.objects.has(THUMB)).toBe(true);
      expect(inserted).toHaveLength(0);
    },
  );

  it.each(REFUSALS)(
    'refused by %s when the look before deleting fails: nothing deleted, the refusal stands',
    async (_label, how) => {
      const { run, inserted } = await arrange(how, { lookFailsFrom: 2 });

      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toMatchObject({ message: 'This photo was already recorded.' });
      expect(bucket.calls.remove).toEqual([]);
      expect(bucket.objects.has(`${stem}.jpg`)).toBe(true);
      expect(bucket.objects.has(THUMB)).toBe(true);
      expect(inserted).toHaveLength(0);
    },
  );

  it('the insert is written but its answer is lost: "already recorded", the recorded files kept (clean)', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, inserted, table } = setup({
      insert: { data: null, error: { message: 'fetch failed' } },
      insertCommits: true,
    });

    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({
      code: 'conflict',
      message: 'This photo was already recorded.',
    });
    expect(inserted).toHaveLength(1);
    expect(table.map((r) => r.storage_path)).toEqual([`${stem}.jpg`]);
    expect(bucket.calls.remove).toEqual([]);
    await expectNoMetadata(bucket.bytes(`${stem}.jpg`)!, 'photo');
    await expectNoMetadata(bucket.bytes(THUMB)!, 'thumbnail');
  });

  it('a refusal with nothing recorded still deletes both files and asks only once more (one extra look, on the refusal path only)', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, looks } = setup({ live: 8 });
    await expect(svc.finalize(REQ, finalizeArgs('jpeg'))).rejects.toMatchObject({ code: 'conflict' });
    expect(bucket.calls.remove).toEqual([[`${stem}.jpg`, THUMB]]);
    expect(looks()).toBe(2);
  });

  it('a finalize that succeeds makes one look (step 0) and no other', async () => {
    bucket.put(`${stem}.jpg`, await phonePhoto('jpeg'), 'image/jpeg');
    const { svc, looks } = setup();
    await svc.finalize(REQ, finalizeArgs('jpeg'));
    expect(looks()).toBe(1);
  });
});
