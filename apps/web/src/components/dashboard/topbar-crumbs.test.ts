import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

import { navForRole } from './nav';
import { applyNavLabelsToCrumbs, crumbsForPathname, navLabelMap } from './topbar-crumbs';

const ALL = new Set(DEFAULT_MODULE_IDS);

const RENAME = navLabelMap(
  navForRole('admin', ALL, { v: 1, labels: { '/dashboard/inventory': 'Ingredients' } }),
);

describe('breadcrumb derivation from the (overridden) nav', () => {
  it('crumbsForPathname resolves known paths and falls back to an em-dash', () => {
    expect(crumbsForPathname('/dashboard/inventory').map((c) => c.label)).toEqual([
      'Inventory',
      'Items',
    ]);
    expect(crumbsForPathname('/dashboard/inventory/abc-123/edit').map((c) => c.label)).toEqual([
      'Inventory',
      'Items',
      'Edit',
    ]);
    expect(crumbsForPathname('/dashboard/nope-not-a-route').map((c) => c.label)).toEqual(['—']);
  });

  it('renames the nav-item segment by href; the static sub-page tail stays', () => {
    const crumbs = applyNavLabelsToCrumbs(
      crumbsForPathname('/dashboard/inventory/abc-123/edit'),
      RENAME,
    );
    // Section header ("Inventory", href: null) and the "Edit" tail keep their
    // static labels — only the nav-item segment renames.
    expect(crumbs.map((c) => c.label)).toEqual(['Inventory', 'Ingredients', 'Edit']);
  });

  it('renames the terminal crumb on the list page itself', () => {
    const crumbs = applyNavLabelsToCrumbs(crumbsForPathname('/dashboard/inventory'), RENAME);
    expect(crumbs.map((c) => c.label)).toEqual(['Inventory', 'Ingredients']);
  });

  it('no overrides → every crumb keeps its static label (nav defaults match)', () => {
    const map = navLabelMap(navForRole('admin', ALL));
    for (const path of [
      '/dashboard',
      '/dashboard/inventory',
      '/dashboard/inventory/abc-123',
      '/dashboard/books',
      '/dashboard/movements',
      '/dashboard/orders/xyz/print',
      '/dashboard/purchase-orders/imports',
      '/dashboard/settings/billing',
      '/dashboard/team',
      '/dashboard/admin',
      '/dashboard/admin/audit',
    ]) {
      expect(applyNavLabelsToCrumbs(crumbsForPathname(path), map)).toEqual(
        crumbsForPathname(path),
      );
    }
  });

  it('falls back to the static label when the item is hidden from the nav', () => {
    // Hidden items never reach the label map — the crumb must fail closed to
    // its static label, not disappear or pick up the (unreachable) rename.
    const map = navLabelMap(
      navForRole('admin', ALL, {
        v: 1,
        hidden: ['/dashboard/inventory'],
        labels: { '/dashboard/inventory': 'Ingredients' },
      }),
    );
    const crumbs = applyNavLabelsToCrumbs(crumbsForPathname('/dashboard/inventory'), map);
    expect(crumbs.map((c) => c.label)).toEqual(['Inventory', 'Items']);
  });

  it('fails CLOSED to static labels on garbage overrides (via navForRole)', () => {
    // @ts-expect-error — intentionally malformed override to prove fail-closed.
    const map = navLabelMap(navForRole('admin', ALL, { not: 'valid' }));
    expect(applyNavLabelsToCrumbs(crumbsForPathname('/dashboard/inventory'), map)).toEqual(
      crumbsForPathname('/dashboard/inventory'),
    );
  });

  it('an empty label map leaves crumbs untouched (Topbar without navSections)', () => {
    const crumbs = crumbsForPathname('/dashboard/books/abc/edit');
    expect(applyNavLabelsToCrumbs(crumbs, new Map())).toEqual(crumbs);
  });
});
