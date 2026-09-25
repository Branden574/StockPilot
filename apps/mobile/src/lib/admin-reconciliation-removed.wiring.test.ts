import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { drawerSectionsFor } from './drawer-nav';

// drawer-nav maps icon names to lucide components; the icons are irrelevant
// here and the native package does not load under node. (vi.mock is hoisted
// above the imports.)
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * S5-C (owner default D9): the Admin > Reconciliation screen is gone. It
 * queried cycle_counts.status = 'posted' and a posted_at column, neither of
 * which exists, swallowed the error and always showed "No posted counts yet".
 * Posted counts live in Cycle counts (filter Completed), and the admin menu
 * points there instead.
 *
 * The drawer is NOT built in this app: drawer-content.tsx renders
 * drawerSectionsFor(), which resolves the shared @stockpilot/core registry.
 * Checking only the screen files let a registry entry survive the screen, so
 * every admin tapped into expo-router's "Unmatched Route". The last test here
 * resolves every drawer href in the registry against the real app/ tree.
 */
const appRoot = path.join(__dirname, '../../app');
const app = path.join(appRoot, '(drawer)');
const adminIndex = readFileSync(path.join(app, 'admin/index.tsx'), 'utf8');
const drawer = readFileSync(path.join(app, '_layout.tsx'), 'utf8');

/** Every route expo-router serves from app/: groups "(x)" are transparent,
 *  "index" is its folder, "_layout" / "+html" style files are not routes, and
 *  a "[param]" segment matches any one segment. */
function expoRoutes(): RegExp[] {
  const out: RegExp[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, /^\(.*\)$/.test(name) ? segs : [...segs, name]);
        continue;
      }
      if (!/\.tsx?$/.test(name) || /^[_+]/.test(name)) continue;
      const base = name.replace(/\.tsx?$/, '');
      const all = base === 'index' ? segs : [...segs, base];
      const pattern = all
        .map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
      out.push(new RegExp(`^/${pattern}$`));
    }
  };
  walk(appRoot, []);
  return out;
}

const ALL_MODULES = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);

describe('the dead Reconciliation screen is removed', () => {
  it('the screen file no longer exists', () => {
    expect(existsSync(path.join(app, 'admin/reconciliation.tsx'))).toBe(false);
  });

  it('neither the admin menu nor the drawer layout routes to it', () => {
    expect(adminIndex).not.toContain('/admin/reconciliation');
    expect(drawer).not.toContain('admin/reconciliation');
  });

  it('the drawer an owner sees (every module on) has no Reconciliation entry', () => {
    const hrefs = drawerSectionsFor('owner', ALL_MODULES).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/admin/audit'); // the admin section did resolve
    expect(hrefs).not.toContain('/admin/reconciliation');
  });

  it('the admin menu points to the cycle-count history instead, only when counts are on', () => {
    expect(adminIndex).toMatch(/href: '\/cycle-counts', label: 'Count history'/);
    // An org with the Cycle counts module off gets a module-disabled error on
    // that list, so the link is gated on the module like the drawer is.
    expect(adminIndex).toContain('useEnabledModules()');
    expect(adminIndex).toMatch(/module: 'cycle_counts'/);
  });

  it('nothing in the app still reads the columns that never existed', () => {
    for (const file of [adminIndex, drawer]) {
      expect(file).not.toMatch(/posted_at|status', 'posted'/);
    }
  });

  it('every drawer href in the shared registry resolves to a screen under app/', () => {
    const routes = expoRoutes();
    expect(routes.length).toBeGreaterThan(20); // the walk found the tree
    const dead = Object.values(MODULE_REGISTRY)
      .flatMap((m) => m.placements)
      .filter((p) => p.surface === 'mobile_drawer')
      .map((p) => p.href)
      .filter((href) => !routes.some((r) => r.test(href)));
    expect(dead).toEqual([]);
  });
});
