import { describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS, type ModuleId, type Permission, type Role } from '@stockpilot/core';

import {
  INSIGHT_SIGNAL_ACCESS,
  INSIGHT_SIGNAL_KEYS,
  insightsVisibleTo,
  type InsightReader,
} from './insights-access';

/**
 * Docket S36 (part a), with B72 part 3: each line of Today's briefing and the
 * morning briefing notice follows the gate of the page it links to. The
 * approvals line shows only to an approver (orders:approve, never a viewer),
 * the purchase order lines only to a reader with purchase_orders:read, and a
 * line whose page belongs to a module only while that module is on; overrides
 * apply either way.
 */

const ALL_MODULES = new Set<ModuleId>(['orders', 'purchase_orders', 'cycle_counts', 'ai']);

function reader(
  role: Role,
  opts: { add?: Permission[]; remove?: Permission[]; modules?: ModuleId[]; noSet?: boolean } = {},
): InsightReader {
  const permissions = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const key of opts.add ?? []) permissions.add(key);
  for (const key of opts.remove ?? []) permissions.delete(key);
  return {
    role,
    ...(opts.noSet ? {} : { permissions }),
    enabledModules: opts.modules ? new Set<ModuleId>(opts.modules) : ALL_MODULES,
  };
}

const allow = (key: (typeof INSIGHT_SIGNAL_KEYS)[number], r: InsightReader) =>
  INSIGHT_SIGNAL_ACCESS[key](r);

describe('INSIGHT_SIGNAL_ACCESS: one rule per briefing line', () => {
  it('holds exactly the five lines the briefing gathers', () => {
    expect(Object.keys(INSIGHT_SIGNAL_ACCESS).sort()).toEqual([...INSIGHT_SIGNAL_KEYS].sort());
    expect([...INSIGHT_SIGNAL_KEYS].sort()).toEqual([
      'low_stock',
      'open_cycle_counts',
      'open_pos',
      'overdue_pos',
      'pending_approvals',
    ]);
  });

  it('approvals: the Overview approver rule, orders:approve and never a viewer, with Orders on', () => {
    expect(allow('pending_approvals', reader('owner', { noSet: true }))).toBe(true);
    expect(allow('pending_approvals', reader('manager'))).toBe(true);
    expect(allow('pending_approvals', reader('staff', { add: ['orders:approve'] }))).toBe(true);
    // An override wins either way.
    expect(allow('pending_approvals', reader('admin', { remove: ['orders:approve'] }))).toBe(false);
    expect(allow('pending_approvals', reader('staff'))).toBe(false);
    // A viewer granted it can approve nothing: the app refuses a viewer every write.
    expect(allow('pending_approvals', reader('viewer', { add: ['orders:approve'] }))).toBe(false);
    // The Orders module off: the link would open the module-unavailable page.
    expect(
      allow('pending_approvals', reader('owner', { modules: ['ai', 'purchase_orders'] })),
    ).toBe(false);
  });

  it('purchase orders: purchase_orders:read with the module on, for both lines', () => {
    for (const key of ['overdue_pos', 'open_pos'] as const) {
      expect(allow(key, reader('staff'))).toBe(true);
      expect(allow(key, reader('viewer'))).toBe(true);
      expect(allow(key, reader('staff', { remove: ['purchase_orders:read'] }))).toBe(false);
      expect(allow(key, reader('owner', { modules: ['ai', 'orders'] }))).toBe(false);
    }
  });

  it('low stock: items:read (the Items page has no other gate)', () => {
    expect(allow('low_stock', reader('viewer'))).toBe(true);
    expect(allow('low_stock', reader('admin', { remove: ['items:read'] }))).toBe(false);
  });

  it('counts: the count pages gate (cycle_counts:read or stock:adjust) with the module on', () => {
    expect(allow('open_cycle_counts', reader('staff'))).toBe(true);
    // stock:adjust alone opens the count pages, so it opens this line.
    expect(allow('open_cycle_counts', reader('staff', { remove: ['cycle_counts:read'] }))).toBe(
      true,
    );
    expect(
      allow(
        'open_cycle_counts',
        reader('staff', { remove: ['cycle_counts:read', 'stock:adjust'] }),
      ),
    ).toBe(false);
    expect(allow('open_cycle_counts', reader('viewer'))).toBe(false);
    expect(allow('open_cycle_counts', reader('owner', { modules: ['ai', 'orders'] }))).toBe(false);
  });
});

describe('insightsVisibleTo', () => {
  const gathered = {
    signals: [
      { key: 'pending_approvals' as const, label: 'orders awaiting approval', count: 5 },
      { key: 'overdue_pos' as const, label: 'overdue inbound POs', count: 2 },
      { key: 'low_stock' as const, label: 'items at or under their reorder point', count: 1 },
      { key: 'open_cycle_counts' as const, label: 'cycle count in progress', count: 1 },
      { key: 'open_pos' as const, label: 'open purchase orders', count: 3 },
    ],
    lowStock: [{ id: 'i1', name: 'Widget', sku: 'W-1', qty: 1, reorderPoint: 5 }],
  };

  it('keeps every line, in order, for a reader every rule lets in', () => {
    expect(insightsVisibleTo(gathered, reader('owner', { noSet: true }))).toEqual(gathered);
  });

  it('drops each line the reader could not open, and nothing else', () => {
    const staff = insightsVisibleTo(
      gathered,
      reader('staff', { remove: ['purchase_orders:read'] }),
    );
    expect(staff.signals.map((s) => s.key)).toEqual(['low_stock', 'open_cycle_counts']);
    expect(staff.lowStock).toEqual(gathered.lowStock);
  });

  it('keeps the low-stock examples only with the low-stock line', () => {
    const r = reader('manager', { remove: ['items:read'] });
    const out = insightsVisibleTo(gathered, r);
    expect(out.signals.map((s) => s.key)).not.toContain('low_stock');
    expect(out.lowStock).toEqual([]);
  });

  it('drops a line it has no rule for (fails closed)', () => {
    const odd = {
      signals: [{ key: 'something_new', label: 'x', count: 1 }],
      lowStock: [],
    } as unknown as typeof gathered;
    expect(insightsVisibleTo(odd, reader('owner', { noSet: true })).signals).toEqual([]);
  });
});
