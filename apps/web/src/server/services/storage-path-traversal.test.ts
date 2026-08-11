import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
// ItemImagesService.record now sniffs via a RANGE READ of the object's
// leading bytes (fetchObjectPrefix) instead of download(). The helper is the
// storage-read seam here: makeStorageSpy wires it to the same `body` its
// download stub used to serve, and the refusal assertions check IT was never
// reached — same property as before (no storage read happens on hostile
// input), stated against the call that now performs the read.
const { fetchObjectPrefixMock } = vi.hoisted(() => ({ fetchObjectPrefixMock: vi.fn() }));
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { ServiceError } from './context';
import { ItemImagesService } from './item-images';
import { OrderAttachmentsService } from './order-attachments';
import { PoAttachmentsService } from './po-attachments';
import { PoImportsService } from './po-imports';
import { ProcedureVideosService } from './procedure-videos';

beforeEach(() => vi.clearAllMocks());

/**
 * HI-8 — path traversal past the org AND bucket boundary, proven refused at
 * every one of the five services that used to gate a client-supplied storage
 * path with a `startsWith` prefix check.
 *
 * WHY A PREFIX CHECK WAS NEVER ENOUGH
 *   @supabase/storage-js interpolates the path straight into a `fetch()` URL,
 *   and the WHATWG URL parser resolves `..` / `%2e%2e` segments BEFORE the
 *   request leaves Node. So `<org>/../../<other-bucket>/<victim>/x.jpg`
 *   satisfies `startsWith('<org>/')`, escapes the org folder, escapes the
 *   BUCKET, and — at the three sites that sign with the service-role client —
 *   comes back as a signed URL RLS never evaluated.
 *
 * WHAT IS ASSERTED
 *   The SECURITY PROPERTY, not the current implementation: for each service,
 *   a traversal path is REFUSED, and (paired, so no refusal can be credited to
 *   a broken fixture) the REAL minted path for the same call is ACCEPTED far
 *   enough to prove the gate let it through. Where a service can be observed
 *   making the storage call, the assertion is that the storage client is never
 *   touched at all on the hostile input — a refusal that happens after the
 *   download would already have leaked the object.
 */

/** The traversal payloads every site must refuse. Kept as one list so a new
 *  site cannot be added to this file with a weaker set of cases. */
const TRAVERSALS = (org: string, entity: string) => [
  // The literal finding.
  `${org}/${entity}/../../../item-images/victim-org/victim-item/cover.jpg`,
  // Percent-encoded, for the decode that happens downstream.
  `${org}/${entity}/%2e%2e/%2e%2e/order-attachments/victim/proof.jpg`,
  // Double-encoded.
  `${org}/${entity}/%252e%252e/item-images/victim/x.jpg`,
  // Absolute.
  `/${org}/${entity}/x.jpg`,
  // Empty segment.
  `${org}//${entity}/x.jpg`,
  // Backslash separator.
  `${org}\\..\\..\\item-images\\victim\\x.jpg`,
  // A different org outright (the pre-existing property, kept).
  `99999999-9999-4999-8999-999999999999/${entity}/x.jpg`,
];

const ORG = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

/** A real 26-byte PNG: 8-byte signature, IHDR length+tag, then 2x3 dimensions.
 *  Bytes only — used to prove the MED-23 sniff accepts a genuine image, so the
 *  verify-or-delete guard is not simply rejecting everything. */
function pngBytes(): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, 2);
  new DataView(b.buffer).setUint32(20, 3);
  return b;
}

/** A storage stub that records every call, so a test can assert the storage
 *  client was NEVER reached — the only assertion that proves the refusal
 *  happened before the object could be read. `body` also becomes what the
 *  (mocked) range-read helper serves as the object's leading bytes, mirroring
 *  what the download stub used to return; null = the object does not exist. */
function makeStorageSpy(body: Uint8Array | null) {
  fetchObjectPrefixMock.mockImplementation(async () =>
    body ? { prefix: body, totalSize: body.byteLength } : null,
  );
  const remove = vi.fn(async () => ({ data: null, error: null }));
  const createSignedUrl = vi.fn(async () => ({
    data: { signedUrl: 'https://signed.example/get' },
    error: null,
  }));
  const api = { remove, createSignedUrl };
  return { api, from: vi.fn(() => api), remove, createSignedUrl };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. ItemImagesService.record — item-images bucket
// ───────────────────────────────────────────────────────────────────────────
describe('ItemImagesService.record — HI-8', () => {
  function svcWith(storage: { from: unknown }, results: Record<string, unknown> = {}) {
    const stub = makeSupabaseStub(results as never);
    stub.client.storage = storage;
    return new ItemImagesService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
    );
  }

  it.each(TRAVERSALS(ORG, ENTITY))('REFUSES the traversal %s without touching storage', async (bad) => {
    const storage = makeStorageSpy(pngBytes());
    const svc = svcWith(storage);
    const err = await svc.record(ENTITY, bad, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    // The refusal must precede the storage call: a check that ran after the
    // prefix read would already have read the victim's object.
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
  });

  it('REFUSES a traversal in thumbPath even when storagePath is legitimate', async () => {
    const storage = makeStorageSpy(pngBytes());
    const svc = svcWith(storage);
    const err = await svc
      .record(ENTITY, `${ORG}/items/${ENTITY}/${FILE}.webp`, true, {
        thumbPath: `${ORG}/../../org-logos/victim-org/logo.png`,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
  });

  it('REFUSES a path pinned to a DIFFERENT item — the shape pins the item id, not just the org', async () => {
    // New with this wave: the old prefix check let a caller record item A's
    // row against item B's uploaded photo.
    const storage = makeStorageSpy(pngBytes());
    const svc = svcWith(storage);
    const err = await svc
      .record(ENTITY, `${ORG}/items/88888888-8888-4888-8888-888888888888/${FILE}.webp`, true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
  });

  it('PAIRED POSITIVE — the real minted path passes the gate and reaches the byte check', async () => {
    const storage = makeStorageSpy(pngBytes());
    const svc = svcWith(storage, {
      'inventory_items.select': { data: [{ id: ENTITY }], error: null },
      'item_images.insert': { data: [{ id: 'img-1' }], error: null },
    });
    const row = await svc.record(ENTITY, `${ORG}/items/${ENTITY}/${FILE}.webp`, true, {
      thumbPath: `${ORG}/items/${ENTITY}/${FILE}-thumb.webp`,
    });
    expect(fetchObjectPrefixMock).toHaveBeenCalledWith(expect.anything(), `${ORG}/items/${ENTITY}/${FILE}.webp`);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(row).toMatchObject({ id: 'img-1' });
  });

  it('MED-23 — a body whose BYTES are not an image is REJECTED and the orphaned object DELETED, with no row written', async () => {
    // A renamed HTML document that uploaded cleanly by declaring image/png.
    const storage = makeStorageSpy(new TextEncoder().encode('<html><script>alert(1)</script>'));
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: ENTITY }], error: null },
      'item_images.insert': { data: [{ id: 'img-1' }], error: null },
    });
    stub.client.storage = storage;
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
    );
    const master = `${ORG}/items/${ENTITY}/${FILE}.webp`;
    const thumb = `${ORG}/items/${ENTITY}/${FILE}-thumb.webp`;
    const err = await svc.record(ENTITY, master, true, { thumbPath: thumb }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    // Verify-or-DELETE: the unverified object must not survive the refusal.
    expect(storage.remove).toHaveBeenCalledWith([master, thumb]);
    // And no pointer row may be written for it.
    expect(stub.fromCalls).not.toContain('item_images');
  });

  it('MED-23 — a `record()` that was never preceded by a real upload writes no phantom row', async () => {
    const storage = makeStorageSpy(null); // the prefix read fails: the object is absent
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: ENTITY }], error: null },
    });
    stub.client.storage = storage;
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
    );
    const err = await svc
      .record(ENTITY, `${ORG}/items/${ENTITY}/${FILE}.webp`, true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('item_images');
    // Nothing was uploaded, so there is nothing to remove.
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. OrderAttachmentsService.add — order-attachments bucket
// ───────────────────────────────────────────────────────────────────────────
describe('OrderAttachmentsService.add — HI-8', () => {
  const base = {
    orderRequestId: ENTITY,
    fileName: 'proof.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1234,
    kind: 'dropoff_photo' as const,
  };

  function svcWith(insertResult: unknown = { data: [{ id: 'att-1' }], error: null }) {
    const stub = makeSupabaseStub({
      // An order in an attachable status, so the path check is what decides.
      'order_requests.select': { data: [{ id: ENTITY, status: 'completed' }], error: null },
      'order_request_attachments.insert': insertResult as never,
    });
    return {
      stub,
      svc: new OrderAttachmentsService(
        makeServiceContext(stub.client, { role: 'manager', organizationId: ORG }) as never,
      ),
    };
  }

  it.each(TRAVERSALS(ORG, ENTITY))('REFUSES the traversal %s and writes no row', async (bad) => {
    const { stub, svc } = svcWith();
    const err = await svc.add({ ...base, storagePath: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('order_request_attachments');
  });

  it('REFUSES a path pinned to a DIFFERENT order — order A cannot claim order B‘s uploaded proof', async () => {
    const { svc } = svcWith();
    const err = await svc
      .add({ ...base, storagePath: `${ORG}/88888888-8888-4888-8888-888888888888/${FILE}.jpg` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
  });

  it('PAIRED POSITIVE — the real minted path is accepted and the row is written', async () => {
    const { stub, svc } = svcWith();
    const out = await svc.add({ ...base, storagePath: `${ORG}/${ENTITY}/${FILE}.jpg` });
    expect(out).toEqual({ id: 'att-1' });
    expect(stub.fromCalls).toContain('order_request_attachments');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. ProcedureVideosService.record — procedure-videos bucket (service-role signing)
// ───────────────────────────────────────────────────────────────────────────
describe('ProcedureVideosService.record — HI-8', () => {
  function svcWith() {
    const stub = makeSupabaseStub({
      'procedures.select': { data: [{ id: ENTITY }], error: null },
      'procedure_videos.select': { data: [{ order_idx: 0 }], error: null },
      'procedure_videos.insert': { data: [{ id: 'vid-1', procedure_id: ENTITY }], error: null },
    });
    return {
      stub,
      svc: new ProcedureVideosService(
        makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
      ),
    };
  }

  it.each(TRAVERSALS(ORG, ENTITY))('REFUSES the traversal %s and writes no row', async (bad) => {
    const { stub, svc } = svcWith();
    const err = await svc
      .record({ procedureId: ENTITY, storagePath: bad } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('procedure_videos');
  });

  it('REFUSES a traversal in thumbnailPath even when storagePath is legitimate', async () => {
    const { stub, svc } = svcWith();
    const err = await svc
      .record({
        procedureId: ENTITY,
        storagePath: `${ORG}/${ENTITY}/${FILE}.mp4`,
        thumbnailPath: `${ORG}/${ENTITY}/../../item-images/victim/cover.jpg`,
      } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('procedure_videos');
  });

  it('PAIRED POSITIVE — the real video path and its .poster.jpg sibling are both accepted', async () => {
    const { svc } = svcWith();
    const row = await svc.record({
      procedureId: ENTITY,
      storagePath: `${ORG}/${ENTITY}/${FILE}.mp4`,
      thumbnailPath: `${ORG}/${ENTITY}/${FILE}.poster.jpg`,
    } as never);
    expect(row).toMatchObject({ id: 'vid-1' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. PoAttachmentsService.add — po-attachments bucket
// ───────────────────────────────────────────────────────────────────────────
describe('PoAttachmentsService.add — HI-8', () => {
  const base = {
    purchaseOrderId: ENTITY,
    fileName: 'invoice.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4321,
  };

  function svcWith() {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: [{ id: ENTITY }], error: null },
      'po_attachments.insert': { data: [{ id: 'poa-1' }], error: null },
    });
    return {
      stub,
      svc: new PoAttachmentsService(
        makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
      ),
    };
  }

  it.each(TRAVERSALS(ORG, ENTITY))('REFUSES the traversal %s and writes no row', async (bad) => {
    const { stub, svc } = svcWith();
    const err = await svc.add({ ...base, storagePath: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(stub.fromCalls).not.toContain('po_attachments');
  });

  it('REFUSES a path pinned to a DIFFERENT purchase order', async () => {
    const { svc } = svcWith();
    const err = await svc
      .add({ ...base, storagePath: `${ORG}/88888888-8888-4888-8888-888888888888/${FILE}.pdf` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
  });

  it('PAIRED POSITIVE — both real mints are accepted: the web uuid filename and the mobile base36 one', async () => {
    for (const file of [`${FILE}.pdf`, 'k3j4h5g6f7d8.pdf']) {
      const { svc } = svcWith();
      const out = await svc.add({ ...base, storagePath: `${ORG}/${ENTITY}/${file}` });
      expect(out).toEqual({ id: 'poa-1' });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. PoImportsService.createFromUpload — po-imports bucket
// ───────────────────────────────────────────────────────────────────────────
describe('PoImportsService.createFromUpload — HI-8 and MED-22', () => {
  const base = {
    sourceType: 'csv' as const,
    fileName: 'po.csv',
    fileMimeType: 'text/csv',
    fileSize: 1024,
    sha256: 'a'.repeat(64),
  };

  function svcWith() {
    const stub = makeSupabaseStub({
      // No prior import with this hash → the duplicate check clears.
      'po_imports.select': { data: [], error: null },
      'po_imports.insert': { data: [{ id: 'imp-1' }], error: null },
    });
    return {
      stub,
      svc: new PoImportsService(
        makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
      ),
    };
  }

  it.each(TRAVERSALS(ORG, 'po-imports'))('REFUSES the traversal %s and writes no row', async (bad) => {
    const { stub, svc } = svcWith();
    const err = await svc.createFromUpload({ ...base, storagePath: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    expect(stub.chains.has('po_imports.insert')).toBe(false);
  });

  it('REFUSES a path under the org but OUTSIDE the po-imports folder — parseImport downloads whatever this column names', async () => {
    const { svc } = svcWith();
    const err = await svc
      .createFromUpload({ ...base, storagePath: `${ORG}/${ENTITY}/${FILE}.csv` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
  });

  it('MED-22 — a record carrying a MIME outside the document allowlist is refused', async () => {
    const { svc } = svcWith();
    for (const mime of ['image/png', 'text/html', 'image/svg+xml', 'application/octet-stream']) {
      const err = await svc
        .createFromUpload({
          ...base,
          fileMimeType: mime,
          storagePath: `${ORG}/po-imports/${FILE}.csv`,
        })
        .catch((e: unknown) => e);
      expect(err, mime).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('validation_error');
    }
  });

  it('PAIRED POSITIVE — both real mints and every allowlisted document MIME are accepted', async () => {
    // presignUpload's uuid filename and createFromScan's 64-hex sha256 one.
    for (const path of [
      `${ORG}/po-imports/${FILE}.csv`,
      `${ORG}/po-imports/${'0123456789abcdef'.repeat(4)}.pdf`,
    ]) {
      const { svc } = svcWith();
      const out = await svc.createFromUpload({ ...base, storagePath: path });
      expect(out.id).toBe('imp-1');
    }
    for (const mime of ['application/pdf', 'text/csv', 'application/vnd.ms-excel']) {
      const { svc } = svcWith();
      const out = await svc.createFromUpload({
        ...base,
        fileMimeType: mime,
        storagePath: `${ORG}/po-imports/${FILE}.csv`,
      });
      expect(out.id, mime).toBe('imp-1');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. PoImportsService.presignUpload — MED-22, the mint side
// ───────────────────────────────────────────────────────────────────────────
describe('PoImportsService.presignUpload — MED-22', () => {
  function svcWith() {
    const createSignedUploadUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://signed.example/put' },
      error: null,
    }));
    const client = { storage: { from: vi.fn(() => ({ createSignedUploadUrl })) } };
    return {
      createSignedUploadUrl,
      svc: new PoImportsService(
        makeServiceContext(client, { role: 'admin', organizationId: ORG }) as never,
      ),
    };
  }

  it('refuses to mint an upload URL for a content type outside the document allowlist', async () => {
    // The bucket has NO allowed_mime_types pin (0021 created it without one),
    // so before this the presign would hand out a signed PUT for anything —
    // an HTML or SVG document could be parked in the bucket.
    for (const mime of ['image/png', 'text/html', 'image/svg+xml', 'application/x-msdownload']) {
      const { createSignedUploadUrl, svc } = svcWith();
      const err = await svc.presignUpload({ fileName: 'po.csv', fileMimeType: mime }).catch((e) => e);
      expect(err, mime).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('validation_error');
      expect(createSignedUploadUrl, mime).not.toHaveBeenCalled();
    }
  });

  it('the minted extension comes from the ALLOWLISTED MIME, never from the caller‘s fileName — so a fileName cannot inject a path', async () => {
    // The old code did `fileName.split('.').pop()`, so this fileName produced
    // an `ext` of `csv/../../item-images/x` and a MINTED path containing a
    // traversal. The extension is now server-chosen, so fileName never reaches
    // the path at all.
    const { createSignedUploadUrl, svc } = svcWith();
    const out = await svc.presignUpload({
      fileName: 'po.csv/../../item-images/victim/x',
      fileMimeType: 'text/csv',
    });
    expect(out.storagePath).toMatch(
      new RegExp(`^${ORG}/po-imports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.csv$`),
    );
    expect(out.storagePath).not.toContain('..');
    expect(out.storagePath).not.toContain('item-images');
    expect(createSignedUploadUrl).toHaveBeenCalledWith(out.storagePath);
  });

  it('maps each allowlisted document MIME to its server-chosen extension', async () => {
    for (const [mime, ext] of [
      ['application/pdf', 'pdf'],
      ['text/csv', 'csv'],
      // Windows reports this for a plain .csv — same CSV code path, so the
      // extension must be csv and NOT an Excel one.
      ['application/vnd.ms-excel', 'csv'],
    ] as const) {
      const { svc } = svcWith();
      const out = await svc.presignUpload({ fileName: 'whatever', fileMimeType: mime });
      expect(out.storagePath.endsWith(`.${ext}`), `${mime} -> .${ext}`).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. PoImportsService.createFromScan — MED-22, the scan path
// ───────────────────────────────────────────────────────────────────────────
describe('PoImportsService.createFromScan — MED-22', () => {
  it('refuses a frame whose declared type is outside the scan allowlist, before any upload', async () => {
    // createFromScan uploads with the SERVICE-ROLE client and writes the
    // caller's mimeType straight into the object's Content-Type, so the bucket
    // RLS cannot second-guess it. The route checks the same set at its
    // boundary; this is the shared service twin refusing it too.
    const stub = makeSupabaseStub({ 'po_imports.select': { data: [], error: null } });
    const svc = new PoImportsService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
    );
    for (const mimeType of ['text/html', 'image/svg+xml', 'application/x-msdownload']) {
      const err = await svc
        .createFromScan({
          files: [{ bytes: new Uint8Array([1, 2, 3]), mimeType, fileName: 'scan.bin' }],
        })
        .catch((e: unknown) => e);
      expect(err, mimeType).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('validation_error');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. ItemImagesService.signedUrls — the READ side
// ---------------------------------------------------------------------------
/**
 * The five sites above are WRITE gates: they stop a hostile path being stored.
 * They cannot help a path that is ALREADY in the column — one written before
 * those gates existed, or written through mobile's direct PostgREST insert,
 * which never passes through a service at all.
 *
 * `signedUrls` hands DB-sourced paths to the SERVICE-ROLE client, which
 * bypasses RLS by construction, so it needs its own structural gate. Asserted
 * property: a malformed stored path NEVER reaches the storage client — neither
 * through the batch signer nor the per-path signer. Both are checked because
 * they are separate code paths to the same privileged call, and `signedUrls`
 * starts the batch and the per-path resolve concurrently.
 */
describe('ItemImagesService.signedUrls — HI-8 on the service-role READ path', () => {
  async function signWith(paths: string[]) {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://signed.example/one' },
      error: null,
    }));
    const createSignedUrls = vi.fn(async (given: string[]) => ({
      data: given.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}`, error: null })),
      error: null,
    }));
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      storage: { from: vi.fn(() => ({ createSignedUrl, createSignedUrls })) },
    });
    const stub = makeSupabaseStub({});
    const svc = new ItemImagesService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
    );
    const map = await svc.signedUrls(paths);
    return { map, createSignedUrl, createSignedUrls };
  }

  it('signs a real stored path — proves the gate is not simply refusing everything', async () => {
    const good = `${ORG}/items/${ENTITY}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
    const { map, createSignedUrls } = await signWith([good]);

    expect(createSignedUrls).toHaveBeenCalledWith([good], expect.any(Number));
    expect(map.get(good)).toBeTruthy();
  });

  it('accepts the books-import cover convention, which omits the items/ segment', async () => {
    // `{org}/{item}/cover.jpg` is a legitimate in-production shape (the cover
    // rehost inserts its row directly). A gate that only knew the presigned
    // convention would blank every imported book cover.
    const cover = `${ORG}/${ENTITY}/cover.jpg`;
    const { map } = await signWith([cover]);

    expect(map.get(cover)).toBeTruthy();
  });

  /**
   * The escape payloads only — every case that CLAIMS to be inside our org and
   * then breaks out of it (traversal, encoded traversal, absolute, empty
   * segment, backslash). Derived by "mentions our org" rather than by index so
   * a payload added to TRAVERSALS is picked up here automatically.
   *
   * The one case deliberately EXCLUDED is TRAVERSALS' different-org path. That
   * is a write-gate property, not a read-gate one: see the test below.
   */
  const ESCAPES = TRAVERSALS(ORG, ENTITY).filter((p) => p.includes(ORG));

  it('never hands an escaping path to the storage client, by either signer', async () => {
    expect(ESCAPES.length).toBeGreaterThan(5); // guard against the filter silently emptying
    for (const bad of ESCAPES) {
      const { map, createSignedUrl, createSignedUrls } = await signWith([bad]);

      expect(map.has(bad), bad).toBe(false);
      // The batch call must not carry it...
      for (const call of createSignedUrls.mock.calls) {
        expect(call[0], bad).not.toContain(bad);
      }
      // ...and the per-path signer must not have been reached either.
      expect(createSignedUrl, bad).not.toHaveBeenCalled();
    }
  });

  it('DOES sign a structurally-valid path belonging to another org — by design', async () => {
    // Documents a real and deliberate boundary rather than asserting a hole.
    // The read gate is STRUCTURAL: `itemImageAnyPathShape` cannot pin the org,
    // because the org id is exactly what is unknown at these call sites —
    // `public-items.ts` signs item images on an UNAUTHENTICATED public page.
    //
    // Org authorization for this path happens UPSTREAM, at the query: the
    // row-reading methods filter `.eq('organization_id', ctx.organizationId)`,
    // and the public page resolves items through the public-eligibility
    // predicate. So a foreign-org path can only arrive here if a caller
    // hand-fed it, and the write gates above are what stop such a path being
    // stored in the first place.
    //
    // If this ever needs to become org-pinned, the fix is a pinned shape at
    // the callers that DO know the org — not tightening this shared gate,
    // which would blank every image on the public catalog.
    const foreign = `99999999-9999-4999-8999-999999999999/${ENTITY}/x.jpg`;
    const { map } = await signWith([foreign]);

    expect(map.get(foreign)).toBeTruthy();
  });

  it('drops only the malformed path from a mixed batch, still signing the good one', async () => {
    // A single poisoned row must not blank an entire list page: createSignedUrls
    // is one call for the whole array, so the filter has to be per-path.
    const good = `${ORG}/items/${ENTITY}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp`;
    const bad = `${ORG}/items/${ENTITY}/../../../item-images/victim/x.jpg`;
    const { map, createSignedUrls } = await signWith([bad, good]);

    expect(map.get(good)).toBeTruthy();
    expect(map.has(bad)).toBe(false);
    expect(createSignedUrls).toHaveBeenCalledWith([good], expect.any(Number));
  });
});
