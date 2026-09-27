import { describe, expect, it } from 'vitest';

import type { Permission } from '@stockpilot/core';

import { canOpenCountPage } from './count-page-access';

/**
 * The verification words link a count only for a reader the count page lets
 * in: cycle_counts:read, or stock:adjust (the count pages' own gate). Anyone
 * else would be redirected to the dashboard by the link.
 */
describe('canOpenCountPage', () => {
  const withPerms = (...p: Permission[]) => ({ role: 'viewer' as const, permissions: new Set(p) });

  it('cycle_counts:read alone opens a count page', () => {
    expect(canOpenCountPage(withPerms('items:read', 'cycle_counts:read'))).toBe(true);
  });

  it('stock:adjust alone opens a count page (someone who can count)', () => {
    expect(canOpenCountPage(withPerms('items:read', 'stock:adjust'))).toBe(true);
  });

  it('neither: no link', () => {
    expect(canOpenCountPage(withPerms('items:read'))).toBe(false);
  });

  it('follows the effective permissions, not the role default, when they are known', () => {
    // A manager whose org revoked both still gets no link.
    expect(
      canOpenCountPage({ role: 'manager', permissions: new Set<Permission>(['items:read']) }),
    ).toBe(false);
    // Role defaults when the set is not known (a synthetic context).
    expect(canOpenCountPage({ role: 'manager' })).toBe(true);
  });
});
