import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY,
  EXCEPTION_EVIDENCE_NO_PERMISSION_COPY,
  EXCEPTION_EVIDENCE_NOTE_TOO_LONG_COPY,
  EXCEPTION_EVIDENCE_REASON_TOO_LONG_COPY,
  EXCEPTION_EVIDENCE_REMOVE_NOT_ALLOWED_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
  EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Security invariant (F1-4 photo evidence, listed in scripts/security-test.sh).
 *
 * ExceptionEvidenceService. The database (0375) is the authority and
 * has its own pgTAP proof; these pin what the SERVER owes it: the act gate
 * before anything, the limiter failing closed, the strict path before any
 * storage call, the bytes (not the client's word), the metadata stripped
 * from what is stored, the record through the service-role RPC, and the
 * upload deleted with no row on every refusal (and NOT deleted when it may
 * belong to a recorded row).
 *
 * Review findings 2026-09-27 pinned here: the thumbnail is named from a FRESH
 * uuid (never the upload's), so no finalize can reach a recorded photo's
 * thumbnail; a recorded photo's files are never deleted, whatever answer a
 * later finalize gets; refusals before the storage steps delete the
 * unrecorded upload too (it still carries its GPS); the finalize limiter is
 * the service's and fails CLOSED; the messages are core's.
 */

vi.mock('server-only', () => ({}));
const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

const limiter = vi.hoisted(() => ({
  allowed: true,
  calls: [] as Array<{ key: string; limit: number; windowMs: number; mode: string | undefined }>,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(
    async (key: string, limit: number, windowMs: number, mode?: 'open' | 'closed') => {
      limiter.calls.push({ key, limit, windowMs, mode });
      return { allowed: limiter.allowed, count: 1, resetAt: Date.now() + windowMs };
    },
  ),
}));

const access = vi.hoisted(() => ({ writableIds: ['wh-a'] as string[] }));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(async () => ({
      hasAllAccess: false,
      readableIds: ['wh-a'],
      writableIds: access.writableIds,
    })),
    assertWarehouseAccess: vi.fn(async (wh: string, op: string, ctx: { role: string }) => {
      if (op === 'write' && ctx.role === 'viewer') throw new ForbiddenError('viewer');
      if (!access.writableIds.includes(wh)) throw new ForbiddenError('no write');
    }),
  };
});

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

import { audit } from './audit';
import { ExceptionEvidenceService, normalizeCapturedAt } from './exception-evidence';

const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const OCC = '11111111-1111-4111-8111-111111111111';
const OTHER_OCC = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const EVID = '44444444-4444-4444-8444-444444444444';
const PATH = `${ORG}/${OCC}/${FILE}.jpg`;
/** The name a thumbnail was derived as before the review: shared by every
 *  extension of FILE. Nothing may ever touch it now. */
const DERIVED_THUMB = `${ORG}/${OCC}/${FILE}-thumb.webp`;
/** Another finalize's thumbnail (the one a recorded row names). */
const OTHER_THUMB = `${ORG}/${OCC}/66666666-6666-4666-8666-666666666666-thumb.webp`;
const FRESH_THUMB = new RegExp(
  `^${ORG}/${OCC}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-thumb\\.webp$`,
);

let gpsJpeg: Buffer;
let pngBytes: Buffer;

beforeAll(async () => {
  gpsJpeg = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'SvcCam' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '37/1 46/1 30/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '122/1 25/1 10/1',
      },
    })
    .toBuffer();
  pngBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
});

function occRow(o: Record<string, unknown> = {}) {
  return {
    id: OCC,
    occurrence_number: 7,
    rule: 'label_mismatch',
    item_id: 'item-1',
    location_id: null,
    warehouse_id: 'wh-a',
    facts: {},
    condition_since: null,
    first_seen_at: '2026-09-27T10:00:00Z',
    last_seen_at: '2026-09-27T10:00:00Z',
    acknowledged_at: null,
    acknowledged_by: null,
    recount_cycle_count_id: null,
    resolved_at: null,
    resolved_reason: null,
    previous_occurrence_id: null,
    recurrence_index: 0,
    item: { name: 'Atlas', sku: 'A1' },
    location: null,
    recount: null,
    acknowledger: null,
    ...o,
  };
}

type RpcResult = { data: unknown; error: { message: string; code?: string; hint?: string } | null };

/**
 * One service with a user client (ctx) and a service-role client (admin).
 *   occurrence: the row the caller's RLS read returns (null = not visible)
 *   live:       the live-photo head count (or an error)
 *   recorded:   the admin's "is this path recorded?" answer(s), in order
 *   rpc:        exception_evidence_record's answer
 *   object:     the stored bytes the admin download returns (null = none)
 */
function setup(
  opts: {
    role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
    userId?: string;
    occurrence?: Record<string, unknown> | null;
    live?: number | 'error';
    /** The admin's "is this upload recorded?" answers, in order. 'ours' is
     *  a row for PATH naming the thumbnail THIS finalize wrote; 'theirs' a
     *  row for PATH naming another finalize's thumbnail. */
    recorded?: Array<Record<string, unknown> | null | 'error' | 'ours' | 'theirs'>;
    rpc?: RpcResult;
    object?: Uint8Array | null;
    uploadError?: boolean;
    evidenceRow?: Record<string, unknown> | null;
    removeRpc?: RpcResult;
  } = {},
) {
  const user = makeSupabaseStub({
    'exception_occurrences.select.maybeSingle': {
      data: opts.occurrence === undefined ? occRow() : opts.occurrence,
      error: null,
    },
    'exception_evidence.select':
      opts.live === 'error'
        ? { data: null, error: { message: 'count failed' }, count: null }
        : { data: null, error: null, count: opts.live ?? 0 },
    'exception_evidence.select.maybeSingle': {
      data:
        opts.evidenceRow === undefined
          ? {
              id: EVID,
              occurrence_id: OCC,
              uploaded_by: opts.userId ?? 'user-test',
              removed_at: null,
            }
          : opts.evidenceRow,
      error: null,
    },
    'rpc:exception_evidence_remove': opts.removeRpc ?? {
      data: { id: EVID, removed_at: '2026-09-27T12:00:00Z' },
      error: null,
    },
  });
  const createSignedUploadUrl = vi.fn(async (_path: string) => ({
    data: { signedUrl: 'https://mock/upload', token: 'tok' },
    error: null,
  }));
  user.client.storage.from = vi.fn(() => ({ createSignedUploadUrl }));

  const recorded = [...(opts.recorded ?? [null])];
  const rowFor = (thumb: string | undefined) => ({
    id: EVID,
    storage_path: PATH,
    thumbnail_path: thumb ?? null,
    content_type: 'image/jpeg',
    byte_size: 99,
    captured_at: null,
    created_at: '2026-09-27T12:00:00Z',
    removed_at: null,
  });
  const admin = makeSupabaseStub({
    'exception_evidence.select.maybeSingle': () => {
      const next = recorded.length > 1 ? recorded.shift()! : recorded[0]!;
      if (next === 'error') return { data: null, error: { message: 'lookup failed' } };
      if (next === 'ours') return { data: rowFor(writtenThumb()), error: null };
      if (next === 'theirs') return { data: rowFor(OTHER_THUMB), error: null };
      return { data: next, error: null };
    },
    'rpc:exception_evidence_record': opts.rpc ?? {
      data: {
        id: EVID,
        content_type: 'image/jpeg',
        byte_size: 1234,
        captured_at: null,
        created_at: '2026-09-27T12:00:00Z',
        removed_at: null,
      },
      error: null,
    },
  });
  const object = opts.object === undefined ? new Uint8Array(gpsJpeg) : opts.object;
  const storage = {
    download: vi.fn(async () =>
      object
        ? { data: { arrayBuffer: async () => object.slice().buffer }, error: null }
        : { data: null, error: { message: 'Object not found' } },
    ),
    upload: vi.fn(async (_path: string, _body: Uint8Array, _o: unknown) =>
      opts.uploadError
        ? { data: null, error: { message: 'write failed' } }
        : { data: { path: _path }, error: null },
    ),
    remove: vi.fn(async () => ({ data: null, error: null })),
    createSignedUrls: vi.fn(),
  };
  admin.client.storage.from = vi.fn(() => storage);
  adminHolder.client = admin.client;
  function writtenThumb(): string | undefined {
    return storage.upload.mock.calls.map((c) => c[0]).find((p) => p.endsWith('-thumb.webp'));
  }

  const ctx = makeServiceContext(user.client, {
    organizationId: ORG,
    role: opts.role ?? 'staff',
    userId: opts.userId,
  });
  return {
    svc: new ExceptionEvidenceService(ctx as never),
    user,
    admin,
    storage,
    createSignedUploadUrl,
    writtenThumb,
  };
}

/** Every path any storage call touched (downloads, uploads, removals). */
function touched(storage: ReturnType<typeof setup>['storage']): string[] {
  return [
    ...storage.download.mock.calls.map((c) => (c as unknown[])[0] as string),
    ...storage.upload.mock.calls.map((c) => c[0]),
    ...storage.remove.mock.calls.flatMap((c) => (c as unknown as [string[]])[0]),
  ];
}

const recordArgs = (admin: ReturnType<typeof makeSupabaseStub>) =>
  admin.rpcCalls.find((c) => c.name === 'exception_evidence_record')?.args as
    Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowed = true;
  limiter.calls = [];
  access.writableIds = ['wh-a'];
});

// ═══════════════════════════════════════════════════════════════════════════
describe('createUploadUrl', () => {
  it("mints one signed upload for {org}/{occurrence}/{uuid}.{ext}, with the caller's own session", async () => {
    const { svc, createSignedUploadUrl, user } = setup();
    const t = await svc.createUploadUrl(OCC, { fileExt: 'JPG' });
    expect(t.path).toMatch(new RegExp(`^${ORG}/${OCC}/[0-9a-f-]{36}\\.jpg$`));
    expect(t.contentType).toBe('image/jpeg');
    expect(t.maxBytes).toBe(10 * 1024 * 1024);
    expect(createSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUploadUrl).toHaveBeenCalledWith(t.path);
    // The occurrence was read through the caller's client, scoped to the org.
    expect(user.chainArgs.get('exception_occurrences.select')).toContainEqual([
      'organization_id',
      ORG,
    ]);
  });

  it('the limiter is 60 an hour per person and FAILS CLOSED (literal pin: mode "closed")', async () => {
    const { svc } = setup();
    await svc.createUploadUrl(OCC, { fileExt: 'jpg' });
    expect(limiter.calls).toEqual([
      {
        key: 'exceptions:evidence:upload:user-test',
        limit: 60,
        windowMs: 3_600_000,
        mode: 'closed',
      },
    ]);
  });

  it('refuses when the limiter says no (as it does when it cannot answer, in closed mode), minting nothing', async () => {
    limiter.allowed = false;
    const { svc, createSignedUploadUrl } = setup();
    await expect(svc.createUploadUrl(OCC, { fileExt: 'jpg' })).rejects.toMatchObject({
      code: 'conflict',
      message: EXCEPTION_EVIDENCE_UPLOAD_LIMIT_COPY,
      details: { reason: 'rate_limited' },
    });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses at 8 live photos (the count ignores removed ones)', async () => {
    const { svc, user, createSignedUploadUrl } = setup({ live: 8 });
    await expect(svc.createUploadUrl(OCC, { fileExt: 'jpg' })).rejects.toMatchObject({
      code: 'conflict',
      message: EXCEPTION_EVIDENCE_CAP_COPY,
      details: { reason: 'evidence_limit_reached' },
    });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    const countArgs = user.chainArgs.get('exception_evidence.select')!;
    expect(countArgs).toContainEqual(['removed_at', null]);
    expect(countArgs).toContainEqual(['occurrence_id', OCC]);
    expect(countArgs).toContainEqual(['organization_id', ORG]);
  });

  it('a failed count is an error, never room to spare', async () => {
    const { svc, createSignedUploadUrl } = setup({ live: 'error' });
    await expect(svc.createUploadUrl(OCC, { fileExt: 'jpg' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses HEIC and anything outside jpg/jpeg/png/webp before spending the limiter', async () => {
    for (const ext of ['heic', 'gif', 'svg', 'jpg.html']) {
      const { svc } = setup();
      await expect(svc.createUploadUrl(OCC, { fileExt: ext })).rejects.toMatchObject({
        code: 'validation_error',
      });
    }
    expect(limiter.calls).toEqual([]);
  });

  it('a resolved occurrence takes no photos', async () => {
    const { svc, createSignedUploadUrl } = setup({
      occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }),
    });
    await expect(svc.createUploadUrl(OCC, { fileExt: 'jpg' })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'occurrence_resolved' },
    });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('the act gate: a viewer, staff without write access, and an invisible occurrence are refused', async () => {
    await expect(
      setup({ role: 'viewer' }).svc.createUploadUrl(OCC, { fileExt: 'jpg' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    access.writableIds = ['wh-b'];
    await expect(setup().svc.createUploadUrl(OCC, { fileExt: 'jpg' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    access.writableIds = ['wh-a'];
    await expect(
      setup({ occurrence: null }).svc.createUploadUrl(OCC, { fileExt: 'jpg' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    // No warehouse on the occurrence: a manager's call.
    await expect(
      setup({ occurrence: occRow({ warehouse_id: null }) }).svc.createUploadUrl(OCC, {
        fileExt: 'jpg',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      setup({ role: 'manager', occurrence: occRow({ warehouse_id: null }) }).svc.createUploadUrl(
        OCC,
        { fileExt: 'jpg' },
      ),
    ).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('finalize', () => {
  it('records through the service-role RPC as the caller, with a FRESH thumbnail and the stored size', async () => {
    const { svc, admin, storage, writtenThumb } = setup();
    const res = await svc.finalize(OCC, {
      path: PATH,
      declaredMime: 'image/jpeg',
      capturedAt: '2026-09-27T11:50:00Z',
      note: '  shelf empty  ',
    });
    expect(res.id).toBe(EVID);
    const args = recordArgs(admin)!;
    const stored = storage.upload.mock.calls.find((c) => c[0] === PATH)![1] as Uint8Array;
    const thumb = writtenThumb()!;
    expect(thumb).toMatch(FRESH_THUMB);
    expect(thumb).not.toBe(DERIVED_THUMB);
    expect(args).toEqual({
      p_occurrence_id: OCC,
      p_uploaded_by: 'user-test',
      p_storage_path: PATH,
      p_thumbnail_path: thumb,
      p_content_type: 'image/jpeg',
      p_byte_size: stored.byteLength,
      p_captured_at: '2026-09-27T11:50:00.000Z',
      p_note: 'shelf empty',
    });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'exception.evidence_added',
        entityType: 'exception_occurrence',
        entityId: OCC,
      }),
      expect.anything(),
    );
  });

  it('each finalize names its own thumbnail: two uploads never share one', async () => {
    const a = setup();
    await a.svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' });
    const b = setup();
    await b.svc.finalize(OCC, { path: `${ORG}/${OCC}/${FILE}.jpeg`, declaredMime: 'image/jpeg' });
    expect(a.writtenThumb()).toMatch(FRESH_THUMB);
    expect(b.writtenThumb()).toMatch(FRESH_THUMB);
    expect(a.writtenThumb()).not.toBe(b.writtenThumb());
  });

  it('PRIVACY: what is written back over the upload carries no EXIF, no GPS, no camera make', async () => {
    expect((await sharp(gpsJpeg).metadata()).exif).toBeDefined();
    const { svc, storage, writtenThumb } = setup();
    await svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' });
    const [, master, masterOpts] = storage.upload.mock.calls.find((c) => c[0] === PATH)!;
    const meta = await sharp(Buffer.from(master as Uint8Array)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Buffer.from(master as Uint8Array).includes(Buffer.from('SvcCam'))).toBe(false);
    // Over the upload itself, so the original bytes are gone.
    expect(masterOpts).toEqual({ contentType: 'image/jpeg', upsert: true });
    const [, thumb, thumbOpts] = storage.upload.mock.calls.find((c) => c[0] === writtenThumb())!;
    expect((await sharp(Buffer.from(thumb as Uint8Array)).metadata()).format).toBe('webp');
    // A thumbnail never replaces an existing object.
    expect(thumbOpts).toEqual({ contentType: 'image/webp', upsert: false });
  });

  it('a PNG declared as JPEG: the upload is deleted and no row is written', async () => {
    const { svc, admin, storage } = setup({ object: new Uint8Array(pngBytes) });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'invalid_image' },
    });
    expect(storage.remove).toHaveBeenCalledWith([PATH]);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(recordArgs(admin)).toBeUndefined();
  });

  it('bytes that are no image at all, an empty object, one over 10 MB, and one never uploaded: deleted, no row', async () => {
    const cases: Array<Uint8Array | null> = [
      new TextEncoder().encode('<html><script>alert(1)</script></html>'),
      new Uint8Array(0),
      (() => {
        const b = new Uint8Array(10 * 1024 * 1024 + 1);
        b.set(gpsJpeg);
        return b;
      })(),
      null,
    ];
    for (const object of cases) {
      const { svc, admin, storage } = setup({ object });
      await expect(
        svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
      ).rejects.toMatchObject({
        code: 'validation_error',
      });
      expect(storage.remove).toHaveBeenCalledWith([PATH]);
      expect(recordArgs(admin)).toBeUndefined();
    }
  });

  it("a declared type that disagrees with the path's extension deletes only that upload, never a derived thumbnail", async () => {
    const { svc, admin, storage } = setup();
    await expect(
      svc.finalize(OCC, { path: `${ORG}/${OCC}/${FILE}.png`, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(storage.remove).toHaveBeenCalledWith([`${ORG}/${OCC}/${FILE}.png`]);
    expect(touched(storage)).not.toContain(DERIVED_THUMB);
    expect(recordArgs(admin)).toBeUndefined();
  });

  it.each(['png', 'jpeg'])(
    "THUMBNAIL SAFETY: {uuid}.%s against a recorded {uuid}.jpg is refused and touches none of the recorded photo's files",
    async (ext) => {
      const sibling = `${ORG}/${OCC}/${FILE}.${ext}`;
      const recordedJpg = {
        id: EVID,
        storage_path: PATH,
        thumbnail_path: OTHER_THUMB,
        content_type: 'image/jpeg',
        byte_size: 99,
        captured_at: null,
        created_at: '2026-09-27T12:00:00Z',
        removed_at: null,
      };
      const { svc, admin, storage } = setup({ recorded: [recordedJpg] });
      await expect(
        svc.finalize(OCC, {
          path: sibling,
          declaredMime: ext === 'png' ? 'image/png' : 'image/jpeg',
        }),
      ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'invalid_path' } });
      // Only the sibling upload itself (never recorded) is removed.
      expect(storage.remove.mock.calls).toEqual([[[sibling]]]);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(storage.download).not.toHaveBeenCalled();
      for (const p of [PATH, OTHER_THUMB, DERIVED_THUMB]) expect(touched(storage)).not.toContain(p);
      expect(recordArgs(admin)).toBeUndefined();
      // The lookup asked for every extension of the upload name.
      expect(admin.chainArgs.get('exception_evidence.select')).toContainEqual([
        'storage_path',
        [
          PATH,
          `${ORG}/${OCC}/${FILE}.jpeg`,
          `${ORG}/${OCC}/${FILE}.png`,
          `${ORG}/${OCC}/${FILE}.webp`,
        ],
      ]);
    },
  );

  it('a path outside this occurrence, or not server-shaped, is refused BEFORE any storage call', async () => {
    const bad = [
      `${ORG}/${OTHER_OCC}/${FILE}.jpg`,
      `${ORG}/${OCC}/../${OTHER_OCC}/${FILE}.jpg`,
      `${ORG}/${OCC}/photo.jpg`,
      `99999999-9999-4999-8999-999999999999/${OCC}/${FILE}.jpg`,
      `${ORG}/${OCC}/${FILE}-thumb.webp`,
    ];
    for (const path of bad) {
      const { svc, storage, admin } = setup();
      await expect(svc.finalize(OCC, { path, declaredMime: 'image/jpeg' })).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'invalid_path' },
      });
      expect(storage.download).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(admin.fromCalls).toEqual([]);
    }
    expect(limiter.calls).toEqual([]);
  });

  it('an ALREADY RECORDED path is refused before anything touches storage (a recorded photo is never rewritten)', async () => {
    const { svc, storage, admin } = setup({ recorded: ['theirs'] });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'already_recorded' },
    });
    expect(touched(storage)).toEqual([]);
    expect(recordArgs(admin)).toBeUndefined();
  });

  it('at the cap the upload is refused and deleted before it is read or re-encoded (core copy)', async () => {
    const { svc, storage, admin } = setup({ live: 8 });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      message: EXCEPTION_EVIDENCE_CAP_COPY,
      details: { reason: 'evidence_limit_reached' },
    });
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([PATH]);
    expect(recordArgs(admin)).toBeUndefined();
  });

  it.each([
    ['42501', undefined, 'forbidden', undefined, EXCEPTION_EVIDENCE_NO_PERMISSION_COPY],
    ['P0002', undefined, 'not_found', undefined, undefined],
    [
      'P0001',
      'occurrence_resolved',
      'conflict',
      'occurrence_resolved',
      EXCEPTION_EVIDENCE_RESOLVED_COPY,
    ],
    [
      'P0001',
      'evidence_limit_reached',
      'conflict',
      'evidence_limit_reached',
      EXCEPTION_EVIDENCE_CAP_COPY,
    ],
    ['22023', 'invalid_path', 'validation_error', 'invalid_path', undefined],
    ['55P03', undefined, 'conflict', 'busy', undefined],
  ])(
    'the RPC refuses (%s %s) and nothing is recorded for the path: the upload and THIS thumbnail are deleted',
    async (code, hint, want, reason, message) => {
      const { svc, storage, writtenThumb } = setup({
        rpc: { data: null, error: { message: 'refused', code, hint } },
      });
      const err = await svc
        .finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' })
        .catch((e) => e);
      expect(err).toMatchObject({ code: want });
      if (reason) expect(err.details).toMatchObject({ reason });
      if (message) expect(err.message).toBe(message);
      expect(storage.remove).toHaveBeenCalledWith([PATH, writtenThumb()]);
    },
  );

  it.each([
    ['P0001', 'evidence_limit_reached'],
    ['P0001', 'occurrence_resolved'],
    ['42501', undefined],
  ])(
    'RACE: the RPC refuses (%s %s) but a racing finalize has recorded this upload: its file is KEPT, only this thumbnail goes, and the answer is already_recorded',
    async (code, hint) => {
      const { svc, storage, writtenThumb } = setup({
        recorded: [null, 'theirs'],
        rpc: { data: null, error: { message: 'refused', code, hint } },
      });
      await expect(
        svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
      ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'already_recorded' } });
      expect(storage.remove.mock.calls).toEqual([[[writtenThumb()]]]);
      expect(storage.remove.mock.calls.flat(2)).not.toContain(PATH);
      expect(storage.remove.mock.calls.flat(2)).not.toContain(OTHER_THUMB);
    },
  );

  it('a unique violation (a racing finalize won): its file is left alone and only this thumbnail goes', async () => {
    const { svc, storage, writtenThumb } = setup({
      recorded: [null, 'theirs'],
      rpc: { data: null, error: { message: 'duplicate', code: '23505', hint: 'already_recorded' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      details: { reason: 'already_recorded' },
    });
    expect(storage.remove.mock.calls).toEqual([[[writtenThumb()]]]);
  });

  it('a unique violation when the check then fails: NOTHING is deleted', async () => {
    const { svc, storage } = setup({
      recorded: [null, 'error'],
      rpc: { data: null, error: { message: 'duplicate', code: '23505', hint: 'already_recorded' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toBeTruthy();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });

  it('a unique violation with no row for this path (another name collided): the upload and this thumbnail go', async () => {
    const { svc, storage, writtenThumb } = setup({
      recorded: [null, null],
      rpc: { data: null, error: { message: 'duplicate', code: '23505' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(storage.remove).toHaveBeenCalledWith([PATH, writtenThumb()]);
  });

  it('a LOST answer: when the row turns out to be recorded with this thumbnail, finalize succeeds and deletes nothing', async () => {
    const { svc, storage } = setup({
      recorded: [null, 'ours'],
      rpc: { data: null, error: { message: 'TypeError: fetch failed' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).resolves.toMatchObject({ id: EVID });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('a LOST answer and a racing finalize recorded it: already_recorded, and only this thumbnail goes', async () => {
    const { svc, storage, writtenThumb } = setup({
      recorded: [null, 'theirs'],
      rpc: { data: null, error: { message: 'TypeError: fetch failed' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({ details: { reason: 'already_recorded' } });
    expect(storage.remove.mock.calls).toEqual([[[writtenThumb()]]]);
  });

  it('a LOST answer with no row: deleted, and reported as a failure', async () => {
    const { svc, storage, writtenThumb } = setup({
      recorded: [null, null],
      rpc: { data: null, error: { message: 'TypeError: fetch failed' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(storage.remove).toHaveBeenCalledWith([PATH, writtenThumb()]);
  });

  it('a LOST answer and the check itself fails: the file is KEPT (never delete what may be recorded)', async () => {
    const { svc, storage } = setup({
      recorded: [null, 'error'],
      rpc: { data: null, error: { message: 'TypeError: fetch failed' } },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });

  it('no error and no row is not a success (pattern #2)', async () => {
    const { svc, storage, writtenThumb } = setup({
      recorded: [null, null],
      rpc: { data: null, error: null },
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(storage.remove).toHaveBeenCalledWith([PATH, writtenThumb()]);
  });

  it('a failed write-back deletes the upload and this thumbnail and records nothing', async () => {
    const { svc, storage, admin, writtenThumb } = setup({ uploadError: true });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(storage.remove).toHaveBeenCalledWith([PATH, writtenThumb()]);
    expect(recordArgs(admin)).toBeUndefined();
  });

  // ── Refusals before the storage steps (review finding 2026-09-27) ────────
  // The upload is still the ORIGINAL (EXIF and GPS included): it is deleted
  // like any other refused upload, unless a photo is recorded at that path.

  it('a note over 500 characters: refused before any read, and the unrecorded upload is deleted (core copy)', async () => {
    const { svc, storage } = setup();
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg', note: 'n'.repeat(501) }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: EXCEPTION_EVIDENCE_NOTE_TOO_LONG_COPY,
      details: { reason: 'note_too_long' },
    });
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([PATH]);
  });

  it('an unreadable capture time: refused, and the unrecorded upload is deleted', async () => {
    const { svc, storage } = setup();
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg', capturedAt: 'yesterday' }),
    ).rejects.toMatchObject({ details: { reason: 'invalid_captured_at' } });
    expect(storage.remove).toHaveBeenCalledWith([PATH]);
  });

  it('the occurrence resolved since the mint: refused before any read, and the unrecorded upload is deleted (core copy)', async () => {
    const { svc, storage } = setup({
      occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }),
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      message: EXCEPTION_EVIDENCE_RESOLVED_COPY,
      details: { reason: 'occurrence_resolved' },
    });
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([PATH]);
  });

  it('resolved since, but THIS upload was recorded (a lost answer): nothing is deleted and the answer is already_recorded', async () => {
    const { svc, storage } = setup({
      occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }),
      recorded: ['theirs'],
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({ details: { reason: 'already_recorded' } });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('access removed since the mint (a viewer now, or the warehouse taken away) or the row gone: the unrecorded upload is deleted', async () => {
    for (const make of [
      () => setup({ role: 'viewer' }),
      () => {
        access.writableIds = ['wh-b'];
        return setup();
      },
      () => setup({ occurrence: null }),
    ]) {
      const { svc, storage } = make();
      await expect(
        svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(forbidden|not_found)$/),
      });
      expect(storage.remove).toHaveBeenCalledWith([PATH]);
      access.writableIds = ['wh-a'];
    }
  });

  it('a refusal for a caller without access never reveals or deletes a RECORDED photo', async () => {
    const { svc, storage } = setup({ role: 'viewer', recorded: ['theirs'] });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('when the "is it recorded" check fails after a refusal, the upload is KEPT and the refusal still stands', async () => {
    const { svc, storage } = setup({
      occurrence: occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' }),
      recorded: ['error'],
    });
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toMatchObject({
      details: { reason: 'occurrence_resolved' },
    });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('a database fault reading the occurrence deletes nothing (a retry of this finalize can still record it)', async () => {
    const { svc, storage, user } = setup();
    user.client.from = vi.fn(() => {
      throw new Error('socket hang up');
    }) as never;
    await expect(
      svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }),
    ).rejects.toBeTruthy();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  // ── The finalize limiter (review finding 2026-09-27) ─────────────────────

  it("the finalize limiter is the SERVICE's (route and web action share it), 30 a minute per person, and FAILS CLOSED", async () => {
    const { svc } = setup();
    await svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' });
    expect(limiter.calls).toEqual([
      {
        key: 'exceptions:evidence:finalize:user-test',
        limit: 30,
        windowMs: 60_000,
        mode: 'closed',
      },
    ]);
  });

  it('refused by the limiter: nothing is read, written or deleted (the same finalize can be sent again), with its reset time', async () => {
    limiter.allowed = false;
    const { svc, storage, admin } = setup();
    const err = await svc.finalize(OCC, { path: PATH, declaredMime: 'image/jpeg' }).catch((e) => e);
    expect(err).toMatchObject({
      code: 'conflict',
      message: EXCEPTION_EVIDENCE_FINALIZE_LIMIT_COPY,
      details: { reason: 'rate_limited', retryAt: expect.any(Number) },
    });
    expect(touched(storage)).toEqual([]);
    expect(admin.fromCalls).toEqual([]);
    expect(recordArgs(admin)).toBeUndefined();
  });
});

describe('normalizeCapturedAt (the device clock)', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  it('keeps a readable time as ISO', () => {
    expect(normalizeCapturedAt('2026-09-27T11:02:00Z', now)).toBe('2026-09-27T11:02:00.000Z');
    expect(normalizeCapturedAt('2026-09-27T12:04:59Z', now)).toBe('2026-09-27T12:04:59.000Z');
  });
  it('drops a time more than 5 minutes ahead of the server (it cannot be when the photo was taken)', () => {
    expect(normalizeCapturedAt('2026-09-27T12:05:01Z', now)).toBeNull();
    expect(normalizeCapturedAt('2027-01-01T00:00:00Z', now)).toBeNull();
  });
  it('none is null; an unreadable one is refused, not guessed', () => {
    expect(normalizeCapturedAt(null, now)).toBeNull();
    expect(normalizeCapturedAt('', now)).toBeNull();
    expect(() => normalizeCapturedAt('yesterday', now)).toThrow(
      expect.objectContaining({ code: 'validation_error' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('remove', () => {
  it('the uploader removes their own photo through the RPC as themselves (never the service role)', async () => {
    const { svc, user, admin } = setup();
    const res = await svc.remove(OCC, EVID, '  blurry  ');
    expect(res).toEqual({ id: EVID, removedAt: '2026-09-27T12:00:00Z' });
    expect(user.rpcCalls).toEqual([
      { name: 'exception_evidence_remove', args: { p_id: EVID, p_reason: 'blurry' } },
    ]);
    expect(admin.rpcCalls).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'exception.evidence_removed', entityId: OCC }),
      expect.anything(),
    );
  });

  it('another staff member cannot remove it (core copy); a manager can', async () => {
    const other = setup({
      evidenceRow: { id: EVID, occurrence_id: OCC, uploaded_by: 'someone-else', removed_at: null },
    });
    await expect(other.svc.remove(OCC, EVID)).rejects.toMatchObject({
      code: 'forbidden',
      message: EXCEPTION_EVIDENCE_REMOVE_NOT_ALLOWED_COPY,
    });
    expect(other.user.rpcCalls).toEqual([]);
    const mgr = setup({
      role: 'manager',
      evidenceRow: { id: EVID, occurrence_id: OCC, uploaded_by: 'someone-else', removed_at: null },
    });
    await expect(mgr.svc.remove(OCC, EVID)).resolves.toMatchObject({ id: EVID });
  });

  it('the act gate applies to removal too: a viewer and staff without write access are refused', async () => {
    await expect(setup({ role: 'viewer' }).svc.remove(OCC, EVID)).rejects.toMatchObject({
      code: 'forbidden',
    });
    access.writableIds = [];
    await expect(setup().svc.remove(OCC, EVID)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a photo that is not on this occurrence (or not visible) is not found', async () => {
    const { svc, user } = setup({ evidenceRow: null });
    await expect(svc.remove(OCC, EVID)).rejects.toMatchObject({ code: 'not_found' });
    expect(user.rpcCalls).toEqual([]);
    expect(user.chainArgs.get('exception_evidence.select')).toContainEqual(['occurrence_id', OCC]);
  });

  it('a resolved occurrence refuses a live photo, but a repeat removal still answers (no audit)', async () => {
    const resolved = occRow({ resolved_at: '2026-09-27T11:00:00Z', resolved_reason: 'cleared' });
    await expect(setup({ occurrence: resolved }).svc.remove(OCC, EVID)).rejects.toMatchObject({
      message: EXCEPTION_EVIDENCE_RESOLVED_COPY,
      details: { reason: 'occurrence_resolved' },
    });
    const again = setup({
      occurrence: resolved,
      evidenceRow: {
        id: EVID,
        occurrence_id: OCC,
        uploaded_by: 'user-test',
        removed_at: '2026-09-27T10:30:00Z',
      },
      removeRpc: { data: { id: EVID, removed_at: '2026-09-27T10:30:00Z' }, error: null },
    });
    await expect(again.svc.remove(OCC, EVID)).resolves.toEqual({
      id: EVID,
      removedAt: '2026-09-27T10:30:00Z',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('an RPC answer without a removed row is not a success (pattern #2)', async () => {
    await expect(
      setup({ removeRpc: { data: null, error: null } }).svc.remove(OCC, EVID),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
    await expect(
      setup({ removeRpc: { data: { id: EVID, removed_at: null }, error: null } }).svc.remove(
        OCC,
        EVID,
      ),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it.each([
    ['42501', undefined, 'forbidden'],
    ['P0002', undefined, 'not_found'],
    ['P0001', 'occurrence_resolved', 'conflict'],
    ['22023', 'reason_too_long', 'validation_error'],
  ])('maps the RPC refusal %s %s', async (code, hint, want) => {
    const { svc } = setup({ removeRpc: { data: null, error: { message: 'x', code, hint } } });
    await expect(svc.remove(OCC, EVID)).rejects.toMatchObject({ code: want });
  });

  it('a reason over 500 characters is refused before anything is read', async () => {
    const { svc, user } = setup();
    await expect(svc.remove(OCC, EVID, 'r'.repeat(501))).rejects.toMatchObject({
      message: EXCEPTION_EVIDENCE_REASON_TOO_LONG_COPY,
      details: { reason: 'reason_too_long' },
    });
    expect(user.fromCalls).toEqual([]);
  });
});
