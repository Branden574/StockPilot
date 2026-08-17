import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeSupabaseStub({}).client,
}));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));

import { ServiceError } from './context';
import { loadOrderReturns } from './returns';

/**
 * loadOrderReturns — the order page's returns read — driven against a REAL
 * stubbed client (every other consumer of this function mocks it away, so the
 * raw-row -> OrderReturnView mapping was previously unpinned).
 *
 * The contract, read from the function itself:
 *   - `applied` is coerced with `=== true`: null (never written) and false both
 *     read as NOT applied — the 0197 latch is the only thing that counts;
 *   - a read error THROWS a ServiceError('internal_error') — the order page is
 *     what degrades to [], not this function;
 *   - a to-one embed (object), a null embed, string quantities and null
 *     return_number / reason_code / notes / closed_at are normalised;
 *   - the query is scoped by organization_id + order_request_id, ordered by
 *     created_at ascending, and carries NO status filter (in-flight, closed,
 *     denied and cancelled all come back — narrowing is a JS concern).
 */

const ORG = 'org-1';
const ORDER = '11111111-1111-1111-1111-111111111111';
const S_LINE = '5e840bc6-0000-0000-0000-000000000000';

function rawLine(over: Record<string, unknown> = {}) {
  return {
    id: 'rl-1',
    order_request_line_id: S_LINE,
    item_id: 'item-s',
    quantity: 1,
    disposition: 'restock',
    applied: true,
    ...over,
  };
}

function rawReturn(over: Record<string, unknown> = {}) {
  return {
    id: '85d6084b-0000-0000-0000-000000000000',
    return_number: 'RMA-20260817-EEF074',
    status: 'closed',
    reason_code: 'other',
    notes: 'Size S New Hire shirt was swapped out for Ladies size M',
    created_at: '2026-08-17T17:10:00Z',
    closed_at: '2026-08-17T17:12:00Z',
    lines: [rawLine()],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadOrderReturns — mapping', () => {
  it('maps the closed SO-000085 RMA with its applied line, field for field', async () => {
    const stub = makeSupabaseStub({ 'returns.select': { data: [rawReturn()], error: null } });
    const out = await loadOrderReturns(stub.client, ORG, ORDER);
    expect(out).toEqual([
      {
        id: '85d6084b-0000-0000-0000-000000000000',
        returnNumber: 'RMA-20260817-EEF074',
        status: 'closed',
        reasonCode: 'other',
        notes: 'Size S New Hire shirt was swapped out for Ladies size M',
        createdAt: '2026-08-17T17:10:00Z',
        closedAt: '2026-08-17T17:12:00Z',
        lines: [
          {
            orderRequestLineId: S_LINE,
            itemId: 'item-s',
            quantity: 1,
            disposition: 'restock',
            applied: true,
          },
        ],
      },
    ]);
  });

  it('applied is the `=== true` latch: null reads as NOT applied, false reads as NOT applied, only true is true', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [
          rawReturn({
            lines: [
              rawLine({ id: 'a', applied: null }),
              rawLine({ id: 'b', applied: false }),
              rawLine({ id: 'c', applied: true }),
              rawLine({ id: 'd', applied: undefined }),
            ],
          }),
        ],
        error: null,
      },
    });
    const [r] = await loadOrderReturns(stub.client, ORG, ORDER);
    expect(r!.lines.map((l) => l.applied)).toEqual([false, false, true, false]);
  });

  it('a null applied on the ONLY line of a closed header still maps to applied:false (never inferred from status)', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [rawReturn({ status: 'closed', lines: [rawLine({ applied: null })] })],
        error: null,
      },
    });
    const [r] = await loadOrderReturns(stub.client, ORG, ORDER);
    expect(r!.status).toBe('closed');
    expect(r!.lines[0]!.applied).toBe(false);
  });

  it('normalises a to-one embed (object), a null embed, string quantities and null header fields', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [
          rawReturn({
            id: 'r-obj',
            return_number: null,
            reason_code: null,
            notes: null,
            closed_at: null,
            lines: rawLine({ quantity: '2' }),
          }),
          rawReturn({ id: 'r-null', lines: null }),
          rawReturn({ id: 'r-nan', lines: [rawLine({ quantity: 'abc' }), rawLine({ quantity: null })] }),
        ],
        error: null,
      },
    });
    const out = await loadOrderReturns(stub.client, ORG, ORDER);
    expect(out.map((r) => r.id)).toEqual(['r-obj', 'r-null', 'r-nan']);
    expect(out[0]).toMatchObject({
      returnNumber: null,
      reasonCode: null,
      notes: null,
      closedAt: null,
    });
    expect(out[0]!.lines).toEqual([
      { orderRequestLineId: S_LINE, itemId: 'item-s', quantity: 2, disposition: 'restock', applied: true },
    ]);
    expect(out[1]!.lines).toEqual([]);
    expect(out[2]!.lines.map((l) => l.quantity)).toEqual([0, 0]);
  });

  it('null data resolves to [] (no rows, no error)', async () => {
    const stub = makeSupabaseStub({ 'returns.select': { data: null, error: null } });
    await expect(loadOrderReturns(stub.client, ORG, ORDER)).resolves.toEqual([]);
  });

  it('every status comes back — in-flight, closed, denied and cancelled — in the order the query returned them', async () => {
    const statuses = ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled'];
    const stub = makeSupabaseStub({
      'returns.select': {
        data: statuses.map((status, i) => rawReturn({ id: `r-${i}`, status })),
        error: null,
      },
    });
    const out = await loadOrderReturns(stub.client, ORG, ORDER);
    expect(out.map((r) => r.status)).toEqual(statuses);
  });
});

describe('loadOrderReturns — the read error THROWS (the page, not this function, degrades)', () => {
  it('a PostgREST error becomes a ServiceError("internal_error"); nothing is returned', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: null,
        error: { message: 'permission denied for table returns', code: '42501' },
      },
    });
    let thrown: unknown = null;
    try {
      await loadOrderReturns(stub.client, ORG, ORDER);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('internal_error');
    // The raw PostgREST text is kept server-side, never as the public message.
    expect((thrown as ServiceError).internalDetail).toBe('permission denied for table returns');
    expect((thrown as ServiceError).message).not.toContain('permission denied');
  });

  it('an error WITH rows alongside it still throws — error wins over data', async () => {
    const stub = makeSupabaseStub({
      'returns.select': { data: [rawReturn()], error: { message: 'boom' } },
    });
    await expect(loadOrderReturns(stub.client, ORG, ORDER)).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('loadOrderReturns — the query', () => {
  it('reads `returns` once, scoped by organization_id AND order_request_id, oldest first, with NO status filter', async () => {
    const stub = makeSupabaseStub({ 'returns.select': { data: [], error: null } });
    await loadOrderReturns(stub.client, ORG, ORDER);
    expect(stub.fromCalls).toEqual(['returns']);
    const chain = stub.chains.get('returns.select')!;
    const args = stub.chainArgs.get('returns.select')!;
    expect(chain).toEqual(['select', 'eq', 'eq', 'order']);
    expect(args[1]).toEqual(['organization_id', ORG]);
    expect(args[2]).toEqual(['order_request_id', ORDER]);
    expect(args[3]).toEqual(['created_at', { ascending: true }]);
    // No .in / .not / .neq / .eq('status', …) anywhere in the chain.
    expect(chain).not.toContain('in');
    expect(chain).not.toContain('not');
    expect(chain).not.toContain('neq');
    expect(args.some((a) => a[0] === 'status')).toBe(false);
  });

  it('selects the header columns and the embedded return_lines with the applied latch', async () => {
    const stub = makeSupabaseStub({ 'returns.select': { data: [], error: null } });
    await loadOrderReturns(stub.client, ORG, ORDER);
    const select = String(stub.chainArgs.get('returns.select')![0]![0]).replace(/\s+/g, ' ').trim();
    expect(select).toBe(
      'id, return_number, status, reason_code, notes, created_at, closed_at, lines:return_lines (id, order_request_line_id, item_id, quantity, disposition, applied)',
    );
  });
});
