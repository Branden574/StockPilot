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

const REWRITES: Array<{ re: RegExp; to: (id: string) => string }> = [
  { re: new RegExp(`/dashboard/orders/${UUID}`), to: (id) => `/order/${id}` },
  { re: new RegExp(`/dashboard/inventory/${UUID}`), to: (id) => `/item/${id}` },
  { re: new RegExp(`/dashboard/purchase-orders/${UUID}`), to: (id) => `/po/${id}` },
];

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    for (const { re, to } of REWRITES) {
      const m = path.match(re);
      if (m?.[1]) return to(m[1]);
    }
    return path;
  } catch {
    return path;
  }
}
