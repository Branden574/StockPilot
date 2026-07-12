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
  { re: new RegExp(`/dashboard/inventory/${UUID}`), to: (m) => `/item/${m[1]}` },
  { re: new RegExp(`/dashboard/purchase-orders/${UUID}`), to: (m) => `/po/${m[1]}` },
  { re: /\/dashboard\/schedule(\/.*)?$/, to: () => '/schedule' },
  { re: /\/dashboard\/insights$/, to: () => '/notifications' },
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
