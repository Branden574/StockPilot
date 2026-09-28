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

  // F1-5: the exception's "Escalate to maintenance" link on the web is
  // /dashboard/maintenance/new?exceptionOccurrenceId=<uuid>. Before, any query
  // on the new-request path fell through to the catch-all and opened Home.
  // Mutation caught: the query dropped (a plain, unlinked request form), or
  // kept unchecked (anything a link carries reaching the form).
  it('new with the escalate query keeps the exception id and a location id, both uuids only', () => {
    const occ = '11111111-1111-4111-8111-111111111111';
    const loc = '55555555-5555-4555-8555-555555555555';
    expect(rewriteWebPath(`/dashboard/maintenance/new?exceptionOccurrenceId=${occ}`)).toBe(
      `/maintenance/new?exceptionOccurrenceId=${occ}`,
    );
    expect(rewriteWebPath(`/dashboard/maintenance/new?exceptionOccurrenceId=${occ}&locationId=${loc}`)).toBe(
      `/maintenance/new?exceptionOccurrenceId=${occ}&locationId=${loc}`,
    );
    expect(rewriteWebPath(`/dashboard/maintenance/new?locationId=${loc}&subject=hi`)).toBe(
      `/maintenance/new?locationId=${loc}`,
    );
    expect(rewriteWebPath('/dashboard/maintenance/new?exceptionOccurrenceId=../../x')).toBe('/maintenance/new');
    expect(rewriteWebPath('/dashboard/maintenance/new?itemId=abc')).toBe('/maintenance/new');
    expect(rewriteWebPath(`/dashboard/maintenance/new?exceptionOccurrenceId=${occ}&exceptionOccurrenceId=${loc}`)).toBe(
      `/maintenance/new?exceptionOccurrenceId=${occ}`,
    );
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

// Exceptions (F1-1) has native twins for the list and one occurrence. No push
// links there yet, but What's New CTAs, shared links and pasted URLs do, and
// every one of them must land on the screen, not fall through the /dashboard/*
// catch-all to home.

describe('exceptions deep links', () => {
  const ID = '33333333-3333-4333-8333-333333333333';

  it('an occurrence: /dashboard/exceptions/<uuid> -> /exceptions/<uuid>', () => {
    expect(rewriteWebPath(`/dashboard/exceptions/${ID}`)).toBe(`/exceptions/${ID}`);
  });

  it('the list, with or without the tab query: -> /exceptions', () => {
    expect(rewriteWebPath('/dashboard/exceptions')).toBe('/exceptions');
    expect(rewriteWebPath('/dashboard/exceptions?tab=resolved')).toBe('/exceptions');
  });

  // Mutation caught: the rows placed below the catch-all (every link opens
  // home) or the bare-list row placed above the detail row with a looser
  // pattern (an occurrence link opens the list).
  it('ORDERING: both rows sit above the catch-all, and the detail is never read as the list', () => {
    expect(rewriteWebPath(`/dashboard/exceptions/${ID}`)).not.toBe('/');
    expect(rewriteWebPath('/dashboard/exceptions')).not.toBe('/');
    expect(rewriteWebPath(`/dashboard/exceptions/${ID}`)).not.toBe('/exceptions');
    // A malformed id is not an occurrence: it falls through to home, never
    // into a screen that would ask the server for it.
    expect(rewriteWebPath('/dashboard/exceptions/not-an-id')).toBe('/');
  });
});

// Rentals (2026-09-25): the phone has a rental detail now, reached by links
// inside the app, push taps and stockpilot:// links. (The https links in
// rental emails open Safari: there are no universal links yet, see
// web-path-rewrite.ts.)
describe('rentals deep links', () => {
  const ID = '44444444-4444-4444-8444-444444444444';

  it('a rental: /dashboard/rentals/<uuid> -> /rentals/<uuid>', () => {
    expect(rewriteWebPath(`/dashboard/rentals/${ID}`)).toBe(`/rentals/${ID}`);
  });

  it('the list (any status filter) and New rental', () => {
    expect(rewriteWebPath('/dashboard/rentals')).toBe('/rentals');
    expect(rewriteWebPath('/dashboard/rentals?status=overdue')).toBe('/rentals');
    expect(rewriteWebPath('/dashboard/rentals/new')).toBe('/rentals/new');
  });

  it('rental item pages and malformed ids are not rentals: home', () => {
    expect(rewriteWebPath(`/dashboard/rentals/items/${ID}`)).toBe('/');
    expect(rewriteWebPath('/dashboard/rentals/not-an-id')).toBe('/');
  });
});

// Locations (F1-3): one location has a native twin (app/location/[id].tsx,
// SINGULAR), and the list is the drawer's Locations screen (/locations,
// plural). A What's New CTA, a shared link or a pasted URL for either must
// land on the screen instead of home.
describe('locations deep links', () => {
  const ID = '55555555-5555-4555-8555-555555555555';

  it('a location: /dashboard/locations/<uuid> -> /location/<uuid>', () => {
    expect(rewriteWebPath(`/dashboard/locations/${ID}`)).toBe(`/location/${ID}`);
  });

  it("the web page's ?page= is dropped", () => {
    expect(rewriteWebPath(`/dashboard/locations/${ID}?page=3`)).toBe(`/location/${ID}`);
  });

  it('the list, with or without a query: -> /locations', () => {
    expect(rewriteWebPath('/dashboard/locations')).toBe('/locations');
    expect(rewriteWebPath('/dashboard/locations?tab=racks')).toBe('/locations');
  });

  // Mutation caught: the rows below the catch-all (both open home), the
  // detail mapped to the plural list route, or the list row matching first.
  it('ORDERING: both rows sit above the catch-all, and a location is never read as the list', () => {
    expect(rewriteWebPath(`/dashboard/locations/${ID}`)).not.toBe('/');
    expect(rewriteWebPath(`/dashboard/locations/${ID}`)).not.toBe('/locations');
    expect(rewriteWebPath(`/dashboard/locations/${ID}`)).not.toBe(`/locations/${ID}`);
    expect(rewriteWebPath('/dashboard/locations')).not.toBe('/');
  });

  it('a malformed id is not a location: home', () => {
    expect(rewriteWebPath('/dashboard/locations/not-an-id')).toBe('/');
  });

  it('the stockpilot:// form of the link resolves the same way', () => {
    expect(rewriteWebPath(`stockpilot:///dashboard/locations/${ID}`)).toBe(`/location/${ID}`);
  });
});
