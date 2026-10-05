import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Returns batch their order-line lookups.
 *
 * An order's lines have no cap; one `.in()` past ~215 uuids answers 414
 * locally and fails as "fetch failed" in production after ~7 s of retries.
 * pendingReturnQuantitiesByLine decides what may still be returned: it pages
 * (pending lines past 1000 were cut) and a failed batch throws, as does the
 * order-line read in createFromOrder.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import type { ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { pendingReturnQuantitiesByLine, RMAService } from './returns';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

beforeEach(() => {
  reportError.mockClear();
});

describe('pendingReturnQuantitiesByLine with 250 order lines', () => {
  const lineIds = Array.from({ length: 250 }, (_, i) => uuid(i));

  it('reads pending return lines in batches of at most 100 and sums a line from the last batch', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'return_lines.select': (call) => {
        const list = inList(call, 'order_request_line_id');
        lists.push(list);
        return {
          data: list.map((order_request_line_id) => ({
            order_request_line_id,
            quantity: 2,
            applied: false,
            return: { status: 'requested' },
          })),
          error: null,
        };
      },
    });
    const pending = await pendingReturnQuantitiesByLine(stub.client, 'org-test', lineIds);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(pending.get(uuid(249))).toBe(2);
  });

  it('throws when a batch fails, never "nothing pending"', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'return_lines.select': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    await expect(
      pendingReturnQuantitiesByLine(stub.client, 'org-test', lineIds),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('RMAService.createFromOrder line caps and the item check', () => {
  // A return carries at most 100 lines (the same cap the database function
  // holds), so the item identity check is one read; past 100 lines the body
  // is refused before anything is read.
  const ORDER = uuid(1, 'd');
  const linesOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      orderRequestLineId: uuid(i, 'f'),
      quantity: 1,
      disposition: 'restock' as const,
      itemId: uuid(9, 'a'),
    }));
  const svcFor = (client: unknown) =>
    new RMAService(
      makeServiceContext(client, {
        role: 'manager',
        enabledModules: new Set<ModuleId>(['returns' as ModuleId]),
      }) as never,
    );

  it('refuses 150 lines before any read or call', async () => {
    const stub = makeSupabaseStub({});
    await expect(svcFor(stub.client).createFromOrder(ORDER, { lines: linesOf(150) })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).toHaveLength(0);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('checks 100 named items in one read, then calls the database function', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'order_request_lines.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return { data: list.map((id) => ({ id, item_id: uuid(9, 'a') })), error: null };
      },
      'rpc:create_return_request': { data: null, error: { code: 'XX000', message: 'stop here' } },
    });
    await expect(svcFor(stub.client).createFromOrder(ORDER, { lines: linesOf(100) })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(lists.map((l) => l.length)).toEqual([100]);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['create_return_request']);
  });

  it('throws and calls nothing when the item read fails', async () => {
    const stub = makeSupabaseStub({
      'order_request_lines.select': { data: null, error: { message: 'boom' } },
    });
    await expect(svcFor(stub.client).createFromOrder(ORDER, { lines: linesOf(3) })).rejects.toBeTruthy();
    expect(stub.rpcCalls).toHaveLength(0);
  });
});
