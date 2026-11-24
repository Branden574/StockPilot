// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { securityResponseRoutes } from '@stockpilot/core';

/**
 * EVERY PLACE A CARD NAMES IS A REAL PAGE. Each route in the how-to-respond
 * cards is checked against the app's own route files: a folder for each
 * literal segment, a dynamic folder ([id]) where the card says
 * `<organization id>`, and a page file at the end. Route groups ("(platform)")
 * add no segment; private folders ("_x") and parallel slots ("@x") are no
 * route. A `?tab=` names a tab the page lists. Made-up routes only in the
 * self-checks.
 */

const APP = join(__dirname, '..', '..', '..', 'app');
const ORG_SLOT = '<organization id>';

interface PageRoute {
  segments: string[];
  file: string;
}

function pages(dir: string, segments: string[] = []): PageRoute[] {
  const found: PageRoute[] = [];
  for (const name of ['page.tsx', 'page.ts', 'page.jsx', 'page.js']) {
    if (existsSync(join(dir, name))) found.push({ segments, file: join(dir, name) });
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith('_') || name.startsWith('@') || name === 'node_modules') continue;
    const group = /^\(.*\)$/.test(name);
    found.push(...pages(join(dir, name), group ? segments : [...segments, name]));
  }
  return found;
}

const ALL = pages(APP);

/** The page file a card's route opens, or null when there is none. */
function pageOf(route: string): string | null {
  const path = route.split('?')[0]!;
  if (!path.startsWith('/')) return null;
  const want = path === '/' ? [] : path.slice(1).split('/');
  const match = ALL.find(
    ({ segments }) =>
      segments.length === want.length &&
      segments.every((seg, i) =>
        want[i] === ORG_SLOT ? /^\[[^.[\]]+\]$/.test(seg) : seg === want[i],
      ),
  );
  return match?.file ?? null;
}

/** Whether the page lists the tab a `?tab=` names. */
function hasTab(file: string, tab: string): boolean {
  return new RegExp(`key:\\s*'${tab}'`).test(readFileSync(file, 'utf8'));
}

describe("the cards' routes", () => {
  it('the check finds real pages, through groups and dynamic folders, and refuses made-up ones', () => {
    expect(pageOf('/platform/security')).toMatch(/\(platform\)\/platform\/security\/page\.tsx$/);
    expect(pageOf(`/platform/orgs/${ORG_SLOT}`)).toMatch(/platform\/orgs\/\[id\]\/page\.tsx$/);
    expect(pageOf('/platform/nowhere')).toBeNull();
    expect(pageOf(`/platform/orgs/${ORG_SLOT}/nowhere`)).toBeNull();
    // A literal segment never stands in for a dynamic folder.
    expect(pageOf('/platform/orgs/some-org')).toBeNull();
    expect(pageOf('platform/security')).toBeNull();
    const org = pageOf(`/platform/orgs/${ORG_SLOT}`)!;
    expect(hasTab(org, 'users')).toBe(true);
    expect(hasTab(org, 'nowhere')).toBe(false);
  });

  it('every route a card names opens a page of the app', () => {
    const routes = securityResponseRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const { card, place } of routes) {
      expect(pageOf(place.route), `${card}: ${place.route}`).not.toBeNull();
    }
  });

  it('a `?tab=` is a tab the page lists, and no other query is used', () => {
    for (const { card, place } of securityResponseRoutes()) {
      const query = place.route.split('?')[1];
      if (query === undefined) continue;
      const tab = /^tab=([a-z]+)$/.exec(query);
      expect(tab, `${card}: ${place.route}`).not.toBeNull();
      expect(hasTab(pageOf(place.route)!, tab![1]!), `${card}: ${place.route}`).toBe(true);
    }
  });

  it("the organization's own app (after Act as this org) is /dashboard; the console's own pages are /platform", () => {
    for (const { card, place } of securityResponseRoutes()) {
      if (place.afterActAs) expect(place.route, card).toMatch(/^\/dashboard\//);
      else expect(place.route, card).toMatch(/^\/platform(\/|$)/);
    }
  });
});
