import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-file mocks — audit is side-effecting (writes via the admin client +
// reads request headers), so every service test stubs it and asserts on the
// call shape directly, matching maintenance-requests.test.ts (Task 8).
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));
// checkRateLimit hits the DB via an RPC on the admin client; stub it so
// mint tests run in isolation and can flip `allowed` per test.
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));

// finalize()/remove()/signedViewUrls() use the SERVICE-ROLE client (never
// ctx.supabase) for storage ops — download/remove/createSignedUrl are
// admin-only, matching order-attachments.ts and item-images.ts. The shared
// makeSupabaseStub()'s default storage.from() doesn't implement
// download/createSignedUploadUrl (po-imports.parse-suggest.test.ts's own
// comment: "the shared makeSupabaseStub doesn't implement it"), so the admin
// client is mocked directly here, same shape as item-images.test.ts.
const { createAdminClientMock, downloadMock, adminRemoveMock, adminCreateSignedUrlsMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  downloadMock: vi.fn(),
  adminRemoveMock: vi.fn(),
  // Minor 11 — signedViewUrls batches via createSignedUrls(paths, ttl)
  // instead of one createSignedUrl call per row; the mock matches the real
  // storage-js shape: { data: {error,path,signedUrl}[], error }.
  adminCreateSignedUrlsMock: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

import { DEFAULT_MODULE_IDS, MAINTENANCE_MAX_PHOTOS, MAINTENANCE_MAX_PHOTO_BYTES, type ModuleId } from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { audit } from './audit';
import { MaintenanceAttachmentsService } from './maintenance-attachments';

// `maintenance_requests` is `defaultOnFor: []` (0314) so it is NOT part of
// DEFAULT_MODULE_IDS — every test that expects success must opt it in
// explicitly (landmine #22, mirrored from maintenance-requests.test.ts).
const ENABLED_MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']);

function build(
  canned: Parameters<typeof makeSupabaseStub>[0] = {},
  overrides: Parameters<typeof makeServiceContext>[1] = {},
) {
  const stub = makeSupabaseStub(canned);
  const ctx = makeServiceContext(stub.client, { enabledModules: ENABLED_MODULES, ...overrides });
  return { stub, ctx };
}

/** Override the CTX (user-authed) client's storage.from() to add
 *  createSignedUploadUrl — the mint path signs with the caller's own
 *  session (0315's org-prefix INSERT policy), never the admin client. */
function stubCtxUploadStorage(stub: ReturnType<typeof makeSupabaseStub>) {
  const createSignedUploadUrl = vi.fn(async (_path: string) => ({
    data: { signedUrl: 'https://mock/upload-signed', token: 'tok-abc' },
    error: null,
  }));
  stub.client.storage.from = vi.fn(() => ({ createSignedUploadUrl }));
  return { createSignedUploadUrl };
}

/** Real byte fixtures, independently built from image-signature.test.ts's —
 *  this suite must not silently pass just because that file's builders
 *  changed shape. */
function pngBytes(width = 2, height = 3): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpegBytes(width = 4, height = 5): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff,
    width & 0xff, 0x01, 0x00,
  ]);
}
function blobFor(bytes: Uint8Array) {
  return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

const REQ_ID = '11111111-1111-4111-8111-111111111111';
const OPEN_REQUEST_ROW = { id: REQ_ID, requester_user_id: 'user-test', archived_at: null, cancelled_at: null };

/** A syntactically valid `crypto.randomUUID()`-shaped uuid — the strict
 *  finalize path validator (Critical 1a) now REQUIRES this exact shape
 *  between the request segment and the extension, so every finalize test
 *  that expects to reach the download/sniff/insert path must use one
 *  instead of an arbitrary short token like "abc". */
const UUID_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  vi.clearAllMocks();
  downloadMock.mockReset();
  adminRemoveMock.mockReset();
  adminCreateSignedUrlsMock.mockReset();
  createAdminClientMock.mockReturnValue({
    storage: {
      from: vi.fn(() => ({
        download: downloadMock,
        remove: adminRemoveMock,
        createSignedUrls: adminCreateSignedUrlsMock,
      })),
    },
  });
  downloadMock.mockResolvedValue({ data: null, error: { message: 'not stubbed for this test' } });
  adminRemoveMock.mockResolvedValue({ data: null, error: null });
  // Default: sign whatever paths were asked for, echoing each one back with
  // a stable stub URL — matches the real batch response shape (one entry
  // per requested path, keyed by `path`).
  adminCreateSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ error: null, path, signedUrl: 'https://mock/view-signed' })),
    error: null,
  }));
});

describe('createUploadUrl (mint)', () => {
  it('verifies the parent request is visible + open BEFORE minting (chainArgs pin), mints org/request-prefixed paths, and rate-limits per user', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null, count: 0 },
    });
    const { createSignedUploadUrl } = stubCtxUploadStorage(stub);

    const res = await new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, {
      fileExt: 'JPG',
      originalFilename: 'break-room.jpg',
    });

    // Parent-existence/ownership query happened, scoped to org + this request id.
    const selectArgs = stub.chainArgs.get('maintenance_requests.select')!;
    expect(selectArgs).toContainEqual(['organization_id', ctx.organizationId]);
    expect(selectArgs).toContainEqual(['id', REQ_ID]);

    // Paths follow the 0315 documented scheme exactly:
    // {organization_id}/{maintenance_request_id}/{uuid}.{ext} and -thumb.webp.
    expect(res.path).toMatch(new RegExp(`^${ctx.organizationId}/${REQ_ID}/[0-9a-f-]+\\.jpg$`));
    expect(res.thumbPath).toMatch(new RegExp(`^${ctx.organizationId}/${REQ_ID}/[0-9a-f-]+-thumb\\.webp$`));
    expect(res.signedUrl).toBe('https://mock/upload-signed');
    expect(res.token).toBe('tok-abc');
    expect(res.thumbSignedUrl).toBe('https://mock/upload-signed');
    expect(res.thumbToken).toBe('tok-abc');

    // Both signed-upload calls went out (master then thumb — Promise.all
    // starts them in array order).
    expect(createSignedUploadUrl).toHaveBeenCalledTimes(2);
    expect(createSignedUploadUrl.mock.calls[0]![0]).toBe(res.path);
    expect(createSignedUploadUrl.mock.calls[1]![0]).toBe(res.thumbPath);

    // Literal-pin the rate-limit key/limit/window/mode contract (test-tautology
    // rule — assert the literal values, not a re-derivation of them).
    expect(checkRateLimit).toHaveBeenCalledWith('maintenance:upload:user-test', 60, 3600000, 'closed');
  });

  it('MUTATION GUARD — count cap: rejects a request that already has MAINTENANCE_MAX_PHOTOS attachments', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null, count: MAINTENANCE_MAX_PHOTOS },
    });
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects extensions outside jpg/jpeg/png/webp — HEIC must be transcoded client-side', async () => {
    const { ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
    });
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'heic', originalFilename: 'x.heic' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('MUTATION GUARD — ownership: a caller who is neither the requester nor a manage-holder is rejected, even though the request is open and every other check would pass', async () => {
    const { ctx } = build(
      {
        // Requester is someone else — this caller ('user-test') did not file it.
        'maintenance_requests.select': {
          data: { id: REQ_ID, requester_user_id: 'someone-else', archived_at: null, cancelled_at: null },
          error: null,
        },
        'maintenance_request_attachments.select': { data: [], error: null, count: 0 },
      },
      // 'staff' has submit but not manage (0314 role_default_permissions).
      { role: 'staff' },
    );
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a manage-holder may mint for a request they did not file', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_requests.select': {
          data: { id: REQ_ID, requester_user_id: 'someone-else', archived_at: null, cancelled_at: null },
          error: null,
        },
        'maintenance_request_attachments.select': { data: [], error: null, count: 0 },
      },
      { role: 'admin' }, // admin holds maintenance_requests:manage by default (0314)
    );
    stubCtxUploadStorage(stub);
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).resolves.toMatchObject({ path: expect.any(String) });
  });

  it('rejects once the request is closed (archived) — unconditional, matches 0314 RLS which gates the write on archived_at/cancelled_at regardless of role', async () => {
    const { ctx } = build(
      {
        'maintenance_requests.select': {
          data: { id: REQ_ID, requester_user_id: 'user-test', archived_at: '2026-08-01T00:00:00Z', cancelled_at: null },
          error: null,
        },
      },
      { role: 'admin' },
    );
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('not_found when the parent request does not exist in this org — and never mints an upload URL', async () => {
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: null, error: null },
    });
    const { createSignedUploadUrl } = stubCtxUploadStorage(stub);
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects when the per-user rate limit is exceeded', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 61, resetAt: Date.now() + 1000 });
    const { ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
    });
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('MUTATION GUARD — module gate: rejects when maintenance_requests is disabled for the org (landmine #22 — ctxWithout pattern)', async () => {
    const { ctx } = build({}, { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) });
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('rejects without the submit permission (MFA/permission floor, mirrors Task 8 create())', async () => {
    const { ctx } = build({}, { permissions: new Set([]) });
    await expect(
      new MaintenanceAttachmentsService(ctx).createUploadUrl(REQ_ID, { fileExt: 'jpg', originalFilename: 'x.jpg' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('finalize', () => {
  it('downloads the object, sniffs REAL bytes, and inserts a row whose mime_type/byte_size/width/height come from the SNIFF, never the client', async () => {
    const bytes = pngBytes(2, 3);
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
      'maintenance_request_attachments.insert': { data: { id: 'att-1' }, error: null },
    });

    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`;
    // CRITICAL 1c: thumbPath is not a finalize() input at all anymore — the
    // service derives it from `path`, same directory, `-thumb.webp` suffix.
    const derivedThumbPath = `${ctx.organizationId}/${REQ_ID}/${UUID_1}-thumb.webp`;
    const res = await new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
      path,
      originalFilename: 'break-room.png',
      declaredMime: 'image/png',
    });

    expect(res).toEqual({ id: 'att-1', width: 2, height: 3 });
    expect(downloadMock).toHaveBeenCalledWith(path);

    const insert = stub.chainArgs.get('maintenance_request_attachments.insert')![0]![0] as Record<string, unknown>;
    expect(insert.mime_type).toBe('image/png');
    expect(insert.byte_size).toBe(bytes.byteLength);
    expect(insert.width).toBe(2);
    expect(insert.height).toBe(3);
    expect(insert.storage_path).toBe(path);
    expect(insert.thumbnail_path).toBe(derivedThumbPath);
    expect(insert.organization_id).toBe(ctx.organizationId);
    expect(insert.maintenance_request_id).toBe(REQ_ID);
    expect(insert.uploaded_by).toBe(ctx.userId);
    // Important 7 — safe_filename comes from sanitizeFilenameSegment, never
    // the raw original_filename verbatim.
    expect(insert.safe_filename).toBe('break-room-png');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.attachment_added', entityId: REQ_ID }),
      ctx,
    );
  });

  it('Important 7 — safe_filename is sanitized: a path-traversal-shaped original_filename never reaches the insert verbatim', async () => {
    const bytes = pngBytes(2, 3);
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
      'maintenance_request_attachments.insert': { data: { id: 'att-1' }, error: null },
    });
    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`;

    await new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
      path,
      originalFilename: '../../etc/passwd.jpg',
      declaredMime: 'image/png',
    });

    const insert = stub.chainArgs.get('maintenance_request_attachments.insert')![0]![0] as Record<string, unknown>;
    expect(insert.original_filename).toBe('../../etc/passwd.jpg');
    expect(insert.safe_filename).toBe('etc-passwd-jpg');
  });

  it('MUTATION GUARD — REJECTS a body whose magic bytes are not an image (photo test 6): deletes the uploaded object and throws validation_error invalid_image, writing NO row', async () => {
    const bytes = new TextEncoder().encode('<html><script>alert(1)</script>');
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
    });
    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`;
    const derivedThumbPath = `${ctx.organizationId}/${REQ_ID}/${UUID_1}-thumb.webp`;

    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path,
        originalFilename: 'fake.png',
        declaredMime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', message: 'invalid_image' });

    // Storage-delete-on-reject, pinned via call recording (both master + the
    // derived thumb).
    expect(adminRemoveMock).toHaveBeenCalledWith([path, derivedThumbPath]);
    expect(stub.chainArgs.has('maintenance_request_attachments.insert')).toBe(false);
  });

  it('rejects a declaredMime mismatch (JPEG bytes + image/png declared) — the sniff itself still correctly detects jpeg (bytes win over the lying declaration), but finalize refuses the inconsistency and deletes the object', async () => {
    const bytes = jpegBytes(10, 20);
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
    });
    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`;
    const derivedThumbPath = `${ctx.organizationId}/${REQ_ID}/${UUID_1}-thumb.webp`;

    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path,
        originalFilename: 'renamed.png', // a real JPEG, renamed .png
        declaredMime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', message: 'invalid_image' });

    expect(adminRemoveMock).toHaveBeenCalledWith([path, derivedThumbPath]);
    expect(stub.chainArgs.has('maintenance_request_attachments.insert')).toBe(false);
  });

  it('MUTATION GUARD — oversize: rejects a body larger than MAINTENANCE_MAX_PHOTO_BYTES and deletes the object', async () => {
    const bytes = new Uint8Array(MAINTENANCE_MAX_PHOTO_BYTES + 1);
    bytes.set(pngBytes(2, 3));
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
    });
    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`;
    const derivedThumbPath = `${ctx.organizationId}/${REQ_ID}/${UUID_1}-thumb.webp`;

    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path,
        originalFilename: 'big.png',
        declaredMime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', message: 'invalid_image' });
    expect(adminRemoveMock).toHaveBeenCalledWith([path, derivedThumbPath]);
    expect(stub.chainArgs.has('maintenance_request_attachments.insert')).toBe(false);
  });

  // ── CRITICAL 1/2 — path-traversal past the org/bucket boundary ───────────
  // The old guard was `args.path.startsWith(prefix)`. @supabase/storage-js
  // interpolates `path` straight into a fetch() URL; the WHATWG URL parser
  // strips `..`/`%2e%2e` segments BEFORE the request leaves Node, so a path
  // like `org/req/../../victim-org/victim-req/photo.png` passed startsWith,
  // downloaded with the SERVICE-ROLE client (bypassing RLS), and was then
  // stored and signed. Each test below pins ONE independent dimension of the
  // fix, so a regression in any single dimension fails its own test instead
  // of hiding behind a compound assertion (the original test varied org AND
  // request together, which let two separate mutations both survive).

  it('MUTATION GUARD (r2) — a path whose org segment is a DIFFERENT (validly-shaped) org than ctx.organizationId is forbidden, even though the request segment and uuid.ext are perfectly well-formed', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null } });
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `other-org/${REQ_ID}/${UUID_1}.jpg`,
        originalFilename: 'x.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(adminRemoveMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD (r7) — a path whose request segment is a DIFFERENT (validly-shaped) request than the one being finalized against is forbidden, even though the org segment and uuid.ext are perfectly well-formed', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null } });
    const otherReqId = '22222222-2222-4222-8222-222222222222';
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `${ctx.organizationId}/${otherReqId}/${UUID_1}.jpg`,
        originalFilename: 'x.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(adminRemoveMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — a literal ".." traversal segment is rejected BEFORE any storage call (the proven exploit)', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null } });
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `${ctx.organizationId}/${REQ_ID}/../../victim-org/victim-req/${UUID_1}.jpg`,
        originalFilename: 'x.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(adminRemoveMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — a %2e%2e-encoded traversal segment is rejected (this is the variant that escapes the BUCKET entirely once Storage decodes it server-side, e.g. into item-images)', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null } });
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `${ctx.organizationId}/${REQ_ID}/%2e%2e/%2e%2e/item-images/some-org/some-item/cover.jpg`,
        originalFilename: 'x.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(adminRemoveMock).not.toHaveBeenCalled();
  });

  it('rejects a path with the right org/request prefix but a non-uuid filename (strict shape, not just a prefix match)', async () => {
    const { ctx } = build({ 'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null } });
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `${ctx.organizationId}/${REQ_ID}/not-a-uuid.jpg`,
        originalFilename: 'x.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — cap re-check: rejects finalize once the request already holds MAINTENANCE_MAX_PHOTOS attachments, and rolls back the uploaded object (Important 3 — a mint-time count check alone is bypassable: 0315 lets any accepted org member PUT directly to storage, and mint itself can be called MAINTENANCE_MAX_PHOTOS times concurrently before any of them finalizes)', async () => {
    const bytes = pngBytes(2, 3);
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
      'maintenance_request_attachments.select': { data: [], error: null, count: MAINTENANCE_MAX_PHOTOS },
    });
    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`;
    const derivedThumbPath = `${ctx.organizationId}/${REQ_ID}/${UUID_1}-thumb.webp`;

    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path,
        originalFilename: 'x.png',
        declaredMime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(adminRemoveMock).toHaveBeenCalledWith([path, derivedThumbPath]);
    expect(stub.chainArgs.has('maintenance_request_attachments.insert')).toBe(false);
  });

  it('never writes a row when the object was never actually uploaded (download fails) — no phantom rows', async () => {
    downloadMock.mockResolvedValue({ data: null, error: { message: 'The resource was not found' } });
    const { stub, ctx } = build({
      'maintenance_requests.select': { data: OPEN_REQUEST_ROW, error: null },
    });
    const path = `${ctx.organizationId}/${REQ_ID}/${UUID_1}.jpg`;
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path,
        originalFilename: 'ghost.jpg',
        declaredMime: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', message: 'invalid_image' });
    expect(stub.chainArgs.has('maintenance_request_attachments.insert')).toBe(false);
  });

  it('enforces the same ownership gate as mint — a non-owner/non-manage caller cannot finalize onto someone else\'s request', async () => {
    const bytes = pngBytes(2, 3);
    downloadMock.mockResolvedValue({ data: blobFor(bytes), error: null });
    const { ctx } = build(
      {
        'maintenance_requests.select': {
          data: { id: REQ_ID, requester_user_id: 'someone-else', archived_at: null, cancelled_at: null },
          error: null,
        },
      },
      { role: 'staff' },
    );
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`,
        originalFilename: 'x.png',
        declaredMime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('rejects finalize on a closed request', async () => {
    const { ctx } = build({
      'maintenance_requests.select': {
        data: { id: REQ_ID, requester_user_id: 'user-test', archived_at: null, cancelled_at: '2026-08-01T00:00:00Z' },
        error: null,
      },
    });
    await expect(
      new MaintenanceAttachmentsService(ctx).finalize(REQ_ID, {
        path: `${ctx.organizationId}/${REQ_ID}/${UUID_1}.png`,
        originalFilename: 'x.png',
        declaredMime: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

describe('remove', () => {
  it('deletes the row (row-confirmed) + both storage objects, then audits', async () => {
    const { ctx } = build({
      'maintenance_request_attachments.select': {
        data: { id: 'att-1', storage_path: 'org-test/req/a.jpg', thumbnail_path: 'org-test/req/a-thumb.webp' },
        error: null,
      },
      'maintenance_request_attachments.delete': { data: { id: 'att-1' }, error: null },
    });

    await new MaintenanceAttachmentsService(ctx).remove(REQ_ID, 'att-1');

    expect(adminRemoveMock).toHaveBeenCalledWith(['org-test/req/a.jpg', 'org-test/req/a-thumb.webp']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.attachment_removed', entityId: REQ_ID }),
      ctx,
    );
  });

  it('MUTATION GUARD — NO fail-open: when the DELETE affects zero rows (RLS refused it), throws conflict and never removes storage or audits (row-confirm before every write/audit)', async () => {
    const { ctx } = build({
      'maintenance_request_attachments.select': {
        data: { id: 'att-1', storage_path: 'org-test/req/a.jpg', thumbnail_path: null },
        error: null,
      },
      // Pre-read found the row, but the delete itself affects 0 rows —
      // e.g. the request closed between the read and the write.
      'maintenance_request_attachments.delete': { data: null, error: null },
    });

    await expect(new MaintenanceAttachmentsService(ctx).remove(REQ_ID, 'att-1')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(adminRemoveMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('not_found when the attachment does not exist in this org/request', async () => {
    const { ctx } = build({
      'maintenance_request_attachments.select': { data: null, error: null },
    });
    await expect(new MaintenanceAttachmentsService(ctx).remove(REQ_ID, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(adminRemoveMock).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD (r14) — requires maintenance_requests:submit before touching the row: a caller without it is rejected BEFORE any read, storage removal, or audit', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_request_attachments.select': {
          data: { id: 'att-1', storage_path: 'org-test/req/a.jpg', thumbnail_path: null },
          error: null,
        },
        'maintenance_request_attachments.delete': { data: { id: 'att-1' }, error: null },
      },
      { permissions: new Set([]) },
    );
    await expect(new MaintenanceAttachmentsService(ctx).remove(REQ_ID, 'att-1')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(stub.fromCalls).not.toContain('maintenance_request_attachments');
    expect(adminRemoveMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('signedViewUrls', () => {
  it('mints signed URLs via the ADMIN client and is NOT module-gated — attachment reads ride RLS + signed URLs, matching maintenance-requests.ts list()/get() (0314 Q3)', async () => {
    const { stub, ctx } = build(
      {
        'maintenance_request_attachments.select': {
          data: [
            {
              id: 'att-1',
              storage_path: 'org-test/req/a.jpg',
              thumbnail_path: 'org-test/req/a-thumb.webp',
              original_filename: 'photo.jpg',
              width: 10,
              height: 20,
            },
          ],
          error: null,
        },
      },
      // Module explicitly DISABLED — proves this read path survives a disable.
      { enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS) },
    );

    const res = await new MaintenanceAttachmentsService(ctx).signedViewUrls(REQ_ID);

    expect(res).toEqual([
      {
        id: 'att-1',
        originalFilename: 'photo.jpg',
        url: 'https://mock/view-signed',
        thumbUrl: 'https://mock/view-signed',
        width: 10,
        height: 20,
      },
    ]);
    // ADMIN client used (never ctx.supabase — RLS-scoped visibility already
    // happened via the row select above; signing is org-agnostic).
    expect(createAdminClientMock).toHaveBeenCalled();
    // Minor 11 — ONE batched createSignedUrls call covering both the master
    // and the thumb path, 1-hour TTL, literal-pinned. Not a per-row call.
    expect(adminCreateSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(adminCreateSignedUrlsMock).toHaveBeenCalledWith(
      ['org-test/req/a.jpg', 'org-test/req/a-thumb.webp'],
      3600,
    );
    void stub;
  });

  it('batches every master + thumb path across MULTIPLE rows into a single createSignedUrls call', async () => {
    const { ctx } = build({
      'maintenance_request_attachments.select': {
        data: [
          { id: 'att-1', storage_path: 'org-test/req/a.jpg', thumbnail_path: 'org-test/req/a-thumb.webp', original_filename: 'a.jpg', width: 1, height: 1 },
          { id: 'att-2', storage_path: 'org-test/req/b.jpg', thumbnail_path: null, original_filename: 'b.jpg', width: null, height: null },
        ],
        error: null,
      },
    });
    const res = await new MaintenanceAttachmentsService(ctx).signedViewUrls(REQ_ID);
    expect(res).toHaveLength(2);
    expect(adminCreateSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(adminCreateSignedUrlsMock).toHaveBeenCalledWith(
      ['org-test/req/a.jpg', 'org-test/req/a-thumb.webp', 'org-test/req/b.jpg'],
      3600,
    );
  });

  it('an empty result never calls storage at all', async () => {
    const { ctx } = build({
      'maintenance_request_attachments.select': { data: [], error: null },
    });
    const res = await new MaintenanceAttachmentsService(ctx).signedViewUrls(REQ_ID);
    expect(res).toEqual([]);
    expect(adminCreateSignedUrlsMock).not.toHaveBeenCalled();
  });

  it('THROWS on a signing failure — never returns a broken/partial URL (recurring bug #6)', async () => {
    adminCreateSignedUrlsMock.mockResolvedValueOnce({ data: null, error: { message: 'quota exceeded' } });
    const { ctx } = build({
      'maintenance_request_attachments.select': {
        data: [{ id: 'att-1', storage_path: 'org-test/req/a.jpg', thumbnail_path: null, original_filename: 'p.jpg', width: null, height: null }],
        error: null,
      },
    });
    await expect(new MaintenanceAttachmentsService(ctx).signedViewUrls(REQ_ID)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('THROWS when the master path is missing from a partial batch response, even though the call itself succeeded', async () => {
    adminCreateSignedUrlsMock.mockResolvedValueOnce({
      data: [{ error: 'not found', path: 'org-test/req/a.jpg', signedUrl: null }],
      error: null,
    });
    const { ctx } = build({
      'maintenance_request_attachments.select': {
        data: [{ id: 'att-1', storage_path: 'org-test/req/a.jpg', thumbnail_path: null, original_filename: 'p.jpg', width: null, height: null }],
        error: null,
      },
    });
    await expect(new MaintenanceAttachmentsService(ctx).signedViewUrls(REQ_ID)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});
