import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./upload-verification', () => ({
  verifyStoredDocumentOrDelete: vi.fn(async () => ({ mime: 'application/pdf' })),
}));

import { ServiceError } from './context';
import { PoAttachmentsService } from './po-attachments';

/**
 * A purchase order's attachments follow the purchase order (migration 0423,
 * review round): the rows and the stored files are read and written only by
 * someone who can read that purchase order. The service refuses a caller
 * without View purchase orders in the permission's words, and a delete first
 * reads the purchase order as the caller (as add() does), so a purchase order
 * they cannot read is not found and nothing is removed.
 */

const ORG = 'org-test';
const PO = '11111111-1111-1111-1111-111111111111';
const ATT = '22222222-2222-2222-2222-222222222222';

function svcWith(stub: ReturnType<typeof makeSupabaseStub>, permissions: ReadonlySet<string>) {
  return new PoAttachmentsService(
    makeServiceContext(stub.client, { role: 'staff', organizationId: ORG, permissions }) as never,
  );
}

const WITHOUT_READ = new Set(['purchase_orders:manage']);
const WITH_READ = new Set(['purchase_orders:manage', 'purchase_orders:read']);

describe('PoAttachmentsService: attachments follow the purchase order', () => {
  it('delete refuses a caller without purchase_orders:read before any read', async () => {
    const stub = makeSupabaseStub({});

    const err = await svcWith(stub, WITHOUT_READ)
      .delete(ATT, PO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toBe('Missing permission: purchase_orders:read');
    expect(stub.fromCalls).toEqual([]);
    expect(stub.client.storage.from).not.toHaveBeenCalled();
  });

  it('add refuses a caller without purchase_orders:read before any read', async () => {
    const stub = makeSupabaseStub({});

    const err = await svcWith(stub, WITHOUT_READ)
      .add({
        purchaseOrderId: PO,
        storagePath: `${ORG}/${PO}/file.pdf`,
        fileName: 'file.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect(stub.fromCalls).toEqual([]);
  });

  it('delete of an attachment on a purchase order the caller cannot read: not found, nothing removed', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: null, error: null },
      'po_attachments.select': { data: { storage_path: `${ORG}/${PO}/file.pdf` }, error: null },
    });

    const err = await svcWith(stub, WITH_READ)
      .delete(ATT, PO)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('not_found');
    expect((err as ServiceError).message).toBe('Purchase order not found.');
    expect(stub.fromCalls).toEqual(['purchase_orders']);
    expect(stub.client.storage.from).not.toHaveBeenCalled();
  });

  it('delete on a purchase order the caller reads removes the file, then the row', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: { id: PO }, error: null },
      'po_attachments.select': { data: { storage_path: `${ORG}/${PO}/file.pdf` }, error: null },
      'po_attachments.delete': { data: null, error: null },
    });

    await svcWith(stub, WITH_READ).delete(ATT, PO);

    expect(stub.fromCalls).toEqual(['purchase_orders', 'po_attachments', 'po_attachments']);
    expect(stub.client.storage.from).toHaveBeenCalledWith('po-attachments');
  });
});
