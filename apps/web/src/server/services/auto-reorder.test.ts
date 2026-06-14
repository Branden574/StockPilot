import { describe, expect, it } from 'vitest';

import {
  AUTO_REORDER_DEFAULTS,
  parseAutoReorderSettings,
  planAutoReorder,
  type AutoReorderCandidate,
} from './auto-reorder';

const c = (
  itemId: string,
  supplierId: string | null,
  quantityOrdered = 10,
  unitCost = 2,
): AutoReorderCandidate => ({ itemId, supplierId, quantityOrdered, unitCost });

describe('parseAutoReorderSettings — fail closed', () => {
  it('defaults to disabled/draft/no-cap on garbage', () => {
    expect(parseAutoReorderSettings(undefined)).toEqual(AUTO_REORDER_DEFAULTS);
    expect(parseAutoReorderSettings(null)).toEqual(AUTO_REORDER_DEFAULTS);
    expect(parseAutoReorderSettings({ enabled: 'yes', mode: 'x', maxAutoSendCents: -5 })).toEqual(
      AUTO_REORDER_DEFAULTS,
    );
  });

  it('parses valid settings', () => {
    expect(parseAutoReorderSettings({ enabled: true, mode: 'send', maxAutoSendCents: 200000 })).toEqual(
      { enabled: true, mode: 'send', maxAutoSendCents: 200000 },
    );
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
