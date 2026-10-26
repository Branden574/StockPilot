import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTIFICATION_LINK_MAX_LENGTH, parseNotificationLink } from './notification-link';
import { rewriteWebPath } from './web-path-rewrite';

/**
 * The link of a tapped push (data.link), parsed for the notification
 * coordinator (Phase 3, iPhone push tap). It routes on the PATH with the one
 * shared table (web-path-rewrite.ts), accepts only first-party shapes, and
 * never invents a destination: an unknown page is "unsupported", never Home.
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const RMA = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT = '33333333-3333-4333-8333-333333333333';
const PO = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';
const COUNT = '66666666-6666-4666-8666-666666666666';
const BUNDLE = '77777777-7777-4777-8777-777777777777';
const REQUEST = '88888888-8888-4888-8888-888888888888';
const EVENT = '99999999-9999-4999-8999-999999999999';
const DUAL = `/dashboard/returns/${RMA}?order=/dashboard/orders/${ORDER}`;

describe('first-party links open their native screen', () => {
  it('an order link opens /order/<uuid>, with the route kind and the id', () => {
    expect(parseNotificationLink(`/dashboard/orders/${ORDER}`)).toEqual({
      ok: true,
      linkKind: 'relative',
      native: `/order/${ORDER}`,
      routeKind: 'order',
      resourceId: ORDER,
    });
  });

  it('the returns DUAL link opens the RMA, never the order embedded in its query', () => {
    expect(parseNotificationLink(DUAL)).toEqual({
      ok: true,
      linkKind: 'relative',
      native: `/returns/${RMA}`,
      routeKind: 'returns',
      resourceId: RMA,
    });
  });

  it('an order link never carries a query into /order/<uuid> (no ?focus=sign on arrival)', () => {
    const target = parseNotificationLink(`/dashboard/orders/${ORDER}?focus=sign`);
    expect(target).toMatchObject({ ok: true, native: `/order/${ORDER}` });
    expect(target.ok && target.native.includes('?')).toBe(false);
    expect(parseNotificationLink(`/dashboard/orders/${ORDER}?focus=approve#top`)).toMatchObject({
      ok: true,
      native: `/order/${ORDER}`,
    });
  });

  it('https on stockpilotusa.com and www.stockpilotusa.com opens inside the app', () => {
    for (const host of ['stockpilotusa.com', 'www.stockpilotusa.com', 'StockPilotUSA.com']) {
      expect(parseNotificationLink(`https://${host}/dashboard/orders/${ORDER}`)).toEqual({
        ok: true,
        linkKind: 'https',
        native: `/order/${ORDER}`,
        routeKind: 'order',
        resourceId: ORDER,
      });
    }
  });

  it('the fragment is dropped', () => {
    expect(
      parseNotificationLink(`https://stockpilotusa.com/dashboard/orders/${ORDER}#lines`),
    ).toMatchObject({
      ok: true,
      native: `/order/${ORDER}`,
    });
  });

  it('stockpilot:// is accepted only in the web-path form', () => {
    expect(parseNotificationLink(`stockpilot:///dashboard/orders/${ORDER}`)).toEqual({
      ok: true,
      linkKind: 'scheme',
      native: `/order/${ORDER}`,
      routeKind: 'order',
      resourceId: ORDER,
    });
    // A native-form custom link is not a producer shape, and this one would
    // open the signature prompt on arrival.
    expect(parseNotificationLink(`stockpilot://order/${ORDER}?focus=sign`)).toEqual({
      ok: false,
      linkKind: 'scheme',
      reason: 'unsupported',
    });
  });

  it('a list page with no id opens the list, with no resource id', () => {
    expect(parseNotificationLink('/dashboard/inventory?stock=low&type=all')).toEqual({
      ok: true,
      linkKind: 'relative',
      native: '/inventory',
      routeKind: 'inventory',
      resourceId: null,
    });
  });
});

describe('the route is decided by the PATH, never by the query', () => {
  it('an order path in the query of another page does not open the order', () => {
    // The unanchored orders rule matches the embedded path when handed the
    // whole link: rewriteWebPath alone would open the order.
    const link = `/dashboard/inventory?next=/dashboard/orders/${ORDER}`;
    expect(rewriteWebPath(link)).toBe(`/order/${ORDER}`);
    expect(parseNotificationLink(link)).toMatchObject({
      ok: true,
      native: '/inventory',
      resourceId: null,
    });
  });

  it('a returns path in the query of an order link opens the order', () => {
    expect(
      parseNotificationLink(`/dashboard/orders/${ORDER}?from=/dashboard/returns/${RMA}`),
    ).toMatchObject({
      ok: true,
      native: `/order/${ORDER}`,
    });
  });

  it('the maintenance escalate link keeps exceptionOccurrenceId (sanitised by the table)', () => {
    const link = `/dashboard/maintenance/new?exceptionOccurrenceId=${ITEM}&subject=hi`;
    expect(parseNotificationLink(link)).toEqual({
      ok: true,
      linkKind: 'relative',
      native: `/maintenance/new?exceptionOccurrenceId=${ITEM}`,
      routeKind: 'maintenance',
      resourceId: null,
    });
  });

  it('the Book Order Totals filters survive, as the table writes them', () => {
    const link = `/dashboard/reports/book-order-totals?charter=${ITEM}&from=2026-09-01&to=2026-09-30`;
    const expected = rewriteWebPath(link);
    expect(expected.startsWith('/reports/book-order-totals?')).toBe(true);
    expect(expected).toContain(`charter=${ITEM}`);
    expect(parseNotificationLink(link)).toMatchObject({
      ok: true,
      native: expected,
      routeKind: 'reports',
    });
  });
});

describe('everything else is refused, with a reason', () => {
  it.each([
    ['a foreign host', `https://evil.example/dashboard/orders/${ORDER}`, 'https', 'foreign-host'],
    [
      'our name as a subdomain of another host',
      `https://stockpilotusa.com.evil.example/dashboard/orders/${ORDER}`,
      'https',
      'foreign-host',
    ],
    [
      'a host that only ends with our name',
      `https://evilstockpilotusa.com/dashboard/orders/${ORDER}`,
      'https',
      'foreign-host',
    ],
    [
      'a subdomain of ours',
      `https://evil.stockpilotusa.com/dashboard/orders/${ORDER}`,
      'https',
      'foreign-host',
    ],
    ['a port', `https://stockpilotusa.com:8443/dashboard/orders/${ORDER}`, 'https', 'foreign-host'],
    ['an empty host', `https:///dashboard/orders/${ORDER}`, 'https', 'foreign-host'],
    ['userinfo', `https://user@stockpilotusa.com/dashboard/orders/${ORDER}`, 'https', 'malformed'],
    [
      'userinfo hiding another host',
      `https://stockpilotusa.com@evil.example/dashboard/orders/${ORDER}`,
      'https',
      'malformed',
    ],
    ['plain http', `http://stockpilotusa.com/dashboard/orders/${ORDER}`, 'other', 'bad-scheme'],
    ['javascript:', 'javascript:alert(1)', 'other', 'bad-scheme'],
    ['mailto:', 'mailto:someone@example.com', 'other', 'bad-scheme'],
    ['no leading slash', `dashboard/orders/${ORDER}`, 'other', 'malformed'],
  ])('%s', (_label, link, linkKind, reason) => {
    expect(parseNotificationLink(link)).toEqual({ ok: false, linkKind, reason });
  });

  it('no link, an empty link, a number or an object', () => {
    expect(parseNotificationLink(null)).toEqual({ ok: false, linkKind: 'none', reason: 'no-link' });
    expect(parseNotificationLink(undefined)).toEqual({
      ok: false,
      linkKind: 'none',
      reason: 'no-link',
    });
    expect(parseNotificationLink('')).toEqual({ ok: false, linkKind: 'none', reason: 'no-link' });
    expect(parseNotificationLink(42)).toEqual({
      ok: false,
      linkKind: 'none',
      reason: 'not-a-string',
    });
    expect(parseNotificationLink({ link: `/dashboard/orders/${ORDER}` })).toEqual({
      ok: false,
      linkKind: 'none',
      reason: 'not-a-string',
    });
  });

  it(`over ${NOTIFICATION_LINK_MAX_LENGTH} characters`, () => {
    expect(NOTIFICATION_LINK_MAX_LENGTH).toBe(2048);
    const base = `/dashboard/orders/${ORDER}?pad=`;
    const atLimit = base + 'a'.repeat(NOTIFICATION_LINK_MAX_LENGTH - base.length);
    expect(parseNotificationLink(atLimit)).toMatchObject({ ok: true, native: `/order/${ORDER}` });
    expect(parseNotificationLink(`${atLimit}a`)).toEqual({
      ok: false,
      linkKind: 'relative',
      reason: 'too-long',
    });
  });

  it.each([
    ['an encoded dot segment', '/dashboard/orders/%2e%2e'],
    ['a dot segment', '/dashboard/orders/..'],
    ['a protocol-relative link', `//evil.example/dashboard/orders/${ORDER}`],
    ['a double slash in the path', `/dashboard//orders/${ORDER}`],
    ['a trailing slash', `/dashboard/orders/${ORDER}/`],
    ['a backslash', `/dashboard/orders/${ORDER}\\x`],
    ['a newline', `/dashboard/orders/${ORDER}\n`],
    ['a space', `/dashboard/orders/ ${ORDER}`],
    ['a control character', `/dashboard/orders/${ORDER}\u0000`],
    ['a protocol-relative custom link', `stockpilot:////evil.example/dashboard/orders/${ORDER}`],
  ])('%s is malformed', (_label, link) => {
    expect(parseNotificationLink(link)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('a 36-character id must be a real uuid, whole, in the web path (bad-id)', () => {
    // 36 dashes satisfy the table's permissive 36-character class.
    expect(parseNotificationLink(`/dashboard/orders/${'-'.repeat(36)}`)).toEqual({
      ok: false,
      linkKind: 'relative',
      reason: 'bad-id',
    });
    // The unanchored rule would cut a longer segment down to 36 characters.
    expect(parseNotificationLink(`/dashboard/orders/${ORDER}xyz`)).toEqual({
      ok: false,
      linkKind: 'relative',
      reason: 'bad-id',
    });
    expect(parseNotificationLink(`/dashboard/purchase-orders/${'f'.repeat(40)}`)).toMatchObject({
      ok: false,
      reason: 'bad-id',
    });
  });

  it('a web page with no native twin is unsupported, never Home', () => {
    expect(rewriteWebPath('/dashboard/some-new-page')).toBe('/');
    expect(parseNotificationLink('/dashboard/some-new-page')).toEqual({
      ok: false,
      linkKind: 'relative',
      reason: 'unsupported',
    });
    expect(parseNotificationLink('/dashboard')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(parseNotificationLink('/dashboard/orders/not-a-uuid')).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('a first-party page outside /dashboard is not a native destination', () => {
    expect(parseNotificationLink('https://stockpilotusa.com/r/abc')).toEqual({
      ok: false,
      linkKind: 'https',
      reason: 'not-dashboard',
    });
    expect(parseNotificationLink('https://stockpilotusa.com')).toMatchObject({
      ok: false,
      reason: 'not-dashboard',
    });
    expect(parseNotificationLink(`/order/${ORDER}`)).toMatchObject({
      ok: false,
      reason: 'not-dashboard',
    });
    expect(parseNotificationLink('/dashboardx')).toMatchObject({
      ok: false,
      reason: 'not-dashboard',
    });
  });
});

// ── Producer census (Phase 3 plan, linkShapes rows 1-24) ───────────────────
// Every link a producer writes today, as the template renders it, and the
// native route it must open. The source pins below fail when a producer's
// template changes, so this table is updated with it.
describe('producer census: every link a notification is sent with opens its screen', () => {
  it.each([
    ['1 new order request (0395)', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    ['2 cancelled after approval (0395)', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    ['3 requester status pings (0395)', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    [
      '4 replacement order pings (0396)',
      `/dashboard/orders/${REPLACEMENT}`,
      `/order/${REPLACEMENT}`,
    ],
    ['5 line changes', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    ['6 delivery assignment', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    ['7 picker assignment', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    [
      '8 partial hand-over (https)',
      `https://stockpilotusa.com/dashboard/orders/${ORDER}`,
      `/order/${ORDER}`,
    ],
    [
      '9 backorder shipped (https)',
      `https://stockpilotusa.com/dashboard/orders/${ORDER}`,
      `/order/${ORDER}`,
    ],
    ['10 returns staff (dual link)', DUAL, `/returns/${RMA}`],
    [
      '11 returns requester (replacement order)',
      `/dashboard/orders/${REPLACEMENT}`,
      `/order/${REPLACEMENT}`,
    ],
    ['11 returns requester (original order)', `/dashboard/orders/${ORDER}`, `/order/${ORDER}`],
    ['13 PO status', `/dashboard/purchase-orders/${PO}`, `/po/${PO}`],
    ['14 PO received', `/dashboard/purchase-orders/${PO}`, `/po/${PO}`],
    ['15 PO edited', `/dashboard/purchase-orders/${PO}`, `/po/${PO}`],
    ['16 auto-reorder and recurring POs', '/dashboard/purchase-orders', '/purchase-orders'],
    ['17 out of stock', '/dashboard/inventory?stock=out&type=all', '/inventory'],
    ['17 low stock', '/dashboard/inventory?stock=low&type=all', '/inventory'],
    ['18 item auto-archived', `/dashboard/inventory/${ITEM}`, `/item/${ITEM}`],
    ['19 cycle count assigned', `/dashboard/cycle-counts/${COUNT}`, `/cycle-count/${COUNT}`],
    ['20 bundle shortage', `/dashboard/bundles/${BUNDLE}`, `/bundles/${BUNDLE}`],
    ['21 maintenance', `/dashboard/maintenance/${REQUEST}`, `/maintenance/${REQUEST}`],
    [
      '22 schedule reminder (event id dropped, as today)',
      `/dashboard/schedule/${EVENT}`,
      '/schedule',
    ],
    ['23 daily briefing (the inbox)', '/dashboard/insights', '/notifications'],
  ])('%s', (_row, link, native) => {
    expect(parseNotificationLink(link)).toMatchObject({ ok: true, native });
  });

  it('24 a self-test push with no link has no destination (the fallback notice, not Home)', () => {
    expect(parseNotificationLink(undefined)).toMatchObject({ ok: false, reason: 'no-link' });
  });

  const ROOT = path.resolve(__dirname, '../../../..');
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
  const count = (src: string, needle: string) => src.split(needle).length - 1;

  it('the order and returns producers still write these templates', () => {
    expect(read('supabase/migrations/0395_order_stock_guards.sql')).toContain(
      "v_link := '/dashboard/orders/' || new.id::text;",
    );
    expect(read('supabase/migrations/0396_returns_exchange_staff.sql')).toContain(
      "'order_request.' || new.status, v_title, v_body,\n          '/dashboard/orders/' || new.id::text,",
    );
    const returnsNotify = read('apps/web/src/server/services/returns-notify.ts');
    expect(returnsNotify).toContain(
      'return `/dashboard/returns/${returnId}?order=/dashboard/orders/${orderId}`;',
    );
    expect(returnsNotify).toContain('link: `/dashboard/orders/${rma.linkOrderId ?? rma.orderId}`,');
    const handover = read('apps/web/src/server/lib/order-handover-notify.ts');
    expect(
      count(
        handover,
        "const link = `${args.appUrl.replace(/\\/+$/, '')}/dashboard/orders/${args.orderId}`;",
      ),
    ).toBe(2);
    const orderRequests = read('apps/web/src/server/services/order-requests.ts');
    expect(orderRequests).toContain('link: `/dashboard/orders/${args.orderId}`,');
    expect(count(orderRequests, 'link: `/dashboard/orders/${orderId}`,')).toBe(2);
  });
});
