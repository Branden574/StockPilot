/**
 * SINGLE source of truth for web-path → native-route translation.
 * Used by BOTH deep-link entry points: app/+native-intent.ts (OS link opens)
 * and use-push-notifications.ts (in-app push tap handler). Notification
 * `link` values are WEB paths; every mobile navigation of one MUST go
 * through here — never a hand-rolled per-path if/else (two tables drifted
 * once already and shipped an "Unmatched Route" dead end).
 *
 * Rules: known pages → native twin; web-only pages → the inbox; any other
 * /dashboard/* → home. Non-/dashboard paths pass through untouched.
 */
import { bookReportNativePath } from './book-order-totals-link';

const UUID = '([0-9a-fA-F-]{36})';
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The native new-request form for a web /dashboard/maintenance/new link
 * (F1-5). Keeps only the two hints the phone's form reads from a link, and
 * only as well-formed uuids: `exceptionOccurrenceId` (the exception's
 * "Escalate to maintenance", whose form Save is still the explicit act, and
 * the server re-checks everything) and `locationId` (a related location).
 * Everything else in the query is dropped. Parsed by hand: React Native's
 * URLSearchParams has no working get().
 */
function maintenanceNewTarget(query: string | undefined): string {
  const kept: string[] = [];
  for (const pair of (query ?? '').replace(/^\?/, '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    if (key !== 'exceptionOccurrenceId' && key !== 'locationId') continue;
    if (kept.some((k) => k.startsWith(`${key}=`))) continue;
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      continue;
    }
    if (UUID_ONLY.test(value)) kept.push(`${key}=${value}`);
  }
  return kept.length ? `/maintenance/new?${kept.join('&')}` : '/maintenance/new';
}

const REWRITES: { re: RegExp; to: (m: RegExpMatchArray) => string }[] = [
  // Place an order (phone ordering PO-4): the web storefront's path, and the
  // web's "Start an order" links, open the native storefront. Above every
  // other orders rule: before it, the path fell through to home (warm) or
  // reached the order/[id] shim with id "new" (cold; audit D9). The query
  // (the web's ?warehouse= or a prefill) is dropped. The cold-start shim is
  // app/dashboard/orders/new.tsx.
  { re: /\/dashboard\/orders\/new(\?.*)?$/, to: () => '/order/new' },
  // Returns (RX-1) have native twins: the RMA workbench (app/returns/[id].tsx)
  // and the list (the drawer's Returns). Staff pushes carry the DUAL link
  // /dashboard/returns/<rma>?order=/dashboard/orders/<original> (returns plan
  // C-3), and rewriteWebPath answers the FIRST match. These two rules sit
  // ABOVE the unanchored orders rule on purpose: a bundle that has them opens
  // the RMA; every older bundle (no returns rule) matches the orders path
  // embedded in the query and opens the original order, never Home. Moving
  // them below the orders rule would send new bundles to the order too
  // (web-path-rewrite.returns.test.ts pins both tables). The cold-start shim is
  // app/dashboard/returns/[id].tsx.
  { re: new RegExp(`/dashboard/returns/${UUID}`), to: (m) => `/returns/${m[1]}` },
  { re: /\/dashboard\/returns(\?.*)?$/, to: () => '/returns' },
  { re: new RegExp(`/dashboard/orders/${UUID}`), to: (m) => `/order/${m[1]}` },
  // Staging has a native twin now. It must be matched BEFORE the generic
  // /dashboard/* catch-all (which would dead-end it on home) — and it sits
  // above the item-detail rule only for readability: 'staging' can never
  // satisfy the 36-char UUID pattern. Query (the ?type= filter) is dropped →
  // the full worklist.
  { re: /\/dashboard\/inventory\/staging(\?.*)?$/, to: () => '/staging' },
  { re: new RegExp(`/dashboard/inventory/${UUID}`), to: (m) => `/item/${m[1]}` },
  // The low/out-of-stock crossing trigger (0091 _notify_low_stock, still
  // attached via 0025's trg_inventory_items_low_stock) emits
  // '/dashboard/inventory?stock=out&type=all'. With no rule it hit the
  // catch-all and every stock-crossing push opened Home. The `$` after the
  // optional query means this can never swallow the /staging or /<uuid>
  // siblings above — but it stays BELOW them anyway, per this file's
  // ordering convention. Query (the stock/type filters) is dropped → the
  // full Items tab.
  { re: /\/dashboard\/inventory(\?.*)?$/, to: () => '/inventory' },
  { re: new RegExp(`/dashboard/purchase-orders/${UUID}`), to: (m) => `/po/${m[1]}` },
  // The auto-reorder and recurring-po crons notify with the BARE list path
  // '/dashboard/purchase-orders' (no id — they create N drafts at once), so
  // the /<uuid> rule above never matched and "Auto-reorder created 3 draft
  // POs" dead-ended on home. Must stay AFTER the /<uuid> rule so a real PO
  // id still opens the PO.
  { re: /\/dashboard\/purchase-orders(\?.*)?$/, to: () => '/purchase-orders' },
  // Cycle-count assignment (0042 trg_cycle_counts_assigned, still live) and
  // bundle shortage (0042 trg_bundle_distributions_shortage) both link to a
  // web detail page whose native twin already exists — app/cycle-count/[id].tsx
  // and app/bundles/[id].tsx. Without a rule the assigned counter tapped the
  // push and landed on Home instead of the count they were just given.
  // NOTE (cold start): on a COLD start expo-router hands the router the raw
  // web path WITHOUT calling +native-intent, so each needs an
  // `app/dashboard/<x>/[id].tsx` Redirect shim too, like orders/inventory/
  // purchase-orders. Cycle counts have one (app/dashboard/cycle-counts/[id].tsx);
  // bundles still do not, so a killed-app tap on a bundle alert shows
  // "Unmatched Route" (follow-up).
  { re: new RegExp(`/dashboard/cycle-counts/${UUID}`), to: (m) => `/cycle-count/${m[1]}` },
  { re: new RegExp(`/dashboard/bundles/${UUID}`), to: (m) => `/bundles/${m[1]}` },
  { re: /\/dashboard\/schedule(\/.*)?$/, to: () => '/schedule' },
  { re: /\/dashboard\/insights$/, to: () => '/notifications' },
  // Real native twins for the pages What's New CTAs (and some notifications)
  // link to — without these they fell through the catch-all to home.
  { re: /\/dashboard\/support(\/.*)?$/, to: () => '/support' },
  // Matches bare `/dashboard/orders` and `?status=…` (query dropped → the full
  // Orders list) but NOT `/dashboard/orders/<uuid>` (handled by the rule above).
  { re: /\/dashboard\/orders(\?.*)?$/, to: () => '/orders' },
  // Audit console: the web surface consolidated onto /dashboard/audit (old
  // /dashboard/admin/audit redirects there); the native twin stays at
  // /admin/audit. Query (filters) dropped → the full audit list.
  { re: /\/dashboard\/(admin\/)?audit(\?.*)?$/, to: () => '/admin/audit' },
  // Maintenance requests (Task 18): all THREE notification doors this
  // feature can link to (detail, the new-request form, and the list) need a
  // native twin here or they dead-end on home through the catch-all below —
  // detail before the bare-list rule so a request id is never mistaken for
  // the list route, 'new' before it for the same reason (though 'new' can
  // never satisfy the 36-char UUID pattern, so the order is for readability
  // only, matching the staging/item-detail precedent above). Query (the
  // ?scope= filter) is dropped → the full list.
  { re: new RegExp(`/dashboard/maintenance/${UUID}`), to: (m) => `/maintenance/${m[1]}` },
  // F1-5: the new-request link may carry a query (the exception's "Escalate
  // to maintenance" link is /dashboard/maintenance/new?exceptionOccurrenceId=
  // <uuid>). It fell through to home before; now it opens the form with the
  // hints the phone reads (maintenanceNewTarget).
  { re: /\/dashboard\/maintenance\/new(\?.*)?$/, to: (m) => maintenanceNewTarget(m[1]) },
  { re: /\/dashboard\/maintenance(\?.*)?$/, to: () => '/maintenance' },
  // Exceptions (F1-1) has native twins: the list and one occurrence. F1 sends
  // no push to either, but a What's New CTA, a shared link or a pasted URL
  // must still land on the screen instead of home. Detail before the bare
  // list so an occurrence id is never read as the list; both above the
  // catch-all. Query (the ?tab= filter) is dropped -> the Open list.
  { re: new RegExp(`/dashboard/exceptions/${UUID}`), to: (m) => `/exceptions/${m[1]}` },
  { re: /\/dashboard\/exceptions(\?.*)?$/, to: () => '/exceptions' },
  // Rentals (2026-09-25): one rental now has a native twin (app/rentals/[id].tsx).
  // This covers the paths that reach the app: links inside the app, push
  // taps, and stockpilot:// links (stockpilot:///dashboard/rentals/<id>).
  // It does NOT make the https://stockpilotusa.com links in rental emails
  // open the app: the iOS build declares no associated domains
  // (app.config.ts ios.associatedDomains) and the web serves no
  // apple-app-site-association file, so iOS opens those in Safari, on the
  // web rental page. Universal links need both plus a native build
  // (follow-up). Detail before the bare list; 'new' can never satisfy the
  // UUID pattern. Rental ITEM pages (/dashboard/rentals/items/...) have no
  // rule and still open home. Query (the ?status= filter) is dropped -> the
  // full list.
  { re: new RegExp(`/dashboard/rentals/${UUID}`), to: (m) => `/rentals/${m[1]}` },
  { re: /\/dashboard\/rentals\/new$/, to: () => '/rentals/new' },
  { re: /\/dashboard\/rentals(\?.*)?$/, to: () => '/rentals' },
  // Locations (F1-3): one location has a native twin (app/location/[id].tsx,
  // "last physical count" for every item held there), and the list is the
  // drawer's Locations screen. A What's New CTA, a shared link or a pasted
  // URL must land on the screen instead of home. Detail before the bare list
  // so a location id is never read as the list; the native detail route is
  // SINGULAR (/location/<id>), the list plural. Query (the web page's ?page=
  // or tab) is dropped. No push links here yet, so no cold-start shim under
  // app/dashboard/ (see the cycle-count note above).
  { re: new RegExp(`/dashboard/locations/${UUID}`), to: (m) => `/location/${m[1]}` },
  { re: /\/dashboard\/locations(\?.*)?$/, to: () => '/locations' },
  // Book Order Totals has a native twin (app/reports/book-order-totals).
  // Its filters ride along, but only the keys core's parseBookReportQuery
  // accepts (bookReportNativePath drops the rest, and the web's warehouse
  // view label). Before the bare Reports rule, which the `$` keeps from
  // swallowing it anyway. Other report pages (/dashboard/reports/<slug>) have
  // no native twin and still fall through to home. The cold-start shim is
  // app/dashboard/reports/book-order-totals.tsx.
  { re: /\/dashboard\/reports\/book-order-totals(\?.*)?$/, to: (m) => bookReportNativePath(m[1]) },
  { re: /\/dashboard\/reports(\?.*)?$/, to: () => '/reports' },
  { re: /^\/dashboard(\/.*)?$/, to: () => '/' },
];

export function rewriteWebPath(path: string): string {
  try {
    for (const { re, to } of REWRITES) {
      const m = path.match(re);
      if (m) return to(m);
    }
    return path;
  } catch {
    return path;
  }
}
