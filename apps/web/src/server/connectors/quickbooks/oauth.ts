import 'server-only';

import { env } from '@/lib/env';

/**
 * QuickBooks Online OAuth2 token lifecycle (code exchange + refresh). One-way
 * export only — these helpers only ever obtain/rotate tokens so the connector
 * can PUSH StockPilot data into QBO; nothing here reads QBO data back into
 * StockPilot. (The authorize URL is built registry-generically by
 * ConnectionsService.beginConnect, not here.)
 *
 * Implemented with raw `fetch` rather than the Intuit OAuth SDK: the token
 * operations are plain HTTP (two form-encoded POSTs to the Intuit token
 * endpoint), and the SHARED CONSTRAINTS + plan explicitly allow a raw-fetch
 * fallback. Raw fetch keeps these helpers stateless (the SDK client retains the
 * token on its instance) which matters for the SECRET INVARIANT, and makes them
 * trivially testable with a fetch spy.
 *
 * SECRET INVARIANT: tokens are returned to the caller (the service-role
 * callback/drainer) and never logged. The HTTP Basic header is built from
 * QBO_CLIENT_ID/QBO_CLIENT_SECRET and never surfaced in errors.
 */

// Intuit's OAuth2 token endpoint is the same host for sandbox and production;
// the sandbox vs production distinction only affects the Accounting API host
// (see client.ts), not the token exchange.
const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/** Shape of a successful Intuit token response (auth-code and refresh grants). */
interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
}

export interface ExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  realmId: string;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/** Callback redirect URI registered with the Intuit app. */
function redirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/integrations/quickbooks/callback`;
}

/** HTTP Basic `client_id:client_secret` header value. Never logged. */
function basicAuthHeader(): string {
  const encoded = Buffer.from(
    `${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`,
  ).toString('base64');
  return `Basic ${encoded}`;
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * POST the Intuit token endpoint with the result body for inspection. Throws
 * on a non-OK response with status + the intuit_tid header (never the tokens).
 */
async function postToken(body: URLSearchParams): Promise<IntuitTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const tid = res.headers.get('intuit_tid') ?? 'unknown';
    let detail = '';
    try {
      const text = await res.text();
      // Intuit error bodies carry only `error`/`error_description`, never the
      // tokens, so this is safe to surface.
      detail = text.slice(0, 500);
    } catch {
      detail = '';
    }
    throw new Error(
      `QuickBooks token request failed (status ${res.status}, intuit_tid=${tid}): ${detail}`,
    );
  }

  return (await res.json()) as IntuitTokenResponse;
}

/**
 * Exchange an authorization `code` (and the `realmId` captured from the
 * callback) for the initial token pair. `expiresAt` is derived from
 * `expires_in`.
 */
export async function exchangeCode(code: string, realmId: string): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  const token = await postToken(body);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresAtFrom(token.expires_in),
    realmId,
  };
}

/**
 * Refresh an expiring access token. Intuit ROTATES the refresh token on (most)
 * refreshes — this returns the NEW `refresh_token` from the response, never the
 * one passed in, so the caller persists the rotated value to Vault.
 */
export async function refreshTokens(refreshToken: string): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const token = await postToken(body);
  return {
    accessToken: token.access_token,
    // The rotated refresh token — Intuit may return the same value, but when it
    // rotates we MUST persist the new one or the next refresh fails.
    refreshToken: token.refresh_token,
    expiresAt: expiresAtFrom(token.expires_in),
  };
}
