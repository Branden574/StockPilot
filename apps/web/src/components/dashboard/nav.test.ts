import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_IDS, MODULE_REGISTRY } from '@stockpilot/core';

import { NAV_ICONS } from './icons';
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

  it('NAV_ICONS covers every web_sidebar placement icon (no silent Boxes fallback)', () => {
    const used = new Set<string>();
    for (const def of Object.values(MODULE_REGISTRY))
      for (const p of def.placements)
        if (p.surface === 'web_sidebar') used.add(p.iconName);
    for (const name of used) expect(NAV_ICONS[name]).toBeDefined();
  });
});
