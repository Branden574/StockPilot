import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function armStorage(body: Uint8Array | null) {
  fetchObjectPrefixMock.mockImplementation(async () =>
    body ? { prefix: body, totalSize: body.byteLength } : null,
  );
  remove = vi.fn(async () => ({ data: null, error: null }));
  const api = { remove, createSignedUrl: vi.fn(async () => ({ data: null, error: null })) };
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
