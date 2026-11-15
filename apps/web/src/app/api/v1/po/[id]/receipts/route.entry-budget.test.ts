import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ENTRY_BUDGET_MESSAGE, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ReceivingService } from '@/server/services/receiving';

import { POST } from './route';

/**
 * Security invariant: a receipt posted from the phone route holds at most the
 * request entry budget in list entries, lines and their serial numbers
 * together. A body past it is refused with the plain message before the
 * receipt schema parses anything and before the receiving service is made.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/services/receiving', () => ({ ReceivingService: vi.fn() }));

const PO = '11111111-1111-4111-8111-111111111111';
const WH = '33333333-3333-4333-8333-333333333333';
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const postReceipt = vi.fn();

/** A receipt of `lines` lines with `serials` serial numbers on each. */
function body(lines: number, serials: number) {
  return {
    warehouseId: WH,
    idempotencyKey: `mobile-${PO}-1725500000000-a1b2c3`,
    lines: Array.from({ length: lines }, () => ({
      poLineId: LINE,
      qtyReceived: serials,
      qtyAccepted: serials,
      serials: new Array(serials).fill('S'),
    })),
  };
}

function post(payload: unknown) {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    supabase: {},
  } as never);
  const req = new Request(`https://test.local/api/v1/po/${PO}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }) as unknown as Parameters<typeof POST>[0];
  return POST(req, { params: Promise.resolve({ id: PO }) });
}

let arrayParse: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  postReceipt.mockResolvedValue({ id: 'r1', receipt_number: 'RCV-1' });
  vi.mocked(ReceivingService).mockImplementation(function () {
    return { postReceipt } as unknown as ReceivingService;
  });
  arrayParse = vi.spyOn(z.ZodArray.prototype, '_parse');
});

afterEach(() => arrayParse.mockRestore());

describe('POST /api/v1/po/[id]/receipts: the request entry budget', () => {
  it('refuses lines times serials past the budget, before parsing and before the service', async () => {
    // 21 lines + 21 x 9,999 serials: each list within its own limit, the total past the budget.
    const res = await post(body(21, 9_999));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_error', message: ENTRY_BUDGET_MESSAGE });
    expect(arrayParse).not.toHaveBeenCalled();
    expect(ReceivingService).not.toHaveBeenCalled();
  });

  it('takes a receipt of exactly the budget on to the service', async () => {
    // 20 lines + 20 x 9,999 serials = 200,000 entries.
    const res = await post(body(20, 9_999));

    expect(res.status).toBe(200);
    expect(arrayParse).toHaveBeenCalled();
    expect(postReceipt).toHaveBeenCalledTimes(1);
  });
});
