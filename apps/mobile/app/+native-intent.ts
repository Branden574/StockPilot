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
import { rewriteWebPath } from '@/lib/web-path-rewrite';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return rewriteWebPath(path);
}
