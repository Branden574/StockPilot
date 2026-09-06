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
const UUID = '([0-9a-fA-F-]{36})';

const REWRITES: { re: RegExp; to: (m: RegExpMatchArray) => string }[] = [
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
  // NOTE (cold start): these two still lack the `app/dashboard/<x>/[id].tsx`
  // Redirect shim that orders/inventory/purchase-orders have. On a COLD start
  // expo-router hands the router the raw web path WITHOUT calling
  // +native-intent, so a killed-app tap on these two shows "Unmatched Route".
  // This rewrite fixes the warm/in-app tap; the shims are a follow-up.
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
  { re: /\/dashboard\/maintenance\/new$/, to: () => '/maintenance/new' },
  { re: /\/dashboard\/maintenance(\?.*)?$/, to: () => '/maintenance' },
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
