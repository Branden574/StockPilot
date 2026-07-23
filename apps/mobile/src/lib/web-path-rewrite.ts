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
  { re: new RegExp(`/dashboard/purchase-orders/${UUID}`), to: (m) => `/po/${m[1]}` },
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
