import { beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn(async (..._a: unknown[]) => ({ recorded: true }));
vi.mock('@/server/services/return-request-draft', () => ({
  recordReturnRequestDrafted: (...a: unknown[]) => record(...a),
}));
const withContext = vi.fn();
vi.mock('@/server/services/context', () => ({ withContext: () => withContext() }));

import { recordReturnRequestDraftedAction } from './return-request';

const INPUT = {
  orderId: 'b3f1c2d4-1111-4222-8333-444455556666',
  returnNumber: 'RMA-20261110-AB12CD',
  isCondensed: false,
  surface: 'order' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordReturnRequestDraftedAction', () => {
  it("hands the input to the service with the caller's own context", async () => {
    const ctx = { organizationId: 'org-1', userId: 'u-1' };
    withContext.mockResolvedValueOnce(ctx);
    await expect(recordReturnRequestDraftedAction(INPUT)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(ctx, INPUT);
  });

  it('never rejects when the context or the service fails', async () => {
    withContext.mockRejectedValueOnce(new Error('context down'));
    await expect(recordReturnRequestDraftedAction(INPUT)).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();

    withContext.mockResolvedValueOnce({});
    record.mockRejectedValueOnce(new Error('service down'));
    await expect(recordReturnRequestDraftedAction(INPUT)).resolves.toBeUndefined();
  });

  it('lets a redirect through (the session ended)', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/sign-in;307;' });
    withContext.mockRejectedValueOnce(redirect);
    await expect(recordReturnRequestDraftedAction(INPUT)).rejects.toBe(redirect);
  });
});
