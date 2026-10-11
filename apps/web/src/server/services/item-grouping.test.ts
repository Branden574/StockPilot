// ItemGroupingService: the one service the web action and the phone's bearer
// route share for Ungroup (split_item_sku, migration 0399). It never touches
// InventoryService.update (whose Model B fan-out is the reason a group could
// not be split); it calls the database function with the same key on a busy
// retry, refreshes the Items/Books cache and the order catalog after a split,
// and words every refusal from core's map.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS } from '@stockpilot/core';

const h = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  invalidate: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./context', () => ({
  withContext: vi.fn(),
  assertPermission: h.assertPermission,
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
}));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: h.invalidate }));
vi.mock('next/cache', () => ({ revalidateTag: h.revalidateTag }));

import { ItemGroupingService, UNGROUP_BUSY_RETRIES } from './item-grouping';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ANSWER = {
  action: 'split_sku',
  replay: false,
  items: [
    {
      id: A,
      before_sku: 'SP-PAIR',
      after_sku: 'SP-ABCDE-1234567',
      kept: false,
      anchor_item_id: null,
    },
  ],
};

type RpcResult = {
  data: unknown;
  error: { code?: string; hint?: string; message?: string; details?: string } | null;
};

function harness(rpcResults: RpcResult[], tables: Record<string, unknown[]> = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const reads: Array<{
    table: string;
    filters: Array<[string, string, unknown]>;
    select: string;
    order: string[];
  }> = [];
  const supabase = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResults.shift() ?? { data: null, error: { message: 'no more answers' } };
    }),
    from: (table: string) => {
      const read = {
        table,
        filters: [] as Array<[string, string, unknown]>,
        select: '',
        order: [] as string[],
      };
      reads.push(read);
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => ((read.select = cols), q);
      for (const op of ['eq', 'in', 'is'] as const) {
        q[op] = (col: string, val: unknown) => (read.filters.push([op, col, val]), q);
      }
      q.order = (col: string) => (read.order.push(col), q);
      q.limit = () => q;
      (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res({
          data: tables[read.select.includes('created_at') ? `${table}:candidates` : table] ?? [],
          error: null,
        });
      return q;
    },
  };
  const ctx = {
    organizationId: ORG,
    userId: ME,
    role: 'manager',
    supabase,
    enabledModules: new Set<string>(),
    mfaRequired: false,
    mfaSatisfied: true,
  } as never;
  return { svc: new ItemGroupingService(ctx, { sleep: async () => undefined }), rpcCalls, reads };
}

const body = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: KEY,
  organizationId: ORG,
  actorUserId: ME,
  itemIds: [A],
  expectedSkus: { [A]: 'SP-PAIR' },
  ...over,
});

beforeEach(() => {
  h.assertPermission.mockReset();
  h.invalidate.mockReset();
  h.revalidateTag.mockReset();
});

describe('ItemGroupingService.splitSku', () => {
  it('calls split_item_sku with the snake_case request and the key, then refreshes the lists and the order catalog', async () => {
    const { svc, rpcCalls } = harness([{ data: ANSWER, error: null }]);
    const out = await svc.splitSku(body(), 'web');
    expect(h.assertPermission).toHaveBeenCalledWith(expect.anything(), 'items:update');
    expect(rpcCalls).toEqual([
      {
        fn: 'split_item_sku',
        args: {
          p_key: KEY,
          p_request: {
            action: 'split_sku',
            organization_id: ORG,
            actor_user_id: ME,
            surface: 'web',
            item_ids: [A],
            expected_skus: { [A]: 'SP-PAIR' },
            anchor_item_ids: [],
          },
        },
      },
    ]);
    expect(out).toEqual({
      organizationId: ORG,
      replay: false,
      items: [
        {
          id: A,
          beforeSku: 'SP-PAIR',
          afterSku: 'SP-ABCDE-1234567',
          kept: false,
          anchorItemId: null,
        },
      ],
    });
    expect(h.invalidate).toHaveBeenCalledWith(ORG, 'item.grouping');
    expect(h.revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
  });

  it('a replay is answered as one and still refreshes (the first answer may have been lost)', async () => {
    const { svc } = harness([{ data: { ...ANSWER, replay: true }, error: null }]);
    expect((await svc.splitSku(body(), 'app')).replay).toBe(true);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('refuses a body for another organization, or another account, before calling the database', async () => {
    const other = harness([]);
    await expect(other.svc.splitSku(body({ organizationId: B }), 'web')).rejects.toMatchObject({
      code: 'forbidden',
      message: GROUPING_ERROR_WORDS.workspaceChanged,
    });
    await expect(other.svc.splitSku(body({ actorUserId: B }), 'web')).rejects.toMatchObject({
      code: 'forbidden',
      message: GROUPING_ERROR_WORDS.actorMismatch,
    });
    expect(other.rpcCalls).toHaveLength(0);
  });

  it('refuses a malformed body as validation_error naming the field, before the database', async () => {
    const { svc, rpcCalls } = harness([]);
    await expect(svc.splitSku(body({ itemIds: [] }), 'web')).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'invalid', field: 'item_ids' },
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it('retries a busy answer with the SAME key, at most twice', async () => {
    const busy = { data: null, error: { code: '55P03', hint: 'busy', message: 'busy' } };
    const ok = harness([busy, busy, { data: ANSWER, error: null }]);
    await expect(ok.svc.splitSku(body(), 'web')).resolves.toMatchObject({ replay: false });
    expect(ok.rpcCalls.map((c) => c.args.p_key)).toEqual([KEY, KEY, KEY]);
    expect(UNGROUP_BUSY_RETRIES).toBe(2);

    const stuck = harness([busy, busy, busy, { data: ANSWER, error: null }]);
    await expect(stuck.svc.splitSku(body(), 'web')).rejects.toMatchObject({
      code: 'conflict',
      message: GROUPING_ERROR_WORDS.busy,
      details: { reason: 'busy', retryable: true },
    });
    expect(stuck.rpcCalls).toHaveLength(3);
  });

  it('words a refusal from core by its hint, names the records, and refreshes nothing', async () => {
    const { svc } = harness([
      {
        data: null,
        error: {
          code: 'P0001',
          hint: 'not_shared',
          message: 'not_shared',
          details: JSON.stringify({ itemIds: [A] }),
        },
      },
    ]);
    await expect(svc.splitSku(body(), 'web')).rejects.toMatchObject({
      code: 'conflict',
      message: GROUPING_ERROR_WORDS.notShared,
      details: { reason: 'not_shared', itemIds: [A] },
    });
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });

  it('an answer it cannot read, or an unknown error, is an internal error', async () => {
    const unread = harness([{ data: { nope: true }, error: null }]);
    await expect(unread.svc.splitSku(body(), 'web')).rejects.toMatchObject({
      code: 'internal_error',
    });
    const odd = harness([{ data: null, error: { code: 'XX000', message: 'boom' } }]);
    await expect(odd.svc.splitSku(body(), 'web')).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('ItemGroupingService.previewSplit', () => {
  it('reads the selected rows, then every live record of their SKUs the caller can read, oldest first', async () => {
    const { svc, reads } = harness([], {
      inventory_items: [
        { id: A, sku: 'SP-PAIR' },
        { id: B, sku: '  ' },
      ],
      'inventory_items:candidates': [
        {
          id: A,
          sku: 'SP-PAIR',
          name: 'Mouse pad',
          item_type: 'product',
          is_bundle: false,
          group_id: null,
          barcode: null,
          bin_location: '22-C',
          quantity_on_hand: 4,
          status: 'active',
          created_at: '2026-01-02T00:00:00Z',
          charter: null,
          warehouse: { name: 'DC4' },
        },
      ],
    });
    const out = await svc.previewSplit([A, B]);
    expect(h.assertPermission).toHaveBeenCalledWith(expect.anything(), 'items:update');
    expect(reads[0]!.filters).toEqual([
      ['eq', 'organization_id', ORG],
      ['in', 'id', [A, B]],
      ['is', 'deleted_at', null],
    ]);
    // Blank SKUs never group: only SP-PAIR is looked up.
    expect(reads[1]!.filters).toEqual([
      ['eq', 'organization_id', ORG],
      ['in', 'sku', ['SP-PAIR']],
      ['is', 'deleted_at', null],
    ]);
    expect(reads[1]!.order).toEqual(['created_at', 'id']);
    expect(out.candidates).toEqual([
      {
        id: A,
        sku: 'SP-PAIR',
        name: 'Mouse pad',
        itemType: 'product',
        isBundle: false,
        inFamily: false,
        barcode: null,
        binLocation: '22-C',
        charterName: null,
        warehouseName: 'DC4',
        quantityOnHand: 4,
        status: 'active',
      },
    ]);
  });

  it('refuses more than 100 records and answers nothing for none', async () => {
    const { svc } = harness([]);
    await expect(svc.previewSplit(Array.from({ length: 101 }, () => A))).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(svc.previewSplit([])).resolves.toEqual({ candidates: [] });
  });
});

describe('ItemGroupingService.countSkuSiblings', () => {
  it('counts the OTHER live records with the same raw SKU that the caller can read (head count, RLS client)', async () => {
    const calls: Array<{ cols: string; opts: unknown; filters: Array<[string, string, unknown]> }> =
      [];
    const supabase = {
      from: () => {
        const call = {
          cols: '',
          opts: undefined as unknown,
          filters: [] as Array<[string, string, unknown]>,
        };
        calls.push(call);
        const q: Record<string, unknown> = {};
        q.select = (cols: string, opts: unknown) => ((call.cols = cols), (call.opts = opts), q);
        for (const op of ['eq', 'is', 'neq'] as const) {
          q[op] = (c: string, v: unknown) => (call.filters.push([op, c, v]), q);
        }
        (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
          res({ count: 2, error: null });
        return q;
      },
    };
    const svc = new ItemGroupingService({ organizationId: ORG, userId: ME, supabase } as never);
    expect(await svc.countSkuSiblings(A, 'SP-PAIR')).toBe(2);
    expect(calls[0]).toEqual({
      cols: 'id',
      opts: { count: 'exact', head: true },
      filters: [
        ['eq', 'organization_id', ORG],
        ['eq', 'sku', 'SP-PAIR'],
        ['is', 'deleted_at', null],
        ['neq', 'id', A],
      ],
    });
  });

  it('a blank SKU never groups (0 without a read); a failed read is null, never a guess', async () => {
    const failing = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'neq']) q[m] = () => q;
        (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
          res({ count: null, error: { message: 'boom' } });
        return q;
      },
    };
    const svc = new ItemGroupingService({
      organizationId: ORG,
      userId: ME,
      supabase: failing,
    } as never);
    expect(await svc.countSkuSiblings(A, '   ')).toBe(0);
    expect(await svc.countSkuSiblings(A, 'SP-PAIR')).toBeNull();
  });
});
