import { describe, expect, it } from 'vitest';

import {
  ALL_NON_CANCELLED_STATUSES,
  isPoTab,
  statusesForTab,
  TAB_LABELS,
  TAB_ORDER,
  TAB_STATUSES,
  type PoTab,
} from './tabs';

/** Every status the purchase_orders check constraint allows (0002 + the
 *  0011 'expected_inbound' addition). */
const ALL_DB_STATUSES = ['draft', 'expected_inbound', 'ordered', 'partially_received', 'received', 'cancelled'];

describe('purchase-orders tab partition', () => {
  it('every non-"all" tab status is unique across tabs (mutually exclusive partition)', () => {
    const seen = new Map<string, PoTab[]>();
    for (const tab of TAB_ORDER) {
      if (tab === 'all') continue;
      for (const status of TAB_STATUSES[tab]) {
        const tabs = seen.get(status) ?? [];
        tabs.push(tab);
        seen.set(status, tabs);
      }
    }
    for (const [status, tabs] of seen) {
      expect(tabs, `status "${status}" should appear in exactly one tab`).toHaveLength(1);
    }
    expect(new Set(seen.keys())).toEqual(new Set(ALL_DB_STATUSES));
  });

  it('TAB_LABELS covers every TAB_ORDER entry', () => {
    for (const tab of TAB_ORDER) {
      expect(TAB_LABELS[tab]).toBeTruthy();
    }
  });

  it('isPoTab type guard accepts only real tabs', () => {
    expect(isPoTab('all')).toBe(true);
    expect(isPoTab('cancelled')).toBe(true);
    expect(isPoTab('bogus')).toBe(false);
    expect(isPoTab(undefined)).toBe(false);
  });

  describe('statusesForTab — "All" excludes cancelled (owner request 2026-07-16)', () => {
    it('"all" resolves to every non-cancelled status — never cancelled, never every status', () => {
      const statuses = statusesForTab('all');
      expect(statuses).not.toContain('cancelled');
      expect(new Set(statuses)).toEqual(
        new Set(['draft', 'expected_inbound', 'ordered', 'partially_received', 'received']),
      );
      expect(statuses).toHaveLength(5);
    });

    it('ALL_NON_CANCELLED_STATUSES matches statusesForTab("all") and is derived from TAB_STATUSES', () => {
      expect(ALL_NON_CANCELLED_STATUSES).toEqual(statusesForTab('all'));
    });

    it('the "cancelled" tab still resolves to [\'cancelled\'] — reachable via its own tab', () => {
      expect(statusesForTab('cancelled')).toEqual(['cancelled']);
    });

    it('every other tab is an unaffected pass-through of TAB_STATUSES', () => {
      expect(statusesForTab('draft')).toEqual(['draft']);
      expect(statusesForTab('ordered')).toEqual(['ordered']);
      expect(statusesForTab('in_transit')).toEqual(['expected_inbound', 'partially_received']);
      expect(statusesForTab('received')).toEqual(['received']);
    });
  });
});
