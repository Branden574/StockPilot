import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review (2026-10-05): the Physical signature action answered nothing, so the
 * panel could not tell a completed hand-over from a short one that backordered
 * the order, and always said the hand-over was complete. It now answers the
 * status the hand-over left (the RPC returns the order row).
 */

const confirmPhysicalSignature = vi.hoisted(() => vi.fn());

vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: {
    forCurrentUser: async () => ({ confirmPhysicalSignature }),
  },
}));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { confirmPhysicalSignatureAction } from './order-requests';

const ORDER = '33333333-3333-4333-8333-333333333333';

describe('confirmPhysicalSignatureAction answers the status the hand-over left', () => {
  beforeEach(() => confirmPhysicalSignature.mockReset());

  it.each(['completed', 'backordered'])('%s', async (status) => {
    confirmPhysicalSignature.mockResolvedValue({ id: ORDER, status });

    const res = await confirmPhysicalSignatureAction({ id: ORDER, signerName: ' Pat Signer ' });

    expect(res).toEqual({ ok: true, data: { status } });
    expect(confirmPhysicalSignature).toHaveBeenCalledWith(ORDER, 'Pat Signer');
  });

  it('a refusal is still answered as an error', async () => {
    const { ServiceError } = await import('@/server/services/context');
    confirmPhysicalSignature.mockRejectedValue(new ServiceError('forbidden', 'Only a manager or the assigned driver can record a physical signature.'));

    const res = await confirmPhysicalSignatureAction({ id: ORDER, signerName: 'Pat' });

    expect(res.ok).toBe(false);
  });
});
