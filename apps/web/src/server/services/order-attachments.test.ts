import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./upload-verification', () => ({
  verifyStoredDocumentOrDelete: vi.fn(async () => ({ mime: 'image/png' })),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));
const adminHandle: { client: unknown } = { client: null };

import { OrderAttachmentsService } from './order-attachments';

const ORDER_ID = '0f000000-0000-4000-8000-0000000000a1';

function service(mfaSatisfied: boolean) {
  const stub = makeSupabaseStub({
    'order_requests.select': { data: { id: ORDER_ID, status: 'completed' }, error: null },
    'order_request_attachments.insert': { data: { id: 'att-1' }, error: null },
    'order_request_attachments.select': {
      data: { id: 'att-1', storage_path: `org-test/${ORDER_ID}/proof.png` },
      error: null,
    },
    'order_request_attachments.delete': { data: null, error: null },
  });
  adminHandle.client = stub.client;
  const svc = new OrderAttachmentsService(
    makeServiceContext(stub.client, { role: 'manager', mfaRequired: true, mfaSatisfied }) as never,
  );
  return { stub, svc };
}

const ADD = {
  orderRequestId: ORDER_ID,
  storagePath: `org-test/${ORDER_ID}/proof.png`,
  fileName: 'proof.png',
  contentType: 'image/png',
  sizeBytes: 1024,
  kind: 'dropoff_photo' as const,
};

const calls: Array<[string, (svc: OrderAttachmentsService) => Promise<unknown>]> = [
  ['add', (svc) => svc.add(ADD)],
  ['remove', (svc) => svc.remove('att-1')],
];

describe('OrderAttachmentsService gives the authenticator answer before an attachment changes', () => {
  it.each(calls)(
    '%s, required and not satisfied: mfa_required, nothing read, written or removed',
    async (_name, run) => {
      const { stub, svc } = service(false);
      await expect(run(svc)).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'mfa_required' },
      });
      expect(stub.fromCalls).toEqual([]);
      expect(stub.client.storage.from).not.toHaveBeenCalled();
    },
  );

  it('add, required and satisfied: the attachment row is written', async () => {
    const { stub, svc } = service(true);
    await expect(svc.add(ADD)).resolves.toEqual({ id: 'att-1' });
    expect(stub.chains.get('order_request_attachments.insert')).toBeDefined();
  });

  it('remove, required and satisfied: the object and the row are removed', async () => {
    const { stub, svc } = service(true);
    await svc.remove('att-1');
    expect(stub.client.storage.from).toHaveBeenCalledWith('order-attachments');
    expect(stub.chains.get('order_request_attachments.delete')).toBeDefined();
  });
});
