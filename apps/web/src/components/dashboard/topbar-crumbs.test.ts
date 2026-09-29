import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

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

  it('a location page (F1-3) sits under Locations, which links back to the list', () => {
    const crumbs = crumbsForPathname('/dashboard/locations/0a000000-0000-0000-0000-0000000000b1');
    expect(crumbs.map((c) => c.label)).toEqual(['Inventory', 'Locations', 'Detail']);
    expect(crumbs[1]!.href).toBe('/dashboard/locations');
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
      '/dashboard/audit',
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

/**
 * A page at a FIXED path is never shown as some record's "Detail". The walk
 * after F2-3 found the Staging page (the Put away links' destination) under
 * "Inventory / Items / Detail": the item-detail pattern /inventory/[^/]+$
 * took "staging" for an item id. Labels and Recurring purchase orders had the
 * same fault. This walks the dashboard's route folders, so a new fixed page
 * that lands on a catch-all fails here until it has its own crumb.
 */
describe('fixed pages have their own crumb, never a catch-all Detail', () => {
  const ROOT = path.resolve(__dirname, '../../app/(dashboard)/dashboard');
  const fixedPages: string[] = [];
  const walk = (dir: string, url: string, dynamic: boolean) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (!statSync(abs).isDirectory()) continue;
      if (name.startsWith('(')) {
        walk(abs, url, dynamic);
        continue;
      }
      const isDynamic = name.startsWith('[');
      const next = `${url}/${isDynamic ? 'abc-123' : name}`;
      if (!isDynamic && !dynamic && existsSync(path.join(abs, 'page.tsx'))) fixedPages.push(next);
      walk(abs, next, dynamic || isDynamic);
    }
  };
  walk(ROOT, '/dashboard', false);

  it('finds the fixed pages (the sweep is not vacuous)', () => {
    expect(fixedPages).toEqual(
      expect.arrayContaining([
        '/dashboard/inventory/staging',
        '/dashboard/inventory/labels',
        '/dashboard/purchase-orders/recurring',
        '/dashboard/purchase-orders/imports',
      ]),
    );
  });

  it('none of them ends in "Detail"', () => {
    const wrong = fixedPages
      .map((p) => [p, crumbsForPathname(p).map((c) => c.label).join(' / ')] as const)
      .filter(([, trail]) => trail.endsWith('Detail'));
    expect(wrong).toEqual([]);
  });

  it('Staging sits in Inventory under its own name, the sidebar item it is (so an org rename applies)', () => {
    const crumbs = crumbsForPathname('/dashboard/inventory/staging');
    expect(crumbs).toEqual([
      { label: 'Inventory', href: null },
      { label: 'Staging', href: '/dashboard/inventory/staging' },
    ]);
    const renamed = navLabelMap(
      navForRole('admin', ALL, { v: 1, labels: { '/dashboard/inventory/staging': 'Put-away' } }),
    );
    expect(applyNavLabelsToCrumbs(crumbs, renamed).map((c) => c.label)).toEqual(['Inventory', 'Put-away']);
  });

  it('Labels and Recurring sit under their lists', () => {
    expect(crumbsForPathname('/dashboard/inventory/labels').map((c) => c.label)).toEqual([
      'Inventory',
      'Items',
      'Labels',
    ]);
    expect(crumbsForPathname('/dashboard/purchase-orders/recurring').map((c) => c.label)).toEqual([
      'Inventory',
      'Purchase orders',
      'Recurring',
    ]);
  });

  it('an item id is still an item', () => {
    expect(crumbsForPathname('/dashboard/inventory/0a0f2100-0000-4000-8000-000000000201').map((c) => c.label)).toEqual([
      'Inventory',
      'Items',
      'Detail',
    ]);
  });
});
