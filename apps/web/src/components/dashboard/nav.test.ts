import { describe, expect, it } from 'vitest';

import { DASHBOARD_NAV_HREFS, NAV } from './nav';

describe('dashboard navigation route warming', () => {
  it('includes each declared dashboard tab href once in display order', () => {
    const declaredHrefs = NAV.flatMap((section) => section.items.map((item) => item.href));

    expect(DASHBOARD_NAV_HREFS).toEqual(declaredHrefs);
    expect(new Set(DASHBOARD_NAV_HREFS).size).toBe(DASHBOARD_NAV_HREFS.length);
  });
});
