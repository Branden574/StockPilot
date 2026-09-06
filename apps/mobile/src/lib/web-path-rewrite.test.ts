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

// Staging got a native twin (put-away is done on foot). Every web link to it —
// a notification, a What's New CTA, a pasted URL — must land on the screen
// instead of falling through the /dashboard/* catch-all to home.

describe('rewriteWebPath staging', () => {
  it('the web staging page resolves to the native screen', () => {
    expect(rewriteWebPath('/dashboard/inventory/staging')).toBe('/staging');
  });
  it('the ?type= filter is dropped to the full worklist', () => {
    expect(rewriteWebPath('/dashboard/inventory/staging?type=book')).toBe('/staging');
  });
  it('item detail still wins for a real item id under the same prefix', () => {
    expect(
      rewriteWebPath('/dashboard/inventory/22222222-2222-4222-8222-222222222222'),
    ).toBe('/item/22222222-2222-4222-8222-222222222222');
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

// Maintenance requests (Task 18) got THREE native twins — detail, the
// new-request form, and the list — for the notification doors Task 21 wires
// up. Without these rules every one of them dead-ends on home through the
// /dashboard/* catch-all, exactly the landmine 31 warns about.

describe('maintenance deep links (all three notification doors route through here)', () => {
  it('detail: /dashboard/maintenance/<uuid> -> /maintenance/<uuid>', () => {
    expect(rewriteWebPath('/dashboard/maintenance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'))
      .toBe('/maintenance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
  it('new: /dashboard/maintenance/new -> /maintenance/new', () => {
    expect(rewriteWebPath('/dashboard/maintenance/new')).toBe('/maintenance/new');
  });
  it('list incl. query: /dashboard/maintenance?scope=all -> /maintenance', () => {
    expect(rewriteWebPath('/dashboard/maintenance')).toBe('/maintenance');
    expect(rewriteWebPath('/dashboard/maintenance?scope=all')).toBe('/maintenance');
  });
});

// SP-031: four notification link shapes that are STILL EMITTED in prod had no
// rule here, so every one of them fell through the /dashboard/* catch-all and
// dead-ended the tap on the Home tab even though a native twin exists:
//   (a) 0042 trg_cycle_counts_assigned  -> '/dashboard/cycle-counts/<id>'
//   (b) cron auto-reorder + recurring-pos -> '/dashboard/purchase-orders' (BARE)
//   (c) 0091 low/out-of-stock crossing  -> '/dashboard/inventory?stock=out&type=all'
//   (d) 0042 bundle shortage            -> '/dashboard/bundles/<id>'
// The ordering assertions are the real guard: the two BARE-list rules sit
// after their /<uuid> siblings and must never shadow them.

describe('SP-031 notification doors with native twins', () => {
  it('cycle-count assignment opens the count, not home', () => {
    expect(rewriteWebPath('/dashboard/cycle-counts/11111111-1111-4111-8111-111111111111')).toBe(
      '/cycle-count/11111111-1111-4111-8111-111111111111',
    );
  });

  it('bundle shortage opens the bundle, not home', () => {
    expect(rewriteWebPath('/dashboard/bundles/33333333-3333-4333-8333-333333333333')).toBe(
      '/bundles/33333333-3333-4333-8333-333333333333',
    );
  });

  it('the bare purchase-orders list (auto-reorder / recurring-po cron) resolves', () => {
    expect(rewriteWebPath('/dashboard/purchase-orders')).toBe('/purchase-orders');
    expect(rewriteWebPath('/dashboard/purchase-orders?status=draft')).toBe('/purchase-orders');
  });

  it('ORDERING: a purchase-order id still beats the bare list rule', () => {
    expect(rewriteWebPath('/dashboard/purchase-orders/44444444-4444-4444-8444-444444444444')).toBe(
      '/po/44444444-4444-4444-8444-444444444444',
    );
  });

  it('the low/out-of-stock crossing link resolves to the Items tab', () => {
    expect(rewriteWebPath('/dashboard/inventory?stock=out&type=all')).toBe('/inventory');
    expect(rewriteWebPath('/dashboard/inventory')).toBe('/inventory');
  });

  it('ORDERING: staging and item detail still beat the bare inventory rule', () => {
    expect(rewriteWebPath('/dashboard/inventory/staging?type=book')).toBe('/staging');
    expect(rewriteWebPath('/dashboard/inventory/55555555-5555-4555-8555-555555555555')).toBe(
      '/item/55555555-5555-4555-8555-555555555555',
    );
  });
});
