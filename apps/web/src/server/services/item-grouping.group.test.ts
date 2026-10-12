// ItemGroupingService for Group selected (slice G2, migration 0400): the one
// service the web actions and the phone's bearer routes share for the review
// (item_grouping_preview, read as the caller) and for group / remove / rename
// (apply_item_grouping). The gate runs first; the organization and the
// account are the request's own; a busy answer is retried with the same key;
// an applied answer refreshes the Items/Books cache and the order catalog's
// tag, a no-op refreshes nothing; every refusal is worded from core's map.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, groupingPreviewKey } from '@stockpilot/core';

const h = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  invalidate: vi.fn(),
  revalidateTag: vi.fn(),
  holdings: vi.fn(),
  images: vi.fn(),
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
vi.mock('./rack-holdings', () => ({ fetchRackHoldingsByItem: h.holdings }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = h.images;
  },
}));

import { ServiceError } from './context';
import { ItemGroupingService, UNGROUP_BUSY_RETRIES } from './item-grouping';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const G = '99999999-9999-4999-8999-999999999999';
const CH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type RpcResult = {
  data: unknown;
  error: { code?: string; hint?: string; message?: string; details?: string } | null;
};

function harness(rpcResults: RpcResult[], tables: Record<string, unknown[]> = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const reads: Array<{ table: string; filters: Array<[string, string, unknown]>; select: string }> =
    [];
  const supabase = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResults.shift() ?? { data: null, error: { message: 'no more answers' } };
    }),
    from: (table: string) => {
      const read = { table, filters: [] as Array<[string, string, unknown]>, select: '' };
      reads.push(read);
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => ((read.select = cols), q);
      for (const op of ['eq', 'in', 'is'] as const) {
        q[op] = (col: string, val: unknown) => (read.filters.push([op, col, val]), q);
      }
      q.order = () => q;
      q.limit = () => q;
      (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res({ data: tables[table] ?? [], error: null });
      return q;
    },
  };
  const ctx = {
    organizationId: ORG,
    userId: ME,
    role: 'staff',
    supabase,
    enabledModules: new Set<string>(),
    mfaRequired: false,
    mfaSatisfied: true,
  } as never;
  return { svc: new ItemGroupingService(ctx, { sleep: async () => undefined }), rpcCalls, reads };
}

const previewRecord = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Polo XXXL',
  sku: `SKU-${id.slice(0, 4)}`,
  barcode: null,
  isbn_fields: { isbn: null, isbn13: null, isbn10: null },
  item_type: 'product',
  is_bundle: false,
  is_rental: false,
  product_group_id: null,
  product_group_name: null,
  variant_size: null,
  charter_id: CH,
  warehouse_id: WH,
  bin_location: '15-A',
  custom_fields: null,
  quantity_on_hand: 2,
  created_at: '2026-01-01T00:00:00Z',
  display_group: null,
  writable: true,
  ...over,
});

const PREVIEW = {
  records: [previewRecord(A), previewRecord(B)],
  unavailable_count: 1,
  same_sku_siblings: [],
  candidate_groups: [],
  target_group: null,
};

const groupBody = (over: Record<string, unknown> = {}) => ({
  action: 'group',
  idempotencyKey: KEY,
  organizationId: ORG,
  actorUserId: ME,
  itemIds: [A, B],
  target: { kind: 'new', name: 'Polo XXXL' },
  expectedGroups: { [A]: null, [B]: null },
  ...over,
});

const APPLIED = {
  action: 'group',
  outcome: 'applied',
  group: { id: G, name: 'Polo XXXL', version: 1, item_type: 'product', closed: false },
  changes: [
    { item_id: A, from_group_id: null, to_group_id: G },
    { item_id: B, from_group_id: null, to_group_id: G },
  ],
  closed_group_ids: [],
  created: true,
  replay: false,
};

beforeEach(() => {
  h.assertPermission.mockReset();
  h.invalidate.mockReset();
  h.revalidateTag.mockReset();
  h.holdings.mockReset();
  h.holdings.mockResolvedValue(new Map());
  h.images.mockReset();
  h.images.mockResolvedValue(new Map());
});

describe('Group selected: the gate runs before anything else', () => {
  const stepUp = () =>
    new ServiceError('forbidden', 'Re-authenticate with MFA before performing this action.', {
      reason: 'aal2_required',
    });

  it('an MFA step-up refusal reaches the caller unchanged, with no RPC and no read (preview and apply)', async () => {
    for (const run of [
      (svc: ItemGroupingService) => svc.previewGroup([A, B]),
      (svc: ItemGroupingService) => svc.applyGrouping(groupBody(), 'web'),
    ]) {
      h.assertPermission.mockImplementationOnce(() => {
        throw stepUp();
      });
      const { svc, rpcCalls, reads } = harness([]);
      await expect(run(svc)).rejects.toMatchObject({ details: { reason: 'aal2_required' } });
      expect(rpcCalls).toHaveLength(0);
      expect(reads).toHaveLength(0);
    }
  });

  it('a missing items:update says so in plain words', async () => {
    h.assertPermission.mockImplementationOnce(() => {
      throw new ServiceError('forbidden', 'Missing permission: items:update');
    });
    const { svc, rpcCalls } = harness([]);
    await expect(svc.applyGrouping(groupBody(), 'web')).rejects.toMatchObject({
      code: 'forbidden',
      message: GROUPING_ERROR_WORDS.permission,
    });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('Group selected: the review', () => {
  it('asks item_grouping_preview as the caller for the distinct ids and the target, and names each record', async () => {
    h.holdings.mockResolvedValue(
      new Map([
        [
          A,
          [
            { name: '15-A', quantity: 1, kind: 'rack' },
            { name: '2-C', quantity: 1, kind: 'rack' },
          ],
        ],
      ]),
    );
    h.images.mockResolvedValue(
      new Map([[A, { url: 'https://img/a', thumbUrl: 'https://img/a-thumb', lqip: null }]]),
    );
    const { svc, rpcCalls, reads } = harness([{ data: PREVIEW, error: null }], {
      charters: [{ id: CH, name: 'North' }],
      warehouses: [{ id: WH, name: 'DC4' }],
    });
    const review = await svc.previewGroup([B, A, A.toUpperCase()], G);
    expect(rpcCalls).toEqual([
      {
        fn: 'item_grouping_preview',
        args: { p_request: { organization_id: ORG, item_ids: [B, A], group_id: G } },
      },
    ]);
    expect(review.previewKey).toBe(groupingPreviewKey(ORG, [A, B], G));
    expect(review.unavailableCount).toBe(1);
    expect(review.records.map((r) => [r.id, r.charterName, r.warehouseName, r.imageUrl])).toEqual([
      [A, 'North', 'DC4', 'https://img/a-thumb'],
      [B, 'North', 'DC4', null],
    ]);
    expect(review.records[0]!.placementLabel).toContain('15-A');
    expect(review.records[1]!.placementLabel).toBe('15-A');
    // Every read is scoped to the organization and is the caller's own client.
    for (const r of reads) expect(r.filters).toContainEqual(['eq', 'organization_id', ORG]);
  });

  it('refuses more than 100 records and ids that are not uuids, before any call', async () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const { svc, rpcCalls } = harness([]);
    await expect(svc.previewGroup(many)).rejects.toMatchObject({
      code: 'validation_error',
      message: GROUPING_ERROR_WORDS.groupTooMany,
    });
    await expect(svc.previewGroup(['nope'])).rejects.toMatchObject({ code: 'validation_error' });
    await expect(svc.previewGroup([A], 'nope')).rejects.toMatchObject({
      details: { field: 'group_id' },
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it('a decoration read that fails degrades to no name or picture, never to an error', async () => {
    h.images.mockRejectedValue(new Error('storage down'));
    const { svc } = harness([{ data: PREVIEW, error: null }]);
    const review = await svc.previewGroup([A, B]);
    expect(review.records.map((r) => r.imageUrl)).toEqual([null, null]);
    expect(review.records.map((r) => r.charterName)).toEqual([null, null]);
  });
});

describe('Group selected: apply', () => {
  it('sends the snake_case request with the key, refreshes the list cache and the order catalog tag', async () => {
    const { svc, rpcCalls } = harness([{ data: APPLIED, error: null }]);
    const res = await svc.applyGrouping(groupBody(), 'app');
    expect(rpcCalls).toEqual([
      {
        fn: 'apply_item_grouping',
        args: {
          p_key: KEY,
          p_request: {
            action: 'group',
            organization_id: ORG,
            actor_user_id: ME,
            surface: 'app',
            item_ids: [A, B],
            target: { kind: 'new', name: 'Polo XXXL' },
            expected_groups: { [A]: null, [B]: null },
            move_item_ids: [],
            acknowledge_product_family: false,
          },
        },
      },
    ]);
    expect(res.outcome).toMatchObject({ outcome: 'applied', created: true, group: { id: G } });
    expect(h.invalidate).toHaveBeenCalledWith(ORG, 'item.grouping');
    expect(h.revalidateTag).toHaveBeenCalledWith('orders-new-v2-catalog', 'max');
  });

  it('a no-op wrote nothing and refreshes nothing', async () => {
    const { svc } = harness([
      { data: { ...APPLIED, outcome: 'noop', changes: [], created: false }, error: null },
    ]);
    const res = await svc.applyGrouping(groupBody(), 'web');
    expect(res.outcome.outcome).toBe('noop');
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });

  it('a replay of an applied request refreshes again (its first answer may have been lost before the refresh)', async () => {
    const { svc } = harness([{ data: { ...APPLIED, replay: true }, error: null }]);
    const res = await svc.applyGrouping(groupBody(), 'web');
    expect(res.outcome.replay).toBe(true);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('retries busy at most twice with the SAME key, then says try again', async () => {
    const busy = { data: null, error: { code: '55P03', hint: 'busy', message: 'busy' } };
    const { svc, rpcCalls } = harness([busy, busy, busy]);
    await expect(svc.applyGrouping(groupBody(), 'web')).rejects.toMatchObject({
      message: GROUPING_ERROR_WORDS.busy,
      details: { reason: 'busy', retryable: true },
    });
    expect(rpcCalls).toHaveLength(UNGROUP_BUSY_RETRIES + 1);
    expect(new Set(rpcCalls.map((c) => c.args.p_key))).toEqual(new Set([KEY]));
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('words grouping refusals for grouping (a kit, a conflict, a stale group), never with a charter or rack change', async () => {
    const cases: Array<[RpcResult['error'], string]> = [
      [
        {
          code: 'P0001',
          hint: 'not_groupable',
          details: JSON.stringify({ reason: 'kit', itemIds: [A] }),
        },
        GROUPING_ERROR_WORDS.groupKit,
      ],
      [
        { code: 'P0001', hint: 'membership_conflict', details: JSON.stringify({ itemIds: [A] }) },
        GROUPING_ERROR_WORDS.membershipConflict,
      ],
      [{ code: 'P0001', hint: 'group_changed' }, GROUPING_ERROR_WORDS.groupChanged],
      [{ code: 'P0002', hint: 'group_not_found' }, GROUPING_ERROR_WORDS.groupNotFound],
      [{ code: '42501', hint: 'rename_not_permitted' }, GROUPING_ERROR_WORDS.renameNotPermitted],
    ];
    for (const [error, words] of cases) {
      const { svc } = harness([{ data: null, error }]);
      await expect(svc.applyGrouping(groupBody(), 'web')).rejects.toMatchObject({ message: words });
    }
  });

  it('refuses another organization, another account and a malformed body before any call', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const { svc, rpcCalls } = harness([]);
    await expect(
      svc.applyGrouping(groupBody({ organizationId: OTHER }), 'web'),
    ).rejects.toMatchObject({
      details: { reason: 'workspace_changed' },
    });
    await expect(svc.applyGrouping(groupBody({ actorUserId: OTHER }), 'web')).rejects.toMatchObject(
      {
        details: { reason: 'actor_mismatch' },
      },
    );
    await expect(svc.applyGrouping(groupBody({ itemIds: [A, A] }), 'web')).rejects.toMatchObject({
      code: 'validation_error',
      details: { field: 'item_ids' },
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it('an internal error keeps its text server-side', async () => {
    const { svc } = harness([{ data: null, error: { code: 'XX000', message: 'boom at line 3' } }]);
    await expect(svc.applyGrouping(groupBody(), 'web')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('the service never fans an edit out', () => {
  it('does not import InventoryService (whose update() re-keys every record of a SKU)', () => {
    const src = readFileSync(path.join(__dirname, 'item-grouping.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/inventory'/);
    expect(src).not.toMatch(/import\([^)]*'\.\/inventory'\)/);
    expect(src).not.toMatch(/new InventoryService|InventoryService\.forCurrentUser/);
  });
});
