import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelReturn,
  denyReturn,
  describeReturnError,
  getReturnWorkbench,
  listReturns,
  mintReturnKey,
  planReturnDispositions,
  returnErrorReason,
  runReturnSteps,
} from './returns-api';

// ./api reaches for expo-constants, AsyncStorage and Supabase at import time.
const apiMock = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    code?: string;
    details?: unknown;
    constructor(message: string, status: number, code?: string, details?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  return { api: vi.fn(async (..._a: unknown[]) => ({}) as unknown), ApiError };
});
vi.mock('./api', () => apiMock);

const RET = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';

beforeEach(() => apiMock.api.mockReset());

describe('reads', () => {
  it('lists with the filter, the trimmed search and the cursor; "all" sends no filter', async () => {
    apiMock.api.mockResolvedValueOnce({ rows: [] });
    await listReturns({ filter: 'waiting_for_return', q: '  RMA-1 ', cursor: 'abc=' });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/returns?filter=waiting_for_return&q=RMA-1&cursor=abc%3D');
    apiMock.api.mockResolvedValueOnce({ rows: [] });
    await listReturns({ filter: 'all' });
    expect(apiMock.api).toHaveBeenLastCalledWith('/api/v1/returns');
  });

  it('reads the workbench and parses each destination answer defensively', async () => {
    apiMock.api.mockResolvedValueOnce({
      return: { id: RET },
      lines: [
        { id: 'l1', restock: { returnLineId: 'l1', quantity: '2', case: 'mystery', sources: [], offerOriginal: 'yes', offerSourceIds: [3] } },
        { id: 'l2', restock: null },
      ],
    });
    const wb = await getReturnWorkbench(RET);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/returns/${RET}`);
    expect(wb.lines[0]!.restock).toMatchObject({ quantity: 2, case: null, offerOriginal: false, offerSourceIds: [] });
    expect(wb.lines[1]!.restock).toBeNull();
    expect(wb.chain).toEqual([]);
  });
});

describe('writes (online only)', () => {
  it('posts the steps body and normalizes the returned workbench', async () => {
    apiMock.api.mockResolvedValueOnce({ ran: [{ step: 'receive', outcome: 'done' }], workbench: { return: { id: RET }, lines: [] } });
    const body = { steps: ['receive' as const], expectedRevision: 1, expectedPlanSeq: 4 };
    const res = await runReturnSteps(RET, body);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/returns/${RET}/steps`, { method: 'POST', body });
    expect(res.ran).toEqual([{ step: 'receive', outcome: 'done' }]);
  });

  it('deny, cancel and dispositions post to their routes', async () => {
    apiMock.api.mockResolvedValue({ changed: true });
    await denyReturn(RET, 'Not ours');
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/returns/${RET}/deny`, { method: 'POST', body: { reason: 'Not ours' } });
    await cancelReturn(RET, { expectedRevision: 0, reason: null });
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/returns/${RET}/cancel`, { method: 'POST', body: { expectedRevision: 0, reason: null } });
    const lines = [{ returnLineId: LINE, disposition: 'restock' as const, restock: { target: 'staging' as const } }];
    await planReturnDispositions(RET, lines);
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/returns/${RET}/dispositions`, { method: 'POST', body: { lines } });
  });

  it('mints a v4 key per sheet', () => {
    const a = mintReturnKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mintReturnKey()).not.toBe(a);
  });
});

describe('the words for a refusal (by reason, never by message text)', () => {
  it('maps the database reason through core', () => {
    const e = new apiMock.ApiError('raw words', 400, 'validation_error', { reason: 'restock_location_unavailable', detail: { rule: 'archived' } });
    expect(describeReturnError(e)).toBe('Original rack is no longer available.');
    expect(returnErrorReason(e)).toBe('restock_location_unavailable');
    expect(describeReturnError(new apiMock.ApiError('x', 409, 'conflict', { reason: 'return_changed' }))).toBe(
      'Another person changed this return. Review it again.',
    );
    expect(describeReturnError(new apiMock.ApiError('x', 403, 'forbidden', { reason: 'warehouse_write' }))).toBe(
      "You can't manage returns for this warehouse.",
    );
  });

  it('an internal fault keeps the route words; 401 and 429 have their own', () => {
    expect(describeReturnError(new apiMock.ApiError('Something went wrong. Try again.', 500, 'internal_error', { reason: 'failed' }))).toBe(
      'Something went wrong. Try again.',
    );
    expect(describeReturnError(new apiMock.ApiError('x', 401, 'unauthenticated'))).toBe('Sign in again.');
    expect(describeReturnError(new apiMock.ApiError('x', 429, 'rate_limited'))).toBe('Too many requests. Wait a moment and try again.');
    expect(describeReturnError(new Error('Network request failed'))).toBe("Couldn't reach StockPilot. Check your connection and try again.");
    expect(returnErrorReason(new Error('x'))).toBeNull();
  });
});
