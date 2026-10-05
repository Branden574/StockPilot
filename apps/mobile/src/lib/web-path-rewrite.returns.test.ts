import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { rewriteWebPath } from './web-path-rewrite';

/**
 * Returns RX-1 deep links (returns plan C-3). Staff pushes carry the DUAL
 * link `/dashboard/returns/<rma>?order=/dashboard/orders/<original>`:
 *
 *   - a bundle with the returns rules (this one) opens the RMA workbench;
 *   - every bundle shipped before RX-1 has no returns rule, so its FIRST rule
 *     (the unanchored /dashboard/orders/<uuid>, unchanged since 2026-07-11)
 *     matches the order path embedded in the query and opens the original
 *     order, never Home.
 *
 * The second half runs the link through a FROZEN copy of the rewrite table
 * as it stood before RX-1 (origin/main ef79e562), so a change to how old
 * bundles answer can never sneak in through this file.
 */

const RMA = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const DUAL = `/dashboard/returns/${RMA}?order=/dashboard/orders/${ORDER}`;

describe('the returns rules (this bundle)', () => {
  it('the dual link opens the RMA', () => {
    expect(rewriteWebPath(DUAL)).toBe(`/returns/${RMA}`);
  });
  it('a plain RMA link and the list open their twins', () => {
    expect(rewriteWebPath(`/dashboard/returns/${RMA}`)).toBe(`/returns/${RMA}`);
    expect(rewriteWebPath('/dashboard/returns')).toBe('/returns');
    expect(rewriteWebPath('/dashboard/returns?filter=waiting_for_return')).toBe('/returns');
  });
  it('an order link still opens the order', () => {
    expect(rewriteWebPath(`/dashboard/orders/${ORDER}`)).toBe(`/order/${ORDER}`);
  });
  it('the returns rules sit above the unanchored orders rule (first match wins)', () => {
    const src = readFileSync(path.join(__dirname, 'web-path-rewrite.ts'), 'utf8');
    const returnsAt = src.indexOf('`/dashboard/returns/${UUID}`');
    const listAt = src.indexOf('/\\/dashboard\\/returns(\\?.*)?$/');
    const ordersAt = src.indexOf('`/dashboard/orders/${UUID}`');
    expect(returnsAt).toBeGreaterThan(0);
    expect(listAt).toBeGreaterThan(0);
    expect(returnsAt).toBeLessThan(ordersAt);
    expect(listAt).toBeLessThan(ordersAt);
  });
  it('a cold-start shim exists for the RMA path', () => {
    const shim = readFileSync(path.join(__dirname, '..', '..', 'app', 'dashboard', 'returns', '[id].tsx'), 'utf8');
    expect(shim).toContain("pathname: '/returns/[id]'");
  });
});

// ── The table before RX-1, frozen (ef79e562, rules in their order) ─────────
const UUID = '([0-9a-fA-F-]{36})';
const FROZEN: { re: RegExp; to: (m: RegExpMatchArray) => string }[] = [
  { re: new RegExp(`/dashboard/orders/${UUID}`), to: (m) => `/order/${m[1]}` },
  { re: /\/dashboard\/inventory\/staging(\?.*)?$/, to: () => '/staging' },
  { re: new RegExp(`/dashboard/inventory/${UUID}`), to: (m) => `/item/${m[1]}` },
  { re: /\/dashboard\/inventory(\?.*)?$/, to: () => '/inventory' },
  { re: new RegExp(`/dashboard/purchase-orders/${UUID}`), to: (m) => `/po/${m[1]}` },
  { re: /\/dashboard\/purchase-orders(\?.*)?$/, to: () => '/purchase-orders' },
  { re: new RegExp(`/dashboard/cycle-counts/${UUID}`), to: (m) => `/cycle-count/${m[1]}` },
  { re: new RegExp(`/dashboard/bundles/${UUID}`), to: (m) => `/bundles/${m[1]}` },
  { re: /\/dashboard\/schedule(\/.*)?$/, to: () => '/schedule' },
  { re: /\/dashboard\/insights$/, to: () => '/notifications' },
  { re: /\/dashboard\/support(\/.*)?$/, to: () => '/support' },
  { re: /\/dashboard\/orders(\?.*)?$/, to: () => '/orders' },
  { re: /\/dashboard\/(admin\/)?audit(\?.*)?$/, to: () => '/admin/audit' },
  { re: new RegExp(`/dashboard/maintenance/${UUID}`), to: (m) => `/maintenance/${m[1]}` },
  { re: /\/dashboard\/maintenance\/new(\?.*)?$/, to: () => '/maintenance/new' },
  { re: /\/dashboard\/maintenance(\?.*)?$/, to: () => '/maintenance' },
  { re: new RegExp(`/dashboard/exceptions/${UUID}`), to: (m) => `/exceptions/${m[1]}` },
  { re: /\/dashboard\/exceptions(\?.*)?$/, to: () => '/exceptions' },
  { re: new RegExp(`/dashboard/rentals/${UUID}`), to: (m) => `/rentals/${m[1]}` },
  { re: /\/dashboard\/rentals\/new$/, to: () => '/rentals/new' },
  { re: /\/dashboard\/rentals(\?.*)?$/, to: () => '/rentals' },
  { re: new RegExp(`/dashboard/locations/${UUID}`), to: (m) => `/location/${m[1]}` },
  { re: /\/dashboard\/locations(\?.*)?$/, to: () => '/locations' },
  { re: /\/dashboard\/reports\/book-order-totals(\?.*)?$/, to: () => '/reports/book-order-totals' },
  { re: /\/dashboard\/reports(\?.*)?$/, to: () => '/reports' },
  { re: /^\/dashboard(\/.*)?$/, to: () => '/' },
];

function frozenRewrite(p: string): string {
  for (const { re, to } of FROZEN) {
    const m = p.match(re);
    if (m) return to(m);
  }
  return p;
}

describe('an older bundle (the frozen pre-RX-1 table)', () => {
  it('opens the ORIGINAL ORDER for the dual link, never Home', () => {
    expect(frozenRewrite(DUAL)).toBe(`/order/${ORDER}`);
  });
  it('a bare RMA link (no embedded order) would land on Home: that is why staff pushes always carry the dual link', () => {
    expect(frozenRewrite(`/dashboard/returns/${RMA}`)).toBe('/');
  });
  it('the order it opens is a native route every bundle has (no cold-start shim needed)', () => {
    expect(existsSync(path.join(__dirname, '..', '..', 'app', 'order', '[id].tsx'))).toBe(true);
  });
  it('the frozen copy still agrees with the live table for every pre-RX-1 path', () => {
    for (const p of [
      `/dashboard/orders/${ORDER}`,
      '/dashboard/inventory/staging?type=book',
      '/dashboard/inventory?stock=out&type=all',
      `/dashboard/maintenance/${ORDER}`,
      '/dashboard/exceptions',
      '/dashboard/some-new-page',
    ]) {
      expect(rewriteWebPath(p)).toBe(frozenRewrite(p));
    }
  });
});

// ── How a push link reaches the router (desk check F5) ─────────────────────
// The dual link must not dead-end on an older bundle on a cold start either.
// Two facts make that hold, and both are pinned here:
//   1. A push tap is rewritten in JS by the RUNNING bundle's table before it
//      is opened (use-push-notifications.ts), so the router is handed a
//      native path (an older bundle: /order/<original>), never the raw web
//      path, warm or cold.
//   2. A raw URL that does reach the router as the initial URL goes through
//      +native-intent's redirectSystemPath on this expo-router (57.x, the
//      published bundle's version): getLinkingConfig passes the initial URL
//      through it with initial: true. If an upgrade drops that, this fails
//      and the cold-start shims become the only door again.
describe('a push link reaches the router already rewritten (desk check F5)', () => {
  it('the tap handler rewrites with the running bundle\'s table, then opens the native path', () => {
    const src = readFileSync(path.join(__dirname, 'use-push-notifications.ts'), 'utf8');
    const rewriteAt = src.indexOf('const native = rewriteWebPath(link);');
    const openAt = src.indexOf("Linking.openURL(`stockpilot://${native.replace(/^\\//, '')}`)");
    expect(rewriteAt).toBeGreaterThan(0);
    expect(openAt).toBeGreaterThan(rewriteAt);
  });
  it('+native-intent rewrites every incoming path, and this expo-router sends it the initial URL too', () => {
    const intent = readFileSync(path.join(__dirname, '..', '..', 'app', '+native-intent.ts'), 'utf8');
    expect(intent).toContain('return rewriteWebPath(path);');
    const req = createRequire(__filename);
    const linking = readFileSync(req.resolve('expo-router/build/getLinkingConfig.js'), 'utf8');
    expect(linking).toContain('redirectSystemPath({ path: initialUrl, initial: true })');
  });
});
