/**
 * Inbound OS link path normalizer: expo-router hands every link the
 * operating system opens the app with to redirectSystemPath, the launch URL
 * included (getLinkingConfig passes it through with initial: true). Today
 * that is a stockpilot:// link; a universal link would come through here too
 * once the app declares associated domains. A link in the web form
 * (stockpilot:///dashboard/orders/{id}: the web app's paths, which
 * notification rows use too) is rewritten to the short native route
 * (/order/{id}, /item/{id}, /po/{id}); without that it opened a path the
 * mobile router can't match → "Unmatched Route".
 *
 * A tapped push notification does NOT come through here: it never reaches
 * the router as a URL. notification-intent.ts captures the tap,
 * notification-link.ts parses its link with the same table, and
 * NotificationIntentHost opens it inside the app with router.push.
 *
 * The translation lives in ONE place (web-path-rewrite.ts) instead of being
 * re-derived per call site. Anything else passes through untouched. Must
 * never throw — a failure here would break all deep links, so rewriteWebPath
 * falls back to the original path on any error.
 */
import { rewriteWebPath } from '@/lib/web-path-rewrite';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return rewriteWebPath(path);
}
