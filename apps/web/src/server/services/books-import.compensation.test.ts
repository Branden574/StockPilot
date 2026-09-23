import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The opening-stock compensation for imported books, batched.
 *
 * An import creates up to 200 books; one `.in()` past ~215 uuids fails. The
 * compensation zeroes placements FIRST, then on-hand, because the reverse
 * intermediate (on-hand 0, placed > 0) is phantom-placed stock that picks
 * negative. With batching, a placements batch can fail while every on-hand
 * batch would succeed, so on-hand is zeroed ONLY for items whose placements
 * were zeroed, and the result is reported as "could not be rolled back".
 */

vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  getWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class extends Error {},
}));
vi.spyOn(console, 'error').mockImplementation(() => {});

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { BooksImportService } from './books-import';
import type { ServiceError } from './context';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const IDS = Array.from({ length: 150 }, (_, i) => uuid(i));

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

function stubWith(opts: {
  failLevelsBatch?: number;
  failItemsBatch?: number;
  failVerify?: boolean;
}) {
  let levelCalls = 0;
  let itemCalls = 0;
  const lists = { levels: [] as string[][], items: [] as string[][], verify: [] as string[][] };
  const stub = makeSupabaseStub({
    'item_stock_levels.update': (call) => {
      levelCalls += 1;
      lists.levels.push(inList(call, 'item_id'));
      return levelCalls === opts.failLevelsBatch
        ? { data: null, error: { message: 'levels boom' } }
        : { data: null, error: null };
    },
    'inventory_items.update': (call) => {
      itemCalls += 1;
      const list = inList(call, 'id');
      lists.items.push(list);
      return itemCalls === opts.failItemsBatch
        ? { data: null, error: { message: 'items boom' } }
        : { data: list.map((id) => ({ id })), error: null };
    },
    'item_stock_levels.select': (call) => {
      lists.verify.push(inList(call, 'item_id'));
      return opts.failVerify
        ? { data: null, error: { message: 'verify boom' } }
        : { data: [], error: null };
    },
  });
  return { stub, lists };
}

async function compensate(client: unknown): Promise<ServiceError> {
  const svc = new BooksImportService(makeServiceContext(client) as never) as unknown as {
    compensateOpeningStockOrThrow(ids: string[], err: { message: string }): Promise<never>;
  };
  return svc
    .compensateOpeningStockOrThrow(IDS, { message: 'movement insert refused' })
    .catch((e: unknown) => e as ServiceError);
}

beforeEach(() => vi.clearAllMocks());

describe('BooksImportService opening-stock compensation with 150 books', () => {
  it('zeroes placements, then on-hand, then re-reads, all in batches of at most 100', async () => {
    const { stub, lists } = stubWith({});
    const err = await compensate(stub.client);
    expect(lists.levels.map((l) => l.length)).toEqual([100, 50]);
    expect(lists.items.map((l) => l.length)).toEqual([100, 50]);
    expect(lists.verify.map((l) => l.length)).toEqual([100, 50]);
    // Rolled back cleanly: the "saved with zero on hand" message.
    expect(err.internalDetail).toMatch(/stock adjustment/i);
  });

  it('never zeroes on-hand for items whose placements batch failed', async () => {
    const { stub, lists } = stubWith({ failLevelsBatch: 2 });
    const err = await compensate(stub.client);
    const zeroed = lists.items.flat();
    expect(zeroed).toHaveLength(100);
    for (const id of IDS.slice(100)) expect(zeroed).not.toContain(id);
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('reports "could not be rolled back" when an on-hand batch fails', async () => {
    const { stub, lists } = stubWith({ failItemsBatch: 1 });
    const err = await compensate(stub.client);
    // Every batch is still attempted, so the rest roll back.
    expect(lists.items.map((l) => l.length)).toEqual([100, 50]);
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('reports "could not be rolled back" when the verify re-read fails', async () => {
    const { stub } = stubWith({ failVerify: true });
    const err = await compensate(stub.client);
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });
});
