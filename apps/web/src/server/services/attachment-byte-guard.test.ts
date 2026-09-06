import { beforeEach, describe, expect, it, vi } from 'vitest';

import { scanDocumentBytes, THREAT_MESSAGES } from '@/lib/document-threat-scan';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// SPOOFED CONTENT-TYPE — the hole the finalize byte guard closes.
//
// A bucket's allowed_mime_types is validated against the Content-Type the
// CLIENT sent with its PUT, and both attachment panels upload client-direct
// with `contentType: file.type` — the browser's word for it. So a renamed
// binary, an HTML document or an SVG carrying script reached po-attachments
// and order-attachments by declaring `application/pdf`. Those objects are
// later signed, opened, and (for POs) bundled into the attachments zip, which
// makes an unverified one a payload host on our own storage origin.
//
// These tests assert the two halves that make the guard worth having: the row
// is NOT written, and the orphaned object IS removed. A guard that rejects the
// row but leaves the bytes in the bucket has moved the problem, not fixed it.
// ---------------------------------------------------------------------------
const { createAdminClientMock } = vi.hoisted(() => ({
  // A DEFAULT return, armed at hoist time: some modules call
  // createAdminClient() at import, so a mock that yields undefined until a
  // test arms it fails the whole file at collection rather than in a test.
  createAdminClientMock: vi.fn(() => ({
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
  })),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: createAdminClientMock }));

const { fetchObjectPrefixMock } = vi.hoisted(() => ({ fetchObjectPrefixMock: vi.fn() }));
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
  SNIFF_PREFIX_BYTES: 4096,
}));
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertModuleEnabled: vi.fn() };
});
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  // order-attachments builds a signed-url cache at MODULE load; without this
  // the file fails at collection rather than in a test.
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

import { ServiceError } from './context';
import { OrderAttachmentsService } from './order-attachments';
import { PoAttachmentsService } from './po-attachments';

const ORG = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const PDF = ascii('%PDF-1.7\n1 0 obj');
const HTML = ascii('<!DOCTYPE html><script>alert(document.cookie)</script>');
const SVG = ascii('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const PE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ

let remove: ReturnType<typeof vi.fn>;
let download: ReturnType<typeof vi.fn>;

/**
 * The SMALL-object arming: the prefix read returns the whole file, because the
 * whole file fits inside the 4 KB sniff window.
 *
 * `download` is armed here too — and armed to FAIL — on purpose. When the
 * prefix already is the entire object there is nothing left to re-read, so a
 * change that made the finalize gate download unconditionally would both blow
 * up these tests' accept path AND be named by the explicit
 * `expect(download).not.toHaveBeenCalled()` below. Before this spy existed the
 * stub had no `download` at all, so the whole-object branch was not merely
 * unasserted — it was unreachable without a TypeError.
 */
function armStorage(body: Uint8Array | null) {
  fetchObjectPrefixMock.mockImplementation(async () =>
    body ? { prefix: body, totalSize: body.byteLength } : null,
  );
  remove = vi.fn(async () => ({ data: null, error: null }));
  download = vi.fn(async () => ({
    data: null,
    error: { message: 'download() must not be called when the prefix IS the whole object' },
  }));
  const api = {
    remove,
    download,
    createSignedUrl: vi.fn(async () => ({ data: null, error: null })),
  };
  createAdminClientMock.mockReturnValue({ storage: { from: vi.fn(() => api) } } as never);
}

/**
 * The LARGE-object arming: the object is bigger than the sniff window, so the
 * prefix read returns only the leading 4 KB and the real full size — exactly
 * the shape `fetchObjectPrefix` produces in production for anything over
 * 4096 bytes. That is what forces `verifyStoredDocumentOrDelete` down its
 * re-download branch, which is the branch the scanner's whole-file contract
 * depends on.
 */
function armStorageLarge(full: Uint8Array, downloadResult: unknown) {
  fetchObjectPrefixMock.mockImplementation(async () => ({
    prefix: full.subarray(0, 4096),
    totalSize: full.byteLength,
  }));
  remove = vi.fn(async () => ({ data: null, error: null }));
  download = vi.fn(async () => downloadResult);
  const api = {
    remove,
    download,
    createSignedUrl: vi.fn(async () => ({ data: null, error: null })),
  };
  createAdminClientMock.mockReturnValue({ storage: { from: vi.fn(() => api) } } as never);
}

function poSvc() {
  const stub = makeSupabaseStub({
    'purchase_orders.select': { data: { id: ENTITY }, error: null },
    'po_attachments.insert': { data: { id: 'poa-1' }, error: null },
  });
  return {
    stub,
    svc: new PoAttachmentsService(
      makeServiceContext(stub.client, { role: 'manager', organizationId: ORG }) as never,
    ),
  };
}

function orderSvc() {
  const stub = makeSupabaseStub({
    'order_requests.select': { data: [{ id: ENTITY, status: 'completed' }], error: null },
    'order_request_attachments.insert': { data: [{ id: 'att-1' }], error: null },
  });
  return {
    stub,
    svc: new OrderAttachmentsService(
      makeServiceContext(stub.client, { role: 'manager', organizationId: ORG }) as never,
    ),
  };
}

const poInput = (ext = 'pdf') => ({
  purchaseOrderId: ENTITY,
  storagePath: `${ORG}/${ENTITY}/${FILE}.${ext}`,
  fileName: `invoice.${ext}`,
  contentType: 'application/pdf',
  sizeBytes: 1234,
});

beforeEach(() => vi.clearAllMocks());

describe('PoAttachmentsService.add — finalize byte guard', () => {
  it.each([
    ['an HTML document', HTML],
    ['an SVG carrying script', SVG],
    ['a Windows PE binary', PE],
  ])('REJECTS %s declared as application/pdf, and DELETES the object', async (_label, body) => {
    armStorage(body);
    const { stub, svc } = poSvc();

    const err = await svc.add(poInput()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    // No row: the attachment never becomes referencable.
    expect(stub.fromCalls).not.toContain('po_attachments');
    // And the bytes do not survive the rejection.
    expect(remove).toHaveBeenCalledWith([`${ORG}/${ENTITY}/${FILE}.pdf`]);
  });

  it('ACCEPTS real PDF bytes — the guard must not break the normal workflow', async () => {
    armStorage(PDF);
    const { stub, svc } = poSvc();
    await expect(svc.add(poInput())).resolves.toEqual({ id: 'poa-1' });
    expect(stub.fromCalls).toContain('po_attachments');
    expect(remove).not.toHaveBeenCalled();
  });

  it('writes no phantom row when the object was never actually uploaded', async () => {
    // A finalize call that was never preceded by a real PUT: the prefix read
    // fails, which doubles as the existence check.
    armStorage(null);
    const { stub, svc } = poSvc();
    const err = await svc.add(poInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(stub.fromCalls).not.toContain('po_attachments');
  });

  it('records the SNIFFED mime, never the declared one', async () => {
    // A PNG uploaded while declaring application/pdf is legitimate content in
    // a legitimate bucket — but the row must describe the BYTES, or a spoofed
    // header survives verification in the field every reader trusts.
    const png = new Uint8Array(26);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    new DataView(png.buffer).setUint32(16, 2);
    new DataView(png.buffer).setUint32(20, 3);
    armStorage(png);
    const { stub, svc } = poSvc();
    await svc.add({ ...poInput('png'), contentType: 'application/pdf' });
    const insert = stub.chainArgs.get('po_attachments.insert')?.[0]?.[0] as
      | { content_type?: string }
      | undefined;
    expect(insert?.content_type).toBe('image/png');
  });
});

describe('OrderAttachmentsService.add — finalize byte guard', () => {
  const base = {
    orderRequestId: ENTITY,
    storagePath: `${ORG}/${ENTITY}/${FILE}.pdf`,
    fileName: 'proof.pdf',
    contentType: 'application/pdf',
    sizeBytes: 999,
    kind: 'dropoff_photo' as const,
  };

  it('REJECTS an HTML document declared as a PDF, and deletes it', async () => {
    armStorage(HTML);
    const { stub, svc } = orderSvc();
    const err = await svc.add(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(stub.fromCalls).not.toContain('order_request_attachments');
    expect(remove).toHaveBeenCalledWith([base.storagePath]);
  });

  it('ACCEPTS real PDF bytes', async () => {
    armStorage(PDF);
    const { stub, svc } = orderSvc();
    await expect(svc.add(base)).resolves.toBeTruthy();
    expect(stub.fromCalls).toContain('order_request_attachments');
  });

  it('surfaces a user-safe message, not scanner internals', async () => {
    armStorage(PE);
    const { svc } = orderSvc();
    const err = await svc.add(base).catch((e: unknown) => e);
    expect((err as ServiceError).message).toMatch(/failed our security checks/i);
    expect((err as ServiceError).message).not.toMatch(/magic|signature|MZ|sniff/i);
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE-OBJECT SCAN — the half of the guard the sniff tests cannot reach.
//
// `sniffFile` decides from the leading 4 KB; `scanDocumentBytes` REQUIRES the
// whole file, because a PDF's catalog — and therefore its `/OpenAction` and
// any `/Launch` it points at — is written near the END. So
// `verifyStoredDocumentOrDelete` re-downloads the object whenever the prefix
// is not already all of it, and every test above stubs
// `totalSize === prefix.byteLength`, which means every test above takes the
// "prefix IS the whole object" shortcut and none of them has ever exercised
// the re-download.
//
// That gap was not merely unasserted, it was unfalsifiable: the storage stub
// had no `download` method at all, so `head.totalSize > head.prefix.byteLength`
// could be quietly changed to `>=`, or the download dropped entirely, and all
// nine tests stayed green while a 60 KB invoice carrying
// `/OpenAction << /S /Launch >>` past byte 4096 was scanned CLEAN, rowed, and
// then signed and served to whoever opened the PO.
//
// These tests pin the branch by its consequences: the big file is refused with
// the SPECIFIC threat message, the object is deleted, no row is written — and
// an object that becomes unreadable between the prefix read and the full read
// fails CLOSED rather than being accepted on the prefix we did manage to see.
// ---------------------------------------------------------------------------

/** A PDF whose only active content sits PAST the 4 KB sniff window: valid
 *  header, 4200 bytes of harmless filler, then a catalog whose open-action
 *  launches an external program. The prefix alone is clean; the file is not. */
const LAUNCH_PDF = (() => {
  const head = ascii('%PDF-1.7\n1 0 obj\n');
  const filler = new Uint8Array(4200).fill(0x20); // spaces — nothing to find
  const tail = ascii(
    '<< /Type /Catalog /OpenAction << /S /Launch /F (calc.exe) >> >>\ntrailer\n%%EOF\n',
  );
  const out = new Uint8Array(head.byteLength + filler.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(filler, head.byteLength);
  out.set(tail, head.byteLength + filler.byteLength);
  return out;
})();

describe('finalize byte guard — whole-object scan', () => {
  it('FIXTURE PROOF: the leading window is clean and only the full file is not', () => {
    // Without this the tests below could pass for the wrong reason — a payload
    // that happened to land inside the prefix would prove nothing about the
    // re-download. Asserted against the real scanner, not a stub.
    expect(LAUNCH_PDF.byteLength).toBeGreaterThan(4096);
    expect(scanDocumentBytes(LAUNCH_PDF.subarray(0, 4096), 'pdf')).toBeNull();
    expect(scanDocumentBytes(LAUNCH_PDF, 'pdf')).toEqual({
      code: 'pdf_launch_action',
      detail: '/Launch action',
    });
  });

  it('PO: re-downloads the object and REJECTS a /Launch action hidden past the prefix', async () => {
    armStorageLarge(LAUNCH_PDF, { data: new Blob([LAUNCH_PDF]), error: null });
    const { stub, svc } = poSvc();

    const err = await svc.add(poInput()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    // The SPECIFIC message: the uploader is a manager holding a real invoice,
    // and this one names the problem and the way out.
    expect((err as ServiceError).message).toBe(THREAT_MESSAGES.pdf_launch_action);
    // The re-read actually happened, against the same object.
    expect(download).toHaveBeenCalledWith(poInput().storagePath);
    // No row, and the bytes do not survive the rejection.
    expect(stub.fromCalls).not.toContain('po_attachments');
    expect(remove).toHaveBeenCalledWith([poInput().storagePath]);
  });

  it('PO: fails CLOSED when the object is readable at prefix time but not at full-read time', async () => {
    // A transient storage failure must NOT degrade to "accept on what we saw".
    // We have not inspected this object, so it does not get a row.
    armStorageLarge(LAUNCH_PDF, { data: null, error: { message: 'boom' } });
    const { stub, svc } = poSvc();

    const err = await svc.add(poInput()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).message).toBe('This file could not be verified.');
    expect(stub.fromCalls).not.toContain('po_attachments');
    expect(remove).toHaveBeenCalledWith([poInput().storagePath]);
  });

  it('PO: ACCEPTS a big PDF that is clean all the way to the end', async () => {
    // The re-download is a check, not a rejection: the same oversized shape
    // with no active content must still attach, or the guard has broken the
    // normal workflow for every invoice over 4 KB — i.e. most of them.
    const clean = (() => {
      const head = ascii('%PDF-1.7\n1 0 obj\n');
      const filler = new Uint8Array(4200).fill(0x20);
      const tail = ascii('<< /Type /Catalog /Pages 2 0 R >>\ntrailer\n%%EOF\n');
      const out = new Uint8Array(head.byteLength + filler.byteLength + tail.byteLength);
      out.set(head, 0);
      out.set(filler, head.byteLength);
      out.set(tail, head.byteLength + filler.byteLength);
      return out;
    })();
    armStorageLarge(clean, { data: new Blob([clean]), error: null });
    const { stub, svc } = poSvc();

    await expect(svc.add(poInput())).resolves.toEqual({ id: 'poa-1' });
    expect(download).toHaveBeenCalledTimes(1);
    expect(stub.fromCalls).toContain('po_attachments');
    expect(remove).not.toHaveBeenCalled();
  });

  it('PO: does NOT re-download when the prefix already is the whole object', async () => {
    // The skip is deliberate (see upload-verification.ts): a small document is
    // fully inspected by the prefix read alone, so a second round-trip would
    // be pure cost. Pinned so the skip stays a size decision and never becomes
    // a "scan less" decision.
    armStorage(PDF);
    const { svc } = poSvc();
    await expect(svc.add(poInput())).resolves.toEqual({ id: 'poa-1' });
    expect(download).not.toHaveBeenCalled();
  });

  it('ORDER: the same re-download and refusal, on the other caller', async () => {
    // Pattern #26: the two callers share ONE gate now, but the sibling is
    // asserted anyway — a future divergence in either service is the exact
    // failure this file exists to catch.
    armStorageLarge(LAUNCH_PDF, { data: new Blob([LAUNCH_PDF]), error: null });
    const { stub, svc } = orderSvc();
    const path = `${ORG}/${ENTITY}/${FILE}.pdf`;

    const err = await svc
      .add({
        orderRequestId: ENTITY,
        storagePath: path,
        fileName: 'proof.pdf',
        contentType: 'application/pdf',
        sizeBytes: 999,
        kind: 'dropoff_photo' as const,
      })
      .catch((e: unknown) => e);

    expect((err as ServiceError).message).toBe(THREAT_MESSAGES.pdf_launch_action);
    expect(download).toHaveBeenCalledWith(path);
    expect(stub.fromCalls).not.toContain('order_request_attachments');
    expect(remove).toHaveBeenCalledWith([path]);
  });
});
