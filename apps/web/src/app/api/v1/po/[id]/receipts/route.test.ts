import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ReceivingService } from '@/server/services/receiving';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryList: vi.fn(),
}));
vi.mock('@/server/services/receiving', () => ({ ReceivingService: vi.fn() }));

const PO = '11111111-1111-4111-8111-111111111111';
const WH = '33333333-3333-4333-8333-333333333333';
const LINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/**
 * The mobile PO screen mints `mobile-<poId>-<ts>-<rand>` — NOT a uuid. The
 * column is `text` (0296:45), so the route must accept it; a
 * `z.string().uuid()` here would 400 every receipt taken on a phone.
 */
const MOBILE_KEY = `mobile-${PO}-1725500000000-a1b2c3`;

const postReceipt = vi.fn();

function buildCtx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    supabase: {} as never,
  };
}

function buildRequest(body: unknown) {
  return new Request(`https://test.local/api/v1/po/${PO}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const params = { params: Promise.resolve({ id: PO }) };

function post(body: unknown) {
  vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
  return POST(buildRequest(body), params);
}

const validBody = {
  warehouseId: WH,
  idempotencyKey: MOBILE_KEY,
  lines: [
    { poLineId: LINE_A, qtyReceived: 3, qtyAccepted: 3, qtyRejected: 0, unitCost: 4.5 },
    { poLineId: LINE_B, qtyReceived: 1, qtyAccepted: 1, qtyRejected: 0, unitCost: 9 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  postReceipt.mockResolvedValue({ id: 'r1', receipt_number: 'RCV-1' });
  vi.mocked(ReceivingService).mockImplementation(
    () => ({ postReceipt }) as unknown as ReceivingService,
  );
});

/**
 * SP-007b — the mobile PO screen used to call post_receipt_v2 DIRECTLY, so
 * the receipt landed but every side effect ReceivingService performs around
 * it (audit row, `receipt.posted` outbox event the QuickBooks connector
 * subscribes to, `po.received` webhook, inventory-list revalidation) was
 * skipped. This route is the Bearer twin of the web receive action: it must
 * go through the SERVICE, never the RPC.
 */
describe('POST /api/v1/po/[id]/receipts', () => {
  it('posts a multi-line receipt through ReceivingService and returns it', async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(postReceipt).toHaveBeenCalledTimes(1);
    const input = postReceipt.mock.calls[0]?.[0] as {
      purchaseOrderId: string;
      warehouseId: string;
      idempotencyKey: string;
      lines: { poLineId: string; qtyReceived: number; qtyAccepted: number }[];
    };
    // purchaseOrderId comes from the PATH, never the body.
    expect(input.purchaseOrderId).toBe(PO);
    expect(input.warehouseId).toBe(WH);
    expect(input.idempotencyKey).toBe(MOBILE_KEY);
    expect(input.lines).toHaveLength(2);
    expect(input.lines[0]?.poLineId).toBe(LINE_A);
    expect(await res.json()).toMatchObject({
      receiptId: 'r1',
      receiptNumber: 'RCV-1',
    });
  });

  it('accepts a non-uuid, mobile-style idempotency key', async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(postReceipt).toHaveBeenCalledTimes(1);
  });

  it('401s without an API context', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null as never);
    const res = await POST(buildRequest(validBody), params);
    expect(res.status).toBe(401);
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it('400s a body with no lines', async () => {
    const res = await post({ ...validBody, lines: [] });
    expect(res.status).toBe(400);
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it('400s a non-uuid PO id in the path', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    const res = await POST(buildRequest(validBody), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it('400s malformed JSON', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
    const req = new Request(`https://test.local/api/v1/po/${PO}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    }) as unknown as Parameters<typeof POST>[0];
    const res = await POST(req, params);
    expect(res.status).toBe(400);
  });

  it.each([
    ['conflict', 409],
    ['forbidden', 403],
    ['module_disabled', 403],
    ['plan_limit_exceeded', 403],
    ['not_found', 404],
    ['validation_error', 400],
    ['unauthenticated', 401],
    ['internal_error', 500],
  ] as const)('maps ServiceError %s to %i', async (code, status) => {
    postReceipt.mockRejectedValueOnce(new ServiceError(code, 'nope'));
    const res = await post(validBody);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
  });

  /**
   * The mobile screen's recovery policy differs for exactly ONE conflict:
   * an idempotency conflict means the FIRST post committed, so the phone
   * must retire the key AND reload — while `po_already_closed` and a
   * duplicate serial (both also `conflict`) must KEEP the key. HTTP status
   * alone cannot tell them apart, so the route hands back a machine-readable
   * reason in `details`, which ApiError carries through verbatim.
   */
  it('tags an idempotency conflict with details.reason', async () => {
    postReceipt.mockRejectedValueOnce(
      new ServiceError(
        'conflict',
        'A different receipt was already submitted with this idempotency key. Refresh and try again.',
      ),
    );
    const res = await post(validBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'conflict',
      details: { reason: 'idempotency_conflict' },
    });
  });

  it('does NOT tag a closed-PO conflict as an idempotency conflict', async () => {
    postReceipt.mockRejectedValueOnce(
      new ServiceError(
        'conflict',
        'This PO is already closed and cannot accept further receipts.',
      ),
    );
    const res = await post(validBody);
    const body = (await res.json()) as { details?: { reason?: string } };
    expect(res.status).toBe(409);
    expect(body.details?.reason).toBeUndefined();
  });

  it('revalidates the inventory list after a successful post', async () => {
    const { revalidateInventoryList } = await import('@/server/loaders/inventory-list');
    await post(validBody);
    expect(vi.mocked(revalidateInventoryList)).toHaveBeenCalledWith('org-1');
  });
});
