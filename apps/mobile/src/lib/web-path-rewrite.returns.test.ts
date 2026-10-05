import { readFileSync } from 'node:fs';
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
