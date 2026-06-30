import * as WebBrowser from 'expo-web-browser';

import { api } from './api';

/**
 * connectZendesk — initiates the per-user Zendesk OAuth flow via an in-app
 * browser session. The backend generates a signed state + redirect URL;
 * on success/failure the app's deep-link scheme is used to return control.
 *
 * Always resolves (never throws):
 *   { ok: true }                       — connected successfully
 *   { ok: false, reason: 'cancelled' } — user dismissed the browser
 *   { ok: false, reason: 'failed' }    — OAuth completed but returned an error
 *   { ok: false, reason: 'unavailable' } — native module absent (old build) or
 *                                          network error fetching the start URL
 *
 * The `'stockpilot://zendesk'` redirect prefix matches BOTH:
 *   stockpilot://zendesk/connected  (success)
 *   stockpilot://zendesk/error      (failure)
 */
export async function connectZendesk(): Promise<{
  ok: boolean;
  reason?: 'cancelled' | 'failed' | 'unavailable';
}> {
  try {
    const { authorizeUrl } = await api<{ authorizeUrl: string }>(
      '/api/v1/zendesk/me/connect-url',
    );

    const result = await WebBrowser.openAuthSessionAsync(
      authorizeUrl,
      'stockpilot://zendesk',
    );

    if (result.type === 'success') {
      if (result.url.includes('/connected')) {
        return { ok: true };
      }
      // url contains /error or something else unexpected
      return { ok: false, reason: 'failed' };
    }

    // type === 'cancel' | 'dismiss' | anything else
    return { ok: false, reason: 'cancelled' };
  } catch {
    // Native module not linked (old build), network error, or any other failure.
    // Degrade gracefully — never crash.
    return { ok: false, reason: 'unavailable' };
  }
}
