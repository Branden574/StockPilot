/**
 * THE HOST THE APP TALKS TO: the web app's address, for its API requests
 * (api.ts) and for the web pages it links to (web-links.ts). Pure, so the
 * address a release build resolves is pinned by a test (web-links.test.ts).
 *
 * Resolved once at module load (api.ts) from three sources, accepting
 * localhost ONLY in development (`__DEV__`):
 *   1. Expo runtime config `extra.apiUrl` (set in app.config.ts at
 *      build time)
 *   2. EXPO_PUBLIC_API_URL inlined into the bundle
 *   3. localhost, only in development
 *
 * Without the development-only gate, a release build that forgot the env var
 * would ship with `http://localhost:3000` baked in and try to talk to the
 * developer's machine, or to a local dev server on the user's network.
 */

// Hardcoded production fallback. A release build/OTA must NEVER talk to
// localhost — this guards the OTA footgun where `eas update` is run WITHOUT
// EXPO_PUBLIC_API_URL set, so app.config.ts defaults extra.apiUrl to
// http://localhost:3000 and bakes it into the JS bundle. That broke every API
// call (and the scan→/orders/sign URL) on prod devices until republished.
export const PROD_API_FALLBACK = 'https://stockpilotusa.com';

export function resolveApiUrl(input: {
  fromExtra: string | undefined;
  fromEnv: string | undefined;
  dev: boolean;
}): string {
  const candidate = (input.fromExtra || input.fromEnv || '').trim();
  const isLocalhost = /\/\/(localhost|127\.0\.0\.1)/i.test(candidate);

  // In a release, a missing OR localhost candidate is a misconfiguration —
  // use the known prod host instead of poisoning the bundle with localhost.
  if (!input.dev && (!candidate || isLocalhost)) return PROD_API_FALLBACK;
  if (candidate.length > 0) return candidate;
  if (input.dev) return 'http://localhost:3000';
  return PROD_API_FALLBACK;
}
