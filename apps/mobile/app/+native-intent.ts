/**
 * Inbound deep-link path normalizer (expo-router's single choke point for
 * every incoming link — push-notification tap, universal link, custom
 * scheme). Push notifications carry the WEB path (e.g.
 * /dashboard/orders/{id}) because the same `notifications` row deep-links
 * the web app too. The mobile router uses short native routes
 * (/order/{id}, /item/{id}, /po/{id}). Without this rewrite an order
 * notification opened `stockpilot:///dashboard/orders/{id}`, which the
 * mobile router can't match → "Unmatched Route".
 *
 * Rewrite the known web paths here so the translation lives in ONE place
 * instead of being re-derived per call site. Anything else passes through
 * untouched. Must never throw — a failure here would break all deep links,
 * so we fall back to the original path on any error.
 */
const UUID = '([0-9a-fA-F-]{36})';

const REWRITES: Array<{ re: RegExp; to: (m: RegExpMatchArray) => string }> = [
  { re: new RegExp(`/dashboard/orders/${UUID}`), to: (m) => `/order/${m[1]}` },
  { re: new RegExp(`/dashboard/inventory/${UUID}`), to: (m) => `/item/${m[1]}` },
  { re: new RegExp(`/dashboard/purchase-orders/${UUID}`), to: (m) => `/po/${m[1]}` },
  // Schedule reminders link the web event page; mobile has only the list.
  { re: /\/dashboard\/schedule(\/.*)?$/, to: () => '/schedule' },
  // Web-only surfaces (briefing/insights) → the mobile inbox, where the
  // notification content already lives.
  { re: /\/dashboard\/insights$/, to: () => '/notifications' },
  // Catch-all LAST: any other /dashboard/* web path has no native twin —
  // land on home instead of the "Unmatched Route" dead end.
  { re: /^\/dashboard(\/.*)?$/, to: () => '/' },
];

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
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
