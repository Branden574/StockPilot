import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OrderAttachmentsService.add records a stored file only under the exact path
 * the uploaders mint for THIS order: {organization}/{order}/{file}
 * (orderAttachmentPathShape, HI-8). The database's insert rule asks the same
 * shape since 0451 (docket S3c). A refused path never reaches the byte check
 * or the insert.
 */

const { verifyStoredDocumentOrDelete } = vi.hoisted(() => ({
  verifyStoredDocumentOrDelete: vi.fn(),
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('./upload-verification', () => ({ verifyStoredDocumentOrDelete }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ServiceContext } from './context';
import { OrderAttachmentsService } from './order-attachments';

const ORG = '0a000000-0000-4000-8000-0000000000aa';
const ORDER = '0b000000-0000-4000-8000-0000000000bb';
const OTHER_ORDER = '0c000000-0000-4000-8000-0000000000cc';

function service() {
  const stub = makeSupabaseStub({
    'order_requests.select': { data: { id: ORDER, status: 'completed' }, error: null },
    'order_request_attachments.insert': { data: { id: 'att-new' }, error: null },
  });
  const svc = new OrderAttachmentsService(
    makeServiceContext(stub.client, { organizationId: ORG, role: 'manager' }) as unknown as ServiceContext,
  );
  return { stub, svc };
}

function input(storagePath: string) {
  return {
    orderRequestId: ORDER,
    storagePath,
    fileName: 'proof.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 100,
    kind: 'signature' as const,
  };
}

beforeEach(() => {
  verifyStoredDocumentOrDelete.mockReset();
  verifyStoredDocumentOrDelete.mockResolvedValue({ mime: 'image/jpeg' });
});

describe('OrderAttachmentsService.add path shape', () => {
  it.each([
    ['another order of the organization', `${ORG}/${OTHER_ORDER}/a1b2c3.jpg`],
    ['a fourth part', `${ORG}/${ORDER}/sub/a1b2c3.jpg`],
    ['no file part', `${ORG}/${ORDER}/`],
    ['two parts only', `${ORG}/a1b2c3.jpg`],
    ['another organization', `0d000000-0000-4000-8000-0000000000dd/${ORDER}/a1b2c3.jpg`],
  ])('refuses %s with "Invalid storage path." and records nothing', async (_label, path) => {
    const { stub, svc } = service();
    await expect(svc.add(input(path))).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Invalid storage path.',
    });
    expect(verifyStoredDocumentOrDelete).not.toHaveBeenCalled();
    expect(stub.chains.has('order_request_attachments.insert')).toBe(false);
  });

  it('records the exact {organization}/{order}/{file} path the uploaders mint', async () => {
    const { stub, svc } = service();
    const path = `${ORG}/${ORDER}/a1b2c3d4e5f6.jpg`;
    await expect(svc.add(input(path))).resolves.toEqual({ id: 'att-new' });
    expect(verifyStoredDocumentOrDelete).toHaveBeenCalledWith('order-attachments', path);
    expect(stub.chains.has('order_request_attachments.insert')).toBe(true);
  });
});
