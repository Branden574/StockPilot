import { describe, expect, it } from 'vitest';

import { poImportStatusSchema } from '@stockpilot/core';

import {
  DEFAULT_TAB,
  isImportTab,
  TAB_LABELS,
  TAB_ORDER,
  TAB_STATUSES,
  type PoImportTab,
} from './tabs';

describe('po-imports tab partition', () => {
  it('every po_imports status lands in exactly one tab', () => {
    const seen = new Map<string, PoImportTab[]>();
    for (const tab of TAB_ORDER) {
      for (const status of TAB_STATUSES[tab]) {
        const tabs = seen.get(status) ?? [];
        tabs.push(tab);
        seen.set(status, tabs);
      }
    }

    for (const status of poImportStatusSchema.options) {
      expect(seen.get(status), `status "${status}" should be in exactly one tab`).toHaveLength(1);
    }
    // No extra/unknown status snuck into a tab, and none is covered twice.
    expect(new Set(seen.keys())).toEqual(new Set(poImportStatusSchema.options));
  });

  it('TAB_ORDER/TAB_LABELS/TAB_STATUSES keys agree', () => {
    expect(TAB_ORDER).toHaveLength(3);
    for (const tab of TAB_ORDER) {
      expect(TAB_LABELS[tab]).toBeTruthy();
      expect(TAB_STATUSES[tab]?.length).toBeGreaterThan(0);
    }
  });

  it('the DB spelling is "canceled" (one L) — never hardcode "cancelled" for imports', () => {
    expect(TAB_STATUSES.cancelled).toEqual(['canceled']);
  });

  it('failed/duplicate stay in Active so they remain retryable, not exiled to their own tab', () => {
    expect(TAB_STATUSES.active).toContain('failed');
    expect(TAB_STATUSES.active).toContain('duplicate');
    expect(TAB_STATUSES.approved).not.toContain('failed');
    expect(TAB_STATUSES.cancelled).not.toContain('failed');
  });

  it('isImportTab type guard accepts only real tabs', () => {
    expect(isImportTab('active')).toBe(true);
    expect(isImportTab('approved')).toBe(true);
    expect(isImportTab('cancelled')).toBe(true);
    expect(isImportTab('bogus')).toBe(false);
    expect(isImportTab(undefined)).toBe(false);
  });

  it('defaults to Active — unmixes cancelled/approved (esp. test junk) from the working set', () => {
    expect(DEFAULT_TAB).toBe('active');
  });
});
