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
  holdings: vi.fn(),
  /** Every promise handed to keepAlive. */
  kept: [] as Promise<unknown>[],
  /** Every embed started, each pending until the test settles it. */
  embeds: [] as Array<{
    id: string;
    organizationId: string;
    supabase: unknown;
    settle: () => void;
  }>,
}));

vi.mock('server-only', () => ({}));
vi.mock('./lib/defer', () => ({
  keepAlive: vi.fn((work: Promise<unknown>) => {
    h.kept.push(work);
  }),
  defer: vi.fn(),
}));
vi.mock('@/lib/ai/embeddings', () => ({
  embedInventoryItem: vi.fn(
    (id: string, ctx: { organizationId: string; supabase: unknown }) =>
      new Promise<void>((settle) => {
        h.embeds.push({ id, organizationId: ctx.organizationId, supabase: ctx.supabase, settle });
      }),
  ),
}));
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
vi.mock('./rack-holdings', () => ({ fetchPlacementHoldingsByItem: h.holdings }));

import { embedInventoryItem } from '@/lib/ai/embeddings';

import { ServiceError } from './context';
import { ItemGroupingService, UNGROUP_BUSY_RETRIES } from './item-grouping';
import { keepAlive } from './lib/defer';

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
  return {
    svc: new ItemGroupingService(ctx, { sleep: async () => undefined }),
    rpcCalls,
    reads,
    supabase,
  };
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
  h.holdings.mockReset();
  h.holdings.mockResolvedValue({ rack: new Map(), other: new Map() });
  h.kept = [];
  h.embeds = [];
  vi.mocked(keepAlive).mockClear();
  vi.mocked(embedInventoryItem).mockClear();
});

// The MFA floor and the permission are checked by assertPermission, FIRST, in
// both entry points (fix round 1, SEC-2). The database does not read the aal
// claim, so for the phone's route and the web action the MFA step-up depends
// only on this order: a refactor that moved the gate after the RPC or the
// reads would pass every other test here. These prove nothing is called when
// the gate refuses, and that the step-up's reason reaches the caller intact
// (the phone and useStepUp() prompt for TOTP on reason 'aal2_required').
describe('ItemGroupingService: the gate runs before anything else', () => {
  const stepUp = () =>
    new ServiceError('forbidden', 'Re-authenticate with MFA before performing this action.', {
      reason: 'aal2_required',
    });
  const enroll = () =>
    new ServiceError(
      'forbidden',
      'Multi-factor authentication required. Enroll in MFA before performing this action.',
      { reason: 'mfa_required' },
    );

  it('splitSku: an MFA step-up refusal calls no RPC and reads nothing, and keeps its reason', async () => {
    h.assertPermission.mockImplementation(() => {
      throw stepUp();
    });
    const { svc, rpcCalls, reads } = harness([{ data: ANSWER, error: null }]);
    await expect(svc.splitSku(body(), 'app')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      details: { reason: 'aal2_required' },
    });
    expect(rpcCalls).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('previewSplit: an MFA step-up refusal reads nothing, and keeps its reason', async () => {
    h.assertPermission.mockImplementation(() => {
      throw stepUp();
    });
    const { svc, rpcCalls, reads } = harness([], {
      inventory_items: [{ id: A, sku: 'SP-PAIR' }],
    });
    await expect(svc.previewSplit([A])).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'aal2_required' },
    });
    expect(reads).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('an unenrolled member is told to enroll (mfa_required passes through unchanged)', async () => {
    h.assertPermission.mockImplementation(() => {
      throw enroll();
    });
    const { svc, rpcCalls } = harness([]);
    await expect(svc.splitSku(body(), 'web')).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    expect(rpcCalls).toHaveLength(0);
  });

  // A grant revoked after the screen loaded (fix round 1, P5): core's plain
  // words, not "Missing permission: items:update", on the web and the phone.
  it("a missing permission is said in core's words with reason 'permission', and nothing is called", async () => {
    h.assertPermission.mockImplementation(() => {
      throw new ServiceError('forbidden', 'Missing permission: items:update');
    });
    const split = harness([{ data: ANSWER, error: null }]);
    await expect(split.svc.splitSku(body(), 'app')).rejects.toMatchObject({
      code: 'forbidden',
      message: GROUPING_ERROR_WORDS.permission,
      details: { reason: 'permission' },
    });
    expect(split.rpcCalls).toHaveLength(0);
    const preview = harness([]);
    await expect(preview.svc.previewSplit([A])).rejects.toMatchObject({
      code: 'forbidden',
      message: GROUPING_ERROR_WORDS.permission,
      details: { reason: 'permission' },
    });
    expect(preview.reads).toHaveLength(0);
  });
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

describe("ItemGroupingService.splitSku: each record's search embedding follows its new SKU", () => {
  // The UPDATE that gives a record its new SKU clears its old vector (trigger
  // 0401), so a record left un-embedded drops out of the AI assistant's
  // semantic search until the hourly sweep reaches it.
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const SPLIT = {
    action: 'split_sku',
    replay: false,
    items: [
      {
        id: A,
        before_sku: 'SP-PAIR',
        after_sku: 'SP-ABCDE-1111111',
        kept: false,
        anchor_item_id: B,
      },
      { id: B, before_sku: 'SP-PAIR', after_sku: 'SP-PAIR', kept: true, anchor_item_id: B },
      {
        id: C,
        before_sku: 'SP-PAIR',
        after_sku: 'SP-ABCDE-2222222',
        kept: false,
        anchor_item_id: B,
      },
    ],
  };
  const threeRecords = () =>
    body({
      itemIds: [A, B, C],
      expectedSkus: { [A]: 'SP-PAIR', [B]: 'SP-PAIR', [C]: 'SP-PAIR' },
    });
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('re-embeds every record that got a new SKU, not the one that kept it, in one loop held by keepAlive', async () => {
    const { svc, supabase } = harness([{ data: SPLIT, error: null }]);

    await svc.splitSku(threeRecords(), 'web');

    // Handed over, never awaited: splitSku has returned with both embeds
    // still running, and the kept promise settles only after the last one.
    expect(keepAlive).toHaveBeenCalledTimes(1);
    let settled = false;
    void h.kept[0]!.then(() => {
      settled = true;
    });
    for (let i = 0; i < 20 && h.embeds.length < 2; i += 1) await tick();
    expect(h.embeds.map((e) => e.id).sort()).toEqual([A, C].sort());
    // Through the caller's own client (split_item_sku refuses a record the
    // caller cannot write), scoped to the caller's organization.
    for (const e of h.embeds) expect(e).toMatchObject({ organizationId: ORG, supabase });
    h.embeds[0]!.settle();
    await tick();
    expect(settled).toBe(false);
    h.embeds[1]!.settle();
    await tick();
    expect(settled).toBe(true);
  });

  it('a replay re-embeds nothing: the call that applied the split did', async () => {
    const { svc } = harness([{ data: { ...SPLIT, replay: true }, error: null }]);

    await svc.splitSku(threeRecords(), 'app');

    expect(keepAlive).not.toHaveBeenCalled();
    expect(embedInventoryItem).not.toHaveBeenCalled();
  });

  it('a refused split, or an answer it cannot read, embeds nothing', async () => {
    const refused = harness([
      { data: null, error: { code: 'P0001', hint: 'not_shared', message: 'not_shared' } },
    ]);
    await expect(refused.svc.splitSku(body(), 'web')).rejects.toMatchObject({ code: 'conflict' });
    const unread = harness([{ data: { nope: true }, error: null }]);
    await expect(unread.svc.splitSku(body(), 'web')).rejects.toMatchObject({
      code: 'internal_error',
    });

    expect(keepAlive).not.toHaveBeenCalled();
    expect(embedInventoryItem).not.toHaveBeenCalled();
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
          custom_fields: {},
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
        placementLabel: '22-C',
        charterName: null,
        warehouseName: 'DC4',
        quantityOnHand: 4,
        status: 'active',
      },
    ]);
  });

  // Fix round 1, P2: the review line names where each record IS, the way the
  // lists do (core resolvePlacement over the book rack keys / the neutral rack
  // pair, the rack and crate holdings, then bin_location), never bin_location
  // alone. Production: 11 of L4L's 34 shared-SKU book records have a blank
  // bin_location and a book rack with stock on it.
  it("names each record's rack from its rack keys and holdings, as the lists do, not from bin_location alone", async () => {
    const BOOK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const SPLIT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const ON_SITE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const row = (id: string, over: Record<string, unknown>) => ({
      id,
      sku: '9780000000001',
      name: 'Algebra 1',
      item_type: 'book',
      is_bundle: false,
      group_id: null,
      barcode: '9780000000001',
      bin_location: '',
      custom_fields: {},
      quantity_on_hand: 3,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      charter: null,
      warehouse: { name: 'DC4' },
      ...over,
    });
    h.holdings.mockResolvedValue({
      rack: new Map([
        [BOOK, [{ name: '37-B', quantity: 3, kind: 'rack' }]],
        [
          SPLIT,
          [
            { name: '5-A', quantity: 2, kind: 'rack' },
            { name: '12-C', quantity: 1, kind: 'rack' },
          ],
        ],
      ]),
      // B37: a record whose stock all sits on the Site names the Site, not
      // the rack its keys still name.
      other: new Map([[ON_SITE, [{ name: 'DC4', quantity: 3, kind: null, type: 'warehouse' }]]]),
    });
    const { svc } = harness([], {
      inventory_items: [{ id: BOOK, sku: '9780000000001' }],
      'inventory_items:candidates': [
        row(BOOK, { custom_fields: { book_rack_number: '37', book_rack_row: 'B' } }),
        row(SPLIT, { bin_location: 'Green #1 on rack 37-B', created_at: '2026-01-02T00:00:00Z' }),
        row(A, { item_type: 'product', bin_location: '  ', created_at: '2026-01-03T00:00:00Z' }),
        row(ON_SITE, {
          custom_fields: { book_rack_number: '39', book_rack_row: 'C' },
          bin_location: '39-C',
          created_at: '2026-01-04T00:00:00Z',
        }),
      ],
    });
    const out = await svc.previewSplit([BOOK]);
    expect(h.holdings).toHaveBeenCalledWith(expect.anything(), [BOOK, SPLIT, A, ON_SITE]);
    expect(out.candidates.map((c) => [c.id, c.placementLabel])).toEqual([
      [BOOK, 'Rack 37-B'],
      [SPLIT, '12-C ×1 · 5-A ×2'],
      [A, null],
      [ON_SITE, 'DC4 ×3'],
    ]);
  });

  it('refuses more than 100 records, saying so plainly, and answers nothing for none', async () => {
    const { svc, reads } = harness([]);
    // Fix round 1, C7(d): the bulk bar can hold more than 100 shared records;
    // the refusal names the limit instead of "Check the selection".
    await expect(svc.previewSplit(Array.from({ length: 101 }, () => A))).rejects.toMatchObject({
      code: 'validation_error',
      message: GROUPING_ERROR_WORDS.tooMany,
      details: { reason: 'invalid', field: 'item_ids' },
    });
    expect(GROUPING_ERROR_WORDS.tooMany).toBe(
      'Ungroup works on at most 100 records at a time. Select fewer and try again.',
    );
    await expect(svc.previewSplit(['not-a-uuid'])).rejects.toMatchObject({
      code: 'validation_error',
      message: GROUPING_ERROR_WORDS.invalid,
    });
    expect(reads).toHaveLength(0);
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
