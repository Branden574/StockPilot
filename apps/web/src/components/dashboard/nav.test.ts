import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

import { DASHBOARD_NAV_HREFS, navForRole } from './nav';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('dashboard navigation', () => {
  it('admin sees the full href set with all modules enabled (superset, unique)', () => {
    const adminHrefs = navForRole('admin', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(new Set(adminHrefs).size).toBe(adminHrefs.length);
    for (const href of DASHBOARD_NAV_HREFS) expect(adminHrefs).toContain(href);
  });

  it('omits admin section for non-admin roles', () => {
    const staffHrefs = navForRole('staff', ALL).flatMap((s) => s.items.map((i) => i.href));
    expect(staffHrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });

  it('disabling rentals removes it from the sidebar', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const hrefs = navForRole('admin', without).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
  });
});
