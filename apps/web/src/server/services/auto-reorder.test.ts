import { describe, expect, it } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import {
  AUTO_REORDER_DEFAULTS,
  parseAutoReorderSettings,
  planAutoReorder,
  readAutoReorderSettings,
  shouldAutoSend,
  type AutoReorderCandidate,
} from './auto-reorder';

const c = (
  itemId: string,
  supplierId: string | null,
  quantityOrdered = 10,
  unitCost = 2,
): AutoReorderCandidate => ({ itemId, supplierId, quantityOrdered, unitCost });

/**
 * The automatic reordering panel is seeded from this read and saves the whole
 * setting, so the page has to tell a failed read (show no form) from no row
 * (never configured: the defaults).
 */
describe('readAutoReorderSettings', () => {
  const read = (result: { data: unknown; error: { message: string; code?: string } | null }) =>
    readAutoReorderSettings(
      makeSupabaseStub({ 'organization_modules.select': result }).client,
      'org-1',
    );

  it('says the read failed, with its code, and still hands back the defaults', async () => {
    await expect(
      read({ data: null, error: { message: 'connection reset', code: '08006' } }),
    ).resolves.toEqual({ settings: AUTO_REORDER_DEFAULTS, readError: { code: '08006' } });
  });

  it('says the read failed when the query throws', async () => {
    const db = {
      from: () => {
        throw new Error('connection reset');
      },
    };
    await expect(readAutoReorderSettings(db, 'org-1')).resolves.toEqual({
      settings: AUTO_REORDER_DEFAULTS,
      readError: { code: 'unknown' },
    });
  });

  it('treats no row as never configured: the defaults and no read error', async () => {
    await expect(read({ data: null, error: null })).resolves.toEqual({
      settings: AUTO_REORDER_DEFAULTS,
      readError: null,
    });
  });

  it('hands back a stored row’s values and no read error', async () => {
    await expect(
      read({
        data: {
          settings: { autoReorder: { enabled: true, mode: 'send', maxAutoSendCents: 50000 } },
        },
        error: null,
      }),
    ).resolves.toEqual({
      settings: { enabled: true, mode: 'send', maxAutoSendCents: 50000 },
      readError: null,
    });
  });
});

describe('parseAutoReorderSettings — fail closed', () => {
  it('defaults to disabled/draft/no-cap on garbage', () => {
    expect(parseAutoReorderSettings(undefined)).toEqual(AUTO_REORDER_DEFAULTS);
    expect(parseAutoReorderSettings(null)).toEqual(AUTO_REORDER_DEFAULTS);
    expect(parseAutoReorderSettings({ enabled: 'yes', mode: 'x', maxAutoSendCents: -5 })).toEqual(
      AUTO_REORDER_DEFAULTS,
    );
  });

  it('parses valid settings', () => {
    expect(
      parseAutoReorderSettings({ enabled: true, mode: 'send', maxAutoSendCents: 200000 }),
    ).toEqual({ enabled: true, mode: 'send', maxAutoSendCents: 200000 });
  });

  it('only enabled===true counts as enabled', () => {
    expect(parseAutoReorderSettings({ enabled: 1 }).enabled).toBe(false);
  });
});

describe('planAutoReorder — dedup + grouping', () => {
  it('skips items already on an open PO (the no-double-order guarantee)', () => {
    const plan = planAutoReorder([c('a', 's1'), c('b', 's1')], new Set(['a']));
    expect(plan.skippedDuplicate).toBe(1);
    expect(plan.bySupplier).toHaveLength(1);
    expect(plan.bySupplier[0]?.lines.map((l) => l.itemId)).toEqual(['b']);
  });

  it('skips items with no supplier (nothing to auto-send to)', () => {
    const plan = planAutoReorder([c('a', null), c('b', 's1')], new Set());
    expect(plan.skippedNoSupplier).toBe(1);
    expect(plan.bySupplier).toHaveLength(1);
    expect(plan.bySupplier[0]?.supplierId).toBe('s1');
  });

  it('groups multiple items per supplier and totals correctly', () => {
    const plan = planAutoReorder(
      [c('a', 's1', 10, 2), c('b', 's1', 5, 4), c('d', 's2', 1, 100)],
      new Set(),
    );
    const s1 = plan.bySupplier.find((g) => g.supplierId === 's1');
    const s2 = plan.bySupplier.find((g) => g.supplierId === 's2');
    expect(s1?.lines).toHaveLength(2);
    expect(s1?.total).toBe(10 * 2 + 5 * 4); // 40
    expect(s2?.total).toBe(100);
  });

  it('empty when every candidate is a duplicate', () => {
    const plan = planAutoReorder([c('a', 's1'), c('b', 's2')], new Set(['a', 'b']));
    expect(plan.bySupplier).toHaveLength(0);
    expect(plan.skippedDuplicate).toBe(2);
  });
});

describe('shouldAutoSend — never auto-send unbounded', () => {
  it('HOLDS when neither cap nor threshold is set (no ceiling)', () => {
    expect(shouldAutoSend(999999, null, null)).toBe(false);
  });

  it('sends under the cap, holds at/over it', () => {
    expect(shouldAutoSend(100, 200, null)).toBe(true);
    expect(shouldAutoSend(250, 200, null)).toBe(false);
  });

  it('holds at/over the approval threshold (>=)', () => {
    expect(shouldAutoSend(199, null, 200)).toBe(true);
    expect(shouldAutoSend(200, null, 200)).toBe(false);
    expect(shouldAutoSend(201, null, 200)).toBe(false);
  });

  it('respects BOTH ceilings when both are set', () => {
    expect(shouldAutoSend(150, 300, 200)).toBe(true); // under both
    expect(shouldAutoSend(250, 300, 200)).toBe(false); // over threshold
    expect(shouldAutoSend(350, 300, 200)).toBe(false); // over cap
  });
});
