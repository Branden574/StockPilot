import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * markReturned() and cancel() read the rental before acting on it. Both reads
 * dropped their error, so a transient failure answered "Rental not found." —
 * a misleading dead end for someone holding a real rental. A failed read is
 * now internal_error, and nothing is written or emailed after it.
 */

vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/rentals', () => ({
  sendRentalCheckoutEmail: vi.fn(async () => undefined),
  sendRentalReturnedEmail: vi.fn(async () => undefined),
}));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { sendRentalReturnedEmail } from '@/lib/email/rentals';

import { RentalsService } from './rentals';

function svc(rentalRead: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({
    'rentals.select.maybeSingle': rentalRead,
    'rpc:return_rental': { data: 'returned', error: null },
    'rpc:cancel_rental': { data: 'cancelled', error: null },
  });
  return { stub, service: new RentalsService(makeServiceContext(stub.client)) };
}

const FAILED = { data: null, error: { message: 'connection reset' } };
const MISSING = { data: null, error: null };

beforeEach(() => vi.clearAllMocks());

describe('RentalsService — a failed rental read is not a missing rental', () => {
  it('markReturned: read error is internal_error, and no return is attempted', async () => {
    const { stub, service } = svc(FAILED);
    await expect(service.markReturned({ id: 'r-1' })).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: 'connection reset',
    });
    expect(stub.rpcCalls).toHaveLength(0);
    expect(sendRentalReturnedEmail).not.toHaveBeenCalled();
  });

  it('cancel: read error is internal_error, and no cancel is attempted', async () => {
    const { stub, service } = svc(FAILED);
    await expect(service.cancel({ id: 'r-1', reason: 'Wrong items' })).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: 'connection reset',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a rental that genuinely is not there is still not_found', async () => {
    const { service } = svc(MISSING);
    await expect(service.markReturned({ id: 'r-1' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.cancel({ id: 'r-1', reason: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
