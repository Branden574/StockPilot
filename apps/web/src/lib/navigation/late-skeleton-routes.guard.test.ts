import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { routeSkeletonFor, type RouteSkeletonKind } from './route-skeletons';

/**
 * Which dashboard routes rely on the late skeleton (and on the (dashboard)
 * group fallback's route shape), checked against the files on disk.
 *
 * A page with no loading.tsx between it and the (dashboard) group shows
 * nothing of its own while it loads: it gets the late skeleton on a slow soft
 * navigation and the group fallback on a hard load, both shaped by
 * routeSkeletonFor. A page WITH its own loading.tsx must map to null, or a
 * second skeleton would stack on its own. The exception is a section whose
 * async layout sits ABOVE its loading.tsx (the layout must render before that
 * loading.tsx can show): it maps to the same shape as that loading.tsx.
 *
 * Adding or removing a loading.tsx, or a page that relies on the late
 * skeleton, fails here until the lists and the map are updated on purpose.
 */

const GROUP = path.resolve(__dirname, '../../app/(dashboard)');
const DASH = path.join(GROUP, 'dashboard');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FILES = walk(DASH);
const rel = (file: string) => path.relative(DASH, file).split(path.sep).join('/');
const dirOf = (relFile: string) => path.posix.dirname(relFile);

/** The URL of a page directory: route groups dropped, [param] -> x. */
function samplePath(dir: string): string {
  const segments = dir === '.' ? [] : dir.split('/');
  const url = segments
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    .map((s) => (s.startsWith('[') ? 'x' : s));
  return ['/dashboard', ...url].join('/');
}

/** Directories from `dir` up to the dashboard root, nearest first. */
function upward(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    out.push(cur);
    if (cur === '.') return out;
    cur = path.posix.dirname(cur);
  }
}

const has = (dir: string, file: string) => existsSync(path.join(DASH, dir, file));

const LOADINGS = FILES.map(rel).filter((f) => f.endsWith('/loading.tsx') || f === 'loading.tsx').sort();
const PAGES = FILES.map(rel).filter((f) => f.endsWith('/page.tsx') || f === 'page.tsx').sort();

/** The directory of the nearest loading.tsx at or above a page, below the group; null when none. */
function nearestLoading(pageFile: string): string | null {
  return upward(dirOf(pageFile)).find((d) => has(d, 'loading.tsx')) ?? null;
}

/** A layout.tsx at or above a loading.tsx's directory (below the group) sits above that boundary. */
function layoutsAbove(loadingDir: string): string[] {
  return upward(loadingDir).filter((d) => d !== '.' && has(d, 'layout.tsx'));
}

function kindOfLoading(dir: string): RouteSkeletonKind | null {
  const source = readFileSync(path.join(DASH, dir, 'loading.tsx'), 'utf8');
  const table = source.match(/<TablePageSkeleton\s+rows=\{(\d+)\}/);
  if (table) return `table-${table[1]}` as RouteSkeletonKind;
  if (/<PageSkeleton\b/.test(source)) return 'page';
  return null;
}

describe('routes that rely on the late skeleton', () => {
  it('D1 the loading.tsx files under dashboard/ are exactly the pinned list', () => {
    expect(LOADINGS).toEqual([
      'admin/loading.tsx',
      'ai/loading.tsx',
      'bundles/loading.tsx',
      'categories/loading.tsx',
      'cycle-counts/loading.tsx',
      'insights/loading.tsx',
      'locations/loading.tsx',
      'maintenance/loading.tsx',
      'movements/loading.tsx',
      'notifications/loading.tsx',
      'orders/new/loading.tsx',
      'planning/loading.tsx',
      'procedures/loading.tsx',
      'product-groups/loading.tsx',
      'purchase-orders/loading.tsx',
      'rentals/loading.tsx',
      'reports/loading.tsx',
      'returns/loading.tsx',
      'schedule/loading.tsx',
      'settings/loading.tsx',
      'suppliers/loading.tsx',
      'tags/loading.tsx',
      'team/loading.tsx',
      'warehouses/loading.tsx',
      'whats-new/[slug]/loading.tsx',
      'whats-new/loading.tsx',
      'zendesk/loading.tsx',
    ]);
    // The group's own fallback, which hard loads show, is still there.
    expect(existsSync(path.join(GROUP, 'loading.tsx'))).toBe(true);
  });

  const RELYING = PAGES.filter((page) => nearestLoading(page) === null);

  it('D2 the pages with no loading.tsx of their own are exactly the pinned list', () => {
    expect(RELYING).toEqual([
      'audit/page.tsx',
      'books/[id]/edit/page.tsx',
      'books/[id]/page.tsx',
      'books/import/page.tsx',
      'books/new/page.tsx',
      'books/page.tsx',
      'customers/page.tsx',
      'exceptions/page.tsx',
      'help/page.tsx',
      'inventory/[id]/edit/page.tsx',
      'inventory/[id]/page.tsx',
      'inventory/import/page.tsx',
      'inventory/labels/page.tsx',
      'inventory/new/page.tsx',
      'inventory/page.tsx',
      'inventory/staging/page.tsx',
      'orders/[id]/page.tsx',
      'orders/[id]/pick/page.tsx',
      'orders/[id]/print/page.tsx',
      'orders/page.tsx',
      'page.tsx',
      'support/page.tsx',
    ]);
  });

  it.each(RELYING)('D3 %s has a late skeleton', (page) => {
    expect(routeSkeletonFor(samplePath(dirOf(page)))).not.toBeNull();
  });

  const ASYNC_LAYOUT_SECTIONS = [
    ...new Set(
      PAGES.map(nearestLoading).filter((d): d is string => d !== null && layoutsAbove(d).length > 0),
    ),
  ].sort();

  it('D4 the sections with an async layout above their loading.tsx are exactly admin, purchase-orders and reports', () => {
    expect(ASYNC_LAYOUT_SECTIONS).toEqual(['admin', 'purchase-orders', 'reports']);
    for (const section of ASYNC_LAYOUT_SECTIONS) {
      for (const layoutDir of layoutsAbove(section)) {
        const layout = readFileSync(path.join(DASH, layoutDir, 'layout.tsx'), 'utf8');
        expect(layout, `${layoutDir}/layout.tsx`).toMatch(/export default async function/);
      }
    }
  });

  const UNDER_ASYNC_LAYOUT = PAGES.filter((page) => {
    const loading = nearestLoading(page);
    return loading !== null && ASYNC_LAYOUT_SECTIONS.includes(loading);
  });

  it.each(UNDER_ASYNC_LAYOUT)('D4 %s maps to the shape of its section loading.tsx', (page) => {
    const section = nearestLoading(page);
    if (section === null) throw new Error('unreachable');
    const kind = kindOfLoading(section);
    expect(kind).not.toBeNull();
    expect(routeSkeletonFor(samplePath(dirOf(page)))).toBe(kind);
  });

  const OWN_LOADING = PAGES.filter(
    (page) => !RELYING.includes(page) && !UNDER_ASYNC_LAYOUT.includes(page),
  );

  it.each(OWN_LOADING)('D5 %s keeps its own loading.tsx and gets no late skeleton', (page) => {
    expect(routeSkeletonFor(samplePath(dirOf(page)))).toBeNull();
  });

  it('covers every page exactly once', () => {
    expect(RELYING.length + UNDER_ASYNC_LAYOUT.length + OWN_LOADING.length).toBe(PAGES.length);
    expect(PAGES.length).toBeGreaterThan(100);
  });
});
