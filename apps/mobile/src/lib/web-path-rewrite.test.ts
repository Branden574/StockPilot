import { describe, expect, it } from 'vitest';

import { rewriteWebPath } from './web-path-rewrite';

// The audit console consolidation (web /dashboard/audit, old
// /dashboard/admin/audit redirecting onto it) must keep resolving to the
// native /admin/audit screen through the ONE rewriter — a notification or
// deep link carrying either web path may not dead-end.

describe('rewriteWebPath audit routes', () => {
  it('new consolidated web path resolves to the native audit screen', () => {
    expect(rewriteWebPath('/dashboard/audit')).toBe('/admin/audit');
  });
  it('legacy admin web path resolves too', () => {
    expect(rewriteWebPath('/dashboard/admin/audit')).toBe('/admin/audit');
  });
  it('query strings (filters) are dropped to the full audit list', () => {
    expect(rewriteWebPath('/dashboard/audit?category=stock')).toBe('/admin/audit');
  });
});

describe('rewriteWebPath existing rules stay intact', () => {
  it('order detail keeps its native twin', () => {
    expect(
      rewriteWebPath('/dashboard/orders/11111111-1111-4111-8111-111111111111'),
    ).toBe('/order/11111111-1111-4111-8111-111111111111');
  });
  it('unknown dashboard paths still fall through to home', () => {
    expect(rewriteWebPath('/dashboard/some-new-page')).toBe('/');
  });
});
