import { describe, expect, it } from 'vitest';

import {
  ALL_NON_CANCELLED_STATUSES,
  isPoTab,
  OVERDUE_PO_ATTENTION_DETAIL,
  OVERDUE_PO_STATUSES,
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
      // 'all' spans the partition and 'overdue' is a view across it.
      if (tab === 'all' || tab === 'overdue') continue;
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

describe('the Overdue view (small fixes slice 8)', () => {
  it('is a tab the dashboard\'s ?status=overdue link selects, labelled Overdue, right after All', () => {
    expect(isPoTab('overdue')).toBe(true);
    expect(TAB_LABELS.overdue).toBe('Overdue');
    expect(TAB_ORDER.indexOf('overdue')).toBe(TAB_ORDER.indexOf('all') + 1);
  });

  it('spans the open statuses a purchase order can be overdue in, and no others', () => {
    expect(new Set(statusesForTab('overdue'))).toEqual(
      new Set(['ordered', 'expected_inbound', 'partially_received']),
    );
    expect(statusesForTab('overdue')).toEqual([...OVERDUE_PO_STATUSES]);
    for (const status of ['draft', 'received', 'cancelled']) {
      expect(statusesForTab('overdue')).not.toContain(status);
    }
  });

  it('a copy: a caller changing it cannot change the list', () => {
    statusesForTab('overdue').push('draft');
    expect(OVERDUE_PO_STATUSES).not.toContain('draft');
  });
});

// The dashboard's overdue line said "Chase your suppliers or update the
// ETA.", but an ordered purchase order's expected date cannot be changed:
// update() edits drafts only, and the only other writer of expected_at is a
// PO import creating a new one (slice 8 review).
describe("the dashboard's overdue line", () => {
  it('gives only advice someone can follow', () => {
    expect(OVERDUE_PO_ATTENTION_DETAIL).toBe('Expected receipt date has passed. Chase your suppliers.');
    expect(OVERDUE_PO_ATTENTION_DETAIL).not.toMatch(/ETA|update/i);
  });
});
