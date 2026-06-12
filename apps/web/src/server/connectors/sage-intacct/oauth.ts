import 'server-only';

import { env } from '@/lib/env';

/**
 * Sage Intacct REST API v1 OAuth2 token lifecycle (code exchange + refresh).
 *
 * Mirrors the QuickBooks oauth helper: raw fetch, stateless, fetch-spy
 * testable. Intacct REST v1 (GA 2025 R1) issues 12-hour JWT access tokens
 * (`expires_in` = 43200) plus a refresh token when the `offline_access` scope
 * was requested on authorize. Client credentials are sent in the POST body
 * (client_secret_post), which Intacct's token endpoint accepts.
 *
 * ⚠ PENDING SANDBOX VERIFICATION: built from the published Intacct REST v1
 * docs; the owner's Web Services developer license (sender ID → sandbox
 * company) is required before this can be exercised end-to-end. Field names
 * below are the documented ones — verify on first sandbox run.
 *
 * SECRET INVARIANT: tokens are returned to the caller (the service-role
 * callback/drainer) and never logged. CLIENT_SECRET is read from env and never
 * surfaced in errors.
 */

const TOKEN_ENDPOINT = 'https://api.intacct.com/ia/api/v1/oauth2/token';

interface IntacctTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  /** Company context fields Intacct may include — captured when present. */
  companyId?: string;
  company_id?: string;
}

export interface IntacctExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  /** Intacct company id when the token response carries it; else null. */
  companyId: string | null;
}

export interface IntacctRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

function redirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/integrations/sage_intacct/callback`;
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/** POST the token endpoint; throws a token-free error on a non-OK response. */
async function postToken(body: URLSearchParams): Promise<IntacctTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    let detail = '';
    try {
      // Intacct error bodies carry error/error_description, never tokens.
      detail = (await res.text()).slice(0, 500);
    } catch {
      detail = '';
    }
    throw new Error(`Sage Intacct token request failed (status ${res.status}): ${detail}`);
  }

  return (await res.json()) as IntacctTokenResponse;
}

/** Exchange an authorization `code` for the initial token pair. */
export async function exchangeCode(code: string): Promise<IntacctExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: env.SAGE_INTACCT_CLIENT_ID,
    client_secret: env.SAGE_INTACCT_CLIENT_SECRET,
  });
  const token = await postToken(body);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiresAtFrom(token.expires_in),
    companyId: token.companyId ?? token.company_id ?? null,
  };
}

/**
 * Refresh an expiring access token. Persist the RETURNED refresh token — if
 * Intacct rotates it, reusing the old one fails the next refresh.
 */
export async function refreshTokens(refreshToken: string): Promise<IntacctRefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.SAGE_INTACCT_CLIENT_ID,
    client_secret: env.SAGE_INTACCT_CLIENT_SECRET,
  });
  const token = await postToken(body);
  return {
    accessToken: token.access_token,
    // Defensive: some providers omit refresh_token on refresh — keep the old one.
    refreshToken: token.refresh_token || refreshToken,
    expiresAt: expiresAtFrom(token.expires_in),
  };
}
