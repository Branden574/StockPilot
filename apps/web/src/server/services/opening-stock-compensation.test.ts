import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared opening-stock compensation (InventoryService create / bulkCreate /
 * bulkCreateSizedVariants and BooksImportService), batched.
 *
 * Since migration 0359 the rollback is ONE RPC per batch,
 * compensate_opening_stock, which zeroes placements and on-hand together; the
 * signed-in user can no longer write either table directly. The RPC returns
 * the ids it compensated (only the caller's own fresh items with no movement),
 * and a re-read proves no placement survived. Anything short of "every id
 * compensated and nothing placed" is reported as "could not be rolled back".
 */

const invalidate = vi.fn();
vi.mock('./lib/inventory-list-cache', () => ({
  invalidateInventoryListAfterWrite: (...a: unknown[]) => invalidate(...a),
}));
vi.spyOn(console, 'error').mockImplementation(() => {});

import { inFilters, makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import type { ServiceError } from './context';
import { compensateOpeningStockOrThrow } from './opening-stock-compensation';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const IDS = Array.from({ length: 150 }, (_, i) => uuid(i));

function rpcIds(call: MockCall): string[] {
  return ((call.args[0]?.[0] as { p_item_ids?: string[] })?.p_item_ids ?? []) as string[];
}

function stubWith(opts: {
  failRpcBatch?: number;
  skipIds?: string[];
  failVerify?: boolean;
  surviving?: number;
}) {
  let rpcCalls = 0;
  const lists = { rpc: [] as string[][], orgs: [] as unknown[], verify: [] as string[][] };
  const stub = makeSupabaseStub({
    'rpc:compensate_opening_stock': (call) => {
      rpcCalls += 1;
      const ids = rpcIds(call);
      lists.rpc.push(ids);
      lists.orgs.push((call.args[0]?.[0] as { p_org_id?: string })?.p_org_id);
      if (rpcCalls === opts.failRpcBatch) return { data: null, error: { message: 'rpc boom' } };
      return { data: ids.filter((id) => !(opts.skipIds ?? []).includes(id)), error: null };
    },
    'item_stock_levels.select': (call) => {
      lists.verify.push((inFilters(call).find(([c]) => c === 'item_id')?.[1] ?? []) as string[]);
      if (opts.failVerify) return { data: null, error: { message: 'verify boom' } };
      return {
        data: Array.from({ length: opts.surviving ?? 0 }, (_, i) => ({ id: `lvl-${i}` })),
        error: null,
      };
    },
  });
  return { stub, lists };
}

async function compensate(
  client: unknown,
  pronoun: 'its' | 'their' = 'their',
): Promise<ServiceError> {
  return compensateOpeningStockOrThrow(
    makeServiceContext(client) as never,
    IDS,
    { message: 'movement insert refused' },
    { tag: '[test]', subject: 'These books were', pronoun, invalidateLabel: 'books.compensate_opening_stock' },
  ).catch((e: unknown) => e as ServiceError);
}

beforeEach(() => vi.clearAllMocks());

describe('compensateOpeningStockOrThrow with 150 items', () => {
  it('calls compensate_opening_stock per batch for the org, then re-reads, and reports a clean rollback', async () => {
    const { stub, lists } = stubWith({});
    const err = await compensate(stub.client);
    expect(lists.rpc.flat().sort()).toEqual([...IDS].sort());
    expect(lists.rpc.every((b) => b.length <= 200)).toBe(true);
    expect(new Set(lists.orgs)).toEqual(new Set([makeServiceContext(stub.client).organizationId]));
    expect(lists.verify.flat().sort()).toEqual([...IDS].sort());
    expect(err.code).toBe('internal_error');
    expect(err.internalDetail).toMatch(/saved with zero on hand\. Add the quantities with a stock adjustment/);
    expect(invalidate).toHaveBeenCalledWith(expect.any(String), 'books.compensate_opening_stock');
  });

  it('never writes item_stock_levels or inventory_items directly (0359 refuses it)', async () => {
    const { stub } = stubWith({});
    await compensate(stub.client);
    for (const key of stub.chains.keys()) {
      expect(key).not.toMatch(/^(item_stock_levels|inventory_items)\.(update|insert|upsert|delete)$/);
    }
  });

  it('still attempts every batch when one RPC batch fails, and reports "could not be rolled back"', async () => {
    const { stub, lists } = stubWith({ failRpcBatch: 1 });
    const err = await compensate(stub.client);
    expect(lists.rpc.flat().sort()).toEqual([...IDS].sort());
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('reports "could not be rolled back" when the RPC skipped ids (not the caller\'s, too old, or already ledgered)', async () => {
    const { stub } = stubWith({ skipIds: [IDS[7]!] });
    const err = await compensate(stub.client);
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('reports "could not be rolled back" when the verify re-read fails', async () => {
    const { stub } = stubWith({ failVerify: true });
    const err = await compensate(stub.client);
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('reports "could not be rolled back" when a placement survives', async () => {
    const { stub } = stubWith({ surviving: 1 });
    const err = await compensate(stub.client);
    expect(err.internalDetail).toMatch(/could not be rolled back/i);
  });

  it('words a single item in the singular', async () => {
    const { stub } = stubWith({});
    const err = await compensate(stub.client, 'its');
    expect(err.internalDetail).toMatch(/so it was saved with zero on hand\. Add the quantity with/);
  });
});
