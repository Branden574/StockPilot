/**
 * Zendesk per-user OAuth2 helpers (authorize URL + code exchange + token
 * refresh). Built for the agent console feature: each support agent connects
 * their own Zendesk identity, so tokens are per-user rather than per-org.
 *
 * Implemented with raw `fetch` to stay stateless (no SDK client retaining
 * token state) and to make the helpers trivially testable with a fetch spy.
 *
 * SECRET INVARIANT: tokens are returned to the caller and never logged. The
 * client_id/client_secret are sent in the POST body per Zendesk's OAuth2 spec
 * (Zendesk does not use HTTP Basic for token exchange, unlike Intuit).
 */
import 'server-only';

import { env } from '@/lib/env';

/** Zendesk subdomain: DNS label only — prevents host injection / SSRF. */
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
function assertSubdomain(s: string): void {
  if (!SUBDOMAIN_RE.test(s)) throw new Error('Invalid Zendesk subdomain');
}

/** Redirect URI registered in the Zendesk OAuth app. */
function redirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/v1/zendesk/oauth/callback`;
}

/** Derive an ISO-8601 expiry timestamp from `expires_in` seconds. */
function expiresAtFrom(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}

/** Shape of a successful Zendesk token response. */
interface TokenResp {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
}

/**
 * POST to the Zendesk token endpoint. Credentials go in the JSON body as
 * Zendesk's spec requires (not HTTP Basic). Throws on a non-OK response with
 * the HTTP status — never logs the token values.
 */
async function postToken(
  subdomain: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResp> {
  assertSubdomain(subdomain);
  const res = await fetchImpl(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      ...body,
      client_id: env.ZENDESK_OAUTH_CLIENT_ID ?? '',
      client_secret: env.ZENDESK_OAUTH_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) {
    // Never log the response body — it may echo client_secret in some error flows.
    throw new Error(`Zendesk token request failed (status ${res.status})`);
  }
  return (await res.json()) as TokenResp;
}

/**
 * Build the Zendesk OAuth2 authorization URL for the given org subdomain.
 * The caller supplies a CSRF `state` and the required OAuth scopes.
 */
export function buildAuthorizeUrl(subdomain: string, state: string, scopes: string): string {
  assertSubdomain(subdomain);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.ZENDESK_OAUTH_CLIENT_ID ?? '',
    redirect_uri: redirectUri(),
    scope: scopes,
    state,
  });
  return `https://${subdomain}.zendesk.com/oauth/authorizations/new?${q.toString()}`;
}

/**
 * Exchange an authorization `code` for the initial token pair.
 * `expiresAt` is derived from `expires_in`.
 */
export async function exchangeCode(
  subdomain: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const t = await postToken(
    subdomain,
    { grant_type: 'authorization_code', code },
    fetchImpl,
  );
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? '',
    expiresAt: expiresAtFrom(t.expires_in),
  };
}

/**
 * Refresh an expiring access token. Zendesk MAY rotate the refresh token on
 * each call — this returns the new value when present, falling back to the
 * supplied `refreshToken` when the response omits it.
 */
export async function refreshTokens(
  subdomain: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const t = await postToken(
    subdomain,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchImpl,
  );
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? refreshToken,
    expiresAt: expiresAtFrom(t.expires_in),
  };
}
