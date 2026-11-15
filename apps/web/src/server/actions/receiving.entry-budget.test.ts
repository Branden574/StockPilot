import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ENTRY_BUDGET_MESSAGE, type PostReceiptInput } from '@stockpilot/core';

/**
 * Security invariant: the web receive action holds a receipt to the request
 * entry budget, lines and their serial numbers together. Input past it is
 * refused with the plain message before the receipt schema parses anything
 * and before the receiving service is made.
 */

const postReceipt = vi.fn(async () => ({ id: 'r1', receipt_number: 'RCV-1' }));
const forCurrentUser = vi.fn(async () => ({ postReceipt }));
vi.mock('@/server/services/receiving', () => ({
  ReceivingService: { forCurrentUser: () => forCurrentUser() },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { postReceiptAction } from './receiving';

const PO = '11111111-1111-4111-8111-111111111111';
const WH = '33333333-3333-4333-8333-333333333333';
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT_RETRY_ID = '44444444-4444-4444-8444-444444444444';

/** A receipt of `lines` lines with `serials` serial numbers on each. */
function input(lines: number, serials: number): PostReceiptInput {
  return {
    purchaseOrderId: PO,
    warehouseId: WH,
    idempotencyKey: RECEIPT_RETRY_ID,
    lines: Array.from({ length: lines }, () => ({
      poLineId: LINE,
      qtyReceived: serials,
      qtyAccepted: serials,
      qtyRejected: 0,
      serials: new Array(serials).fill('S'),
    })),
  };
}

let arrayParse: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  arrayParse = vi.spyOn(z.ZodArray.prototype, '_parse');
});

afterEach(() => arrayParse.mockRestore());

describe('postReceiptAction: the request entry budget', () => {
  it('refuses lines times serials past the budget, before parsing and before the service', async () => {
    const res = await postReceiptAction(input(21, 9_999));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('validation_error');
      expect(res.error.message).toBe(ENTRY_BUDGET_MESSAGE);
    }
    expect(arrayParse).not.toHaveBeenCalled();
    expect(forCurrentUser).not.toHaveBeenCalled();
  });

  it('takes a receipt of exactly the budget on to the service', async () => {
    const res = await postReceiptAction(input(20, 9_999));

    expect(res.ok).toBe(true);
    expect(arrayParse).toHaveBeenCalled();
    expect(postReceipt).toHaveBeenCalledTimes(1);
  });
});
