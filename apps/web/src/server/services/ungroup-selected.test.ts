// Ungroup anything (owner 2026-10-12): one Save for any ticked records, run
// as remove, then split, then unlink, over the existing writes. The gate runs
// first; nothing is written when the body, the account, the family
// permission or a family record's check refuses; a step runs only when every
// step before it applied, and the answer names what applied, what was
// refused, what applied in part and what was not tried.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, UNGROUP_COPY, type Permission } from '@stockpilot/core';

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  assertPermission: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./context', () => {
  class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return {
    ServiceError,
    assertPermission: h.assertPermission,
    isModuleEnabled: (ctx: { enabledModules: Set<string> }, m: string) => ctx.enabledModules.has(m),
  };
});
vi.mock('./item-grouping', () => ({
  assertGroupingPermission: h.gate,
  ItemGroupingService: class {},
}));
vi.mock('./product-group-linking', () => ({ unlinkItems: vi.fn() }));

import { ServiceError } from './context';
import { UngroupSelectedService } from './ungroup-selected';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const K1 = '33333333-3333-4333-8333-333333333333';
const K2 = '44444444-4444-4444-8444-444444444444';
const G = '99999999-9999-4999-8999-999999999999';
const FAM = '77777777-7777-4777-8777-777777777777';
const FAM2 = '66666666-6666-4666-8666-666666666666';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

/** Family reads answer in turn (the pre-check, then a read-back). */
function harness(
  opts: {
    families?: Array<Array<{ id: string; group_id: string | null }> | 'error'>;
    permissions?: Permission[];
    modules?: string[];
  } = {},
) {
  const families = [...(opts.families ?? [])];
  const calls: string[] = [];
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'is']) q[op] = () => q;
      (q as { then: unknown }).then = (res: (v: unknown) => unknown) => {
        calls.push(`read:${table}`);
        const next = families.shift();
        return res(
          next === 'error'
            ? { data: null, error: { message: 'boom' } }
            : { data: next ?? [], error: null },
        );
      };
      return q;
    },
  };
  const ctx = {
    organizationId: ORG,
    userId: ME,
    role: 'manager',
    permissions: new Set<Permission>(opts.permissions ?? ['items:update', 'sports:manage']),
    supabase,
    enabledModules: new Set(opts.modules ?? ['inventory', 'sports']),
    mfaRequired: false,
    mfaSatisfied: true,
  } as never;
  const grouping = {
    previewGroup: vi.fn(),
    previewSplit: vi.fn(),
    applyGrouping: vi.fn(async (body: { itemIds: string[] }) => {
      calls.push('remove');
      return {
        organizationId: ORG,
        outcome: {
          action: 'remove',
          outcome: 'applied',
          replay: false,
          created: false,
          group: null,
          changes: body.itemIds.map((itemId) => ({ itemId, fromGroupId: G, toGroupId: null })),
        },
      };
    }),
    splitSku: vi.fn(async (body: { itemIds: string[]; anchorItemIds: string[] }) => {
      calls.push('split');
      return {
        organizationId: ORG,
        replay: false,
        items: body.itemIds.map((i) => ({
          id: i,
          beforeSku: 'PAIR',
          afterSku: body.anchorItemIds.includes(i) ? 'PAIR' : 'SP-ABCDE-1234567',
          kept: body.anchorItemIds.includes(i),
          anchorItemId: body.anchorItemIds[0] ?? null,
        })),
      };
    }),
  };
  const unlink = vi.fn(async (_deps: unknown, input: { itemIds: string[] }) => {
    calls.push('unlink');
    return { unlinked: input.itemIds.length };
  });
  const svc = new UngroupSelectedService(ctx, {
    grouping: grouping as never,
    unlink: unlink as never,
  });
  return { svc, grouping, unlink, calls };
}

const body = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  actorUserId: ME,
  remove: { idempotencyKey: K1, itemIds: [id(1)], expectedGroups: { [id(1)]: G } },
  split: {
    idempotencyKey: K2,
    itemIds: [id(2), id(3)],
    expectedSkus: { [id(2)]: 'PAIR', [id(3)]: 'PAIR' },
    anchorItemIds: [id(2)],
  },
  unlink: {
    itemIds: [id(4), id(5)],
    expectedFamilies: { [id(4)]: FAM, [id(5)]: FAM },
  },
  ...over,
});
const inFam = [
  { id: id(4), group_id: FAM },
  { id: id(5), group_id: FAM },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.assertPermission.mockImplementation((ctx: { permissions: Set<string> }, p: string) => {
    if (!ctx.permissions.has(p)) throw new ServiceError('forbidden', `Missing permission: ${p}`);
  });
});

describe('UngroupSelectedService.apply', () => {
  it('runs remove, then split, then unlink, and counts only the records that changed', async () => {
    const { svc, calls, grouping, unlink } = harness({ families: [inFam] });
    const r = await svc.apply(body(), 'web');
    expect(calls).toEqual(['read:inventory_items', 'remove', 'split', 'unlink']);
    expect(grouping.applyGrouping).toHaveBeenCalledWith(
      {
        action: 'remove',
        idempotencyKey: K1,
        organizationId: ORG,
        actorUserId: ME,
        itemIds: [id(1)],
        expectedGroups: { [id(1)]: G },
      },
      'web',
    );
    expect(grouping.splitSku.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: K2,
      anchorItemIds: [id(2)],
    });
    // Re-pinned 2026-10-12 (G2 security review LOW): the family each record
    // was reviewed in goes with it, and the write is filtered on it.
    expect(unlink.mock.calls[0]![1]).toEqual({
      itemIds: [id(4), id(5)],
      reason: UNGROUP_COPY.unlinkReason('web'),
      source: 'ungroup',
      surface: 'web',
      expectedFamilies: { [id(4)]: FAM, [id(5)]: FAM },
    });
    expect(r.outcome.complete).toBe(true);
    expect(r.outcome.parts.map((p) => [p.kind, p.status, p.changedItemIds])).toEqual([
      ['remove', 'applied', [id(1)]],
      // The anchor keeps the SKU: it did not change.
      ['split', 'applied', [id(3)]],
      ['unlink', 'applied', [id(4), id(5)]],
    ]);
  });

  it('a refusal part-way stops the run and says what applied, what was refused and what was not tried', async () => {
    const { svc, grouping, unlink, calls } = harness({ families: [inFam] });
    grouping.splitSku.mockRejectedValueOnce(
      new ServiceError('conflict', GROUPING_ERROR_WORDS.itemChanged, { reason: 'item_changed' }),
    );
    const r = await svc.apply(body(), 'app');
    expect(calls).toEqual(['read:inventory_items', 'remove']);
    expect(unlink).not.toHaveBeenCalled();
    expect(r.outcome.complete).toBe(false);
    expect(r.outcome.parts).toEqual([
      expect.objectContaining({ kind: 'remove', status: 'applied', changedItemIds: [id(1)] }),
      expect.objectContaining({
        kind: 'split',
        status: 'refused',
        changedItemIds: [],
        notChangedItemIds: [id(2), id(3)],
        message: GROUPING_ERROR_WORDS.itemChanged,
        reason: 'item_changed',
      }),
      expect.objectContaining({
        kind: 'unlink',
        status: 'not_attempted',
        notChangedItemIds: [id(4), id(5)],
      }),
    ]);
  });

  it('an unlink that stops part-way is read back: the records that left are named, the rest are not', async () => {
    const { svc, unlink } = harness({
      families: [
        inFam,
        [
          { id: id(4), group_id: null },
          { id: id(5), group_id: FAM },
        ],
      ],
    });
    unlink.mockRejectedValueOnce(
      new ServiceError(
        'forbidden',
        'One of the selected items could not be updated. Nothing further was unlinked.',
      ),
    );
    const r = await svc.apply(body({ remove: null, split: null }), 'web');
    expect(r.outcome.parts).toEqual([
      {
        kind: 'unlink',
        status: 'partial',
        changedItemIds: [id(4)],
        notChangedItemIds: [id(5)],
        // core's words, never the linking screen's own sentence
        message: GROUPING_ERROR_WORDS.notWritable,
        reason: 'forbidden',
        retryable: false,
      },
    ]);
    expect(r.outcome.complete).toBe(false);
  });

  // G2 security review LOW (2026-10-12): a record moved into another family
  // between the check and the write is refused at the write, in Ungroup's
  // words, and the read-back names the records that did leave.
  it('a record moved to another family at the write is refused in Ungroup words; the ones that left are named', async () => {
    const { svc, unlink } = harness({
      families: [
        inFam,
        [
          { id: id(4), group_id: null },
          { id: id(5), group_id: FAM2 },
        ],
      ],
    });
    unlink.mockRejectedValueOnce(
      new ServiceError('conflict', 'One of the selected items moved to another family.', {
        reason: 'family_changed',
        itemIds: [id(5)],
      }),
    );
    const r = await svc.apply(body({ remove: null, split: null }), 'web');
    expect(r.outcome.parts).toEqual([
      {
        kind: 'unlink',
        status: 'partial',
        changedItemIds: [id(4)],
        notChangedItemIds: [id(5)],
        message: UNGROUP_COPY.familyChanged,
        reason: 'family_changed',
        retryable: false,
      },
    ]);
  });

  it('says so when where each record is cannot be read back after an unlink stopped', async () => {
    const { svc, unlink } = harness({ families: [inFam, 'error'] });
    unlink.mockRejectedValueOnce(new Error('network'));
    const r = await svc.apply(body({ remove: null, split: null }), 'web');
    expect(r.outcome.parts[0]).toMatchObject({
      status: 'refused',
      notChangedItemIds: [id(4), id(5)],
      message: UNGROUP_COPY.unlinkUnknown,
    });
  });

  it('a busy split is refused as retryable, and the same body sent again replays the steps that applied', async () => {
    const { svc, grouping } = harness({ families: [inFam, inFam] });
    grouping.splitSku.mockRejectedValueOnce(
      new ServiceError('conflict', GROUPING_ERROR_WORDS.busy, { reason: 'busy', retryable: true }),
    );
    const first = await svc.apply(body(), 'web');
    expect(first.outcome.parts[1]).toMatchObject({ status: 'refused', retryable: true });
    const again = await svc.apply(body(), 'web');
    expect(again.outcome.complete).toBe(true);
    // The keyed steps go out with the SAME keys: the database replays.
    expect(
      grouping.applyGrouping.mock.calls.map(
        (c) => (c[0] as unknown as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual([K1, K1]);
    expect(
      grouping.splitSku.mock.calls.map(
        (c) => (c[0] as unknown as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual([K2, K2]);
  });

  it('a record already out of its family is done; no unlink is sent for it', async () => {
    const { svc, unlink } = harness({
      families: [
        [
          { id: id(4), group_id: null },
          { id: id(5), group_id: null },
        ],
      ],
    });
    const r = await svc.apply(body({ remove: null, split: null }), 'web');
    expect(unlink).not.toHaveBeenCalled();
    expect(r.outcome.parts[0]).toMatchObject({ status: 'applied', changedItemIds: [id(4), id(5)] });
  });

  it('writes nothing when a family record moved to another family or is gone since the review', async () => {
    const moved = harness({
      families: [
        [
          { id: id(4), group_id: FAM2 },
          { id: id(5), group_id: FAM },
        ],
      ],
    });
    await expect(moved.svc.apply(body(), 'web')).rejects.toMatchObject({
      code: 'conflict',
      message: UNGROUP_COPY.familyChanged,
      details: { reason: 'family_changed', itemIds: [id(4)] },
    });
    expect(moved.calls).toEqual(['read:inventory_items']);
    const gone = harness({ families: [[{ id: id(4), group_id: FAM }]] });
    await expect(gone.svc.apply(body(), 'web')).rejects.toMatchObject({
      code: 'not_found',
      details: { reason: 'item_not_found', itemIds: [id(5)] },
    });
    expect(gone.calls).toEqual(['read:inventory_items']);
  });

  it('a family step without permission to manage sports products, or with the sports module off, writes nothing', async () => {
    const noPerm = harness({ families: [inFam], permissions: ['items:update'] });
    await expect(noPerm.svc.apply(body(), 'web')).rejects.toMatchObject({
      code: 'forbidden',
      message: UNGROUP_COPY.familyPermission,
      details: { reason: 'family_permission' },
    });
    expect(noPerm.calls).toEqual([]);
    const noModule = harness({ families: [inFam], modules: ['inventory'] });
    await expect(noModule.svc.apply(body(), 'web')).rejects.toMatchObject({
      details: { reason: 'family_permission' },
    });
    expect(noModule.calls).toEqual([]);
    // Without a family step, sports:manage is never asked for.
    const plain = harness({ permissions: ['items:update'] });
    const r = await plain.svc.apply(body({ unlink: null }), 'web');
    expect(r.outcome.complete).toBe(true);
  });

  it('an MFA refusal on the family gate passes through unchanged', async () => {
    const { svc } = harness({ families: [inFam] });
    h.assertPermission.mockImplementationOnce(() => {
      throw new ServiceError('forbidden', 'Multi-factor authentication required.', {
        reason: 'aal2_required',
      });
    });
    await expect(svc.apply(body(), 'web')).rejects.toMatchObject({
      details: { reason: 'aal2_required' },
    });
  });

  it('runs the gate first and refuses a bad body, another organization or another account before any read', async () => {
    const { svc, calls } = harness();
    h.gate.mockImplementationOnce(() => {
      throw new ServiceError('forbidden', GROUPING_ERROR_WORDS.permission, {
        reason: 'permission',
      });
    });
    await expect(svc.apply(body(), 'web')).rejects.toMatchObject({
      details: { reason: 'permission' },
    });
    await expect(svc.apply({ ...body(), extra: true }, 'web')).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      svc.apply(body({ organizationId: '55555555-5555-4555-8555-555555555555' }), 'web'),
    ).rejects.toMatchObject({ details: { reason: 'workspace_changed' } });
    await expect(
      svc.apply(body({ actorUserId: '55555555-5555-4555-8555-555555555555' }), 'web'),
    ).rejects.toMatchObject({ details: { reason: 'actor_mismatch' } });
    expect(calls).toEqual([]);
  });

  // Re-pinned 2026-10-12 (G2 security review LOW): a keyed step that fails
  // with no words of its own may have committed (a lost or unreadable
  // answer), so it is "not confirmed" and retryable with the same keys,
  // never "Not done" with no Try again. Never the raw error either way.
  it('a keyed step that fails with no words of its own is not confirmed and retryable, never the raw error', async () => {
    const { svc, grouping, unlink } = harness({ families: [inFam] });
    grouping.applyGrouping.mockRejectedValueOnce(new Error('connection reset by peer'));
    const r = await svc.apply(body(), 'web');
    expect(r.outcome.parts[0]).toEqual({
      kind: 'remove',
      status: 'refused',
      changedItemIds: [],
      notChangedItemIds: [id(1)],
      message: UNGROUP_COPY.stepUnknown,
      reason: 'unknown',
      retryable: true,
    });
    expect(r.outcome.parts.slice(1).map((p) => p.status)).toEqual([
      'not_attempted',
      'not_attempted',
    ]);
    expect(unlink).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('connection reset');
  });

  it('a split whose answer was lost after it committed: Try again with the same body replays it and finishes', async () => {
    const { svc, grouping } = harness({ families: [inFam, inFam] });
    grouping.splitSku.mockRejectedValueOnce(
      new ServiceError('internal_error', 'split_item_sku: unreadable answer'),
    );
    const first = await svc.apply(body(), 'app');
    expect(first.outcome.parts[1]).toMatchObject({
      kind: 'split',
      status: 'refused',
      notChangedItemIds: [id(2), id(3)],
      message: UNGROUP_COPY.stepUnknown,
      reason: 'unknown',
      retryable: true,
    });
    expect(JSON.stringify(first)).not.toContain('unreadable answer');
    const again = await svc.apply(body(), 'app');
    expect(again.outcome.complete).toBe(true);
    expect(
      grouping.splitSku.mock.calls.map(
        (c) => (c[0] as unknown as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual([K2, K2]);
  });

  // G2 correctness review INFO (2026-10-12): a no-op remove wrote nothing
  // because every record was already out of any group; it never says they
  // left their group.
  it('a remove that finds every record already out of any group counts none as changed', async () => {
    const { svc, grouping } = harness({ families: [inFam] });
    grouping.applyGrouping.mockResolvedValueOnce({
      organizationId: ORG,
      outcome: {
        action: 'remove',
        outcome: 'noop',
        replay: false,
        created: false,
        group: null,
        changes: [],
      },
    } as never);
    const r = await svc.apply(body({ split: null, unlink: null }), 'web');
    expect(r.outcome).toEqual({
      complete: true,
      parts: [
        {
          kind: 'remove',
          status: 'applied',
          changedItemIds: [],
          notChangedItemIds: [id(1)],
          message: null,
          reason: null,
          retryable: false,
        },
      ],
    });
  });
});

describe('UngroupSelectedService.preview', () => {
  it('reads both reviews after the gate, and says whether the caller may unlink families', async () => {
    const { svc, grouping } = harness({ permissions: ['items:update'] });
    grouping.previewGroup.mockResolvedValueOnce({ records: [], previewKey: 'k' });
    grouping.previewSplit.mockResolvedValueOnce({ candidates: [{ id: id(1) }] });
    const r = await svc.preview([id(1)]);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(grouping.previewGroup).toHaveBeenCalledWith([id(1)], null);
    expect(grouping.previewSplit).toHaveBeenCalledWith([id(1)]);
    expect(r).toEqual({
      review: { records: [], previewKey: 'k' },
      candidates: [{ id: id(1) }],
      canUnlinkFamilies: false,
      previewKey: 'k',
    });
    const sports = harness();
    sports.grouping.previewGroup.mockResolvedValueOnce({ records: [], previewKey: 'k' });
    sports.grouping.previewSplit.mockResolvedValueOnce({ candidates: [] });
    expect((await sports.svc.preview([id(1)])).canUnlinkFamilies).toBe(true);
  });

  it("refuses more than 100 records in Ungroup's own words, and a bad id, before any read", async () => {
    const { svc, grouping } = harness();
    const many = Array.from({ length: 101 }, (_, i) => id(i));
    await expect(svc.preview(many)).rejects.toMatchObject({
      code: 'validation_error',
      message: GROUPING_ERROR_WORDS.tooMany,
    });
    await expect(svc.preview(['nope'])).rejects.toMatchObject({ code: 'validation_error' });
    expect(grouping.previewGroup).not.toHaveBeenCalled();
  });
});
