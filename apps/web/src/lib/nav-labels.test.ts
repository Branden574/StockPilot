import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable org-row state so per-test override shapes work without re-mocking.
const orgState: { navOverrides: unknown } = { navOverrides: null };

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));

vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ nav_overrides: orgState.navOverrides })),
}));

import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';

import { effectiveNavLabel, navLabelFromOverrides } from './nav-labels';

describe('navLabelFromOverrides', () => {
  it('returns the override label when present', () => {
    const overrides = { v: 1, labels: { '/dashboard/inventory': 'Ingredients' } };
    expect(navLabelFromOverrides(overrides, '/dashboard/inventory', 'Inventory')).toBe(
      'Ingredients',
    );
  });

  it('returns the fallback when no override exists for the href', () => {
    const overrides = { v: 1, labels: { '/dashboard/books': 'Library' } };
    expect(navLabelFromOverrides(overrides, '/dashboard/inventory', 'Inventory')).toBe(
      'Inventory',
    );
  });

  it('fails CLOSED to the fallback on null / malformed overrides', () => {
    for (const bad of [
      null,
      undefined,
      'nope',
      42,
      [],
      {},
      { not: 'valid' },
      { v: 2, labels: { '/dashboard/inventory': 'Ingredients' } }, // wrong version
      { v: 1 }, // no labels
      { v: 1, labels: null },
      { v: 1, labels: 'nope' },
    ]) {
      expect(navLabelFromOverrides(bad, '/dashboard/inventory', 'Inventory')).toBe('Inventory');
    }
  });

  it('ignores empty-string / non-string labels (same gate as applyNavOverrides)', () => {
    expect(
      navLabelFromOverrides(
        { v: 1, labels: { '/dashboard/inventory': '' } },
        '/dashboard/inventory',
        'Inventory',
      ),
    ).toBe('Inventory');
    expect(
      navLabelFromOverrides(
        { v: 1, labels: { '/dashboard/inventory': 7 } },
        '/dashboard/inventory',
        'Inventory',
      ),
    ).toBe('Inventory');
  });
});

describe('effectiveNavLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.navOverrides = null;
  });

  it('reads the rename through the request-cached org row', async () => {
    orgState.navOverrides = { v: 1, labels: { '/dashboard/inventory': 'Ingredients' } };
    await expect(effectiveNavLabel('/dashboard/inventory', 'Inventory')).resolves.toBe(
      'Ingredients',
    );
    // The lookup goes through the SAME request-cached fetch the layout uses —
    // no separate query path to keep in sync.
    expect(getOrgRowForRequest).toHaveBeenCalledWith('org-1');
  });

  it('returns the fallback when the org has no overrides', async () => {
    await expect(effectiveNavLabel('/dashboard/inventory', 'Inventory')).resolves.toBe(
      'Inventory',
    );
  });

  it('returns the fallback when the org row is missing', async () => {
    vi.mocked(getOrgRowForRequest).mockResolvedValueOnce(null);
    await expect(effectiveNavLabel('/dashboard/books', 'Books')).resolves.toBe('Books');
  });
});
