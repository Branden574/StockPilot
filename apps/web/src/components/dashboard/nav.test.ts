import { describe, expect, it } from 'vitest';

import { DASHBOARD_NAV_HREFS, navForRole } from './nav';

describe('dashboard navigation route warming', () => {
  it('warms every href reachable for an admin (the superset)', () => {
    const adminHrefs = navForRole('admin').flatMap((section) =>
      section.items.map((item) => item.href),
    );

    expect(DASHBOARD_NAV_HREFS).toEqual(adminHrefs);
    expect(new Set(DASHBOARD_NAV_HREFS).size).toBe(DASHBOARD_NAV_HREFS.length);
  });

  it('omits admin section for non-admin roles', () => {
    const staffHrefs = navForRole('staff').flatMap((s) => s.items.map((i) => i.href));
    expect(staffHrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });
});
