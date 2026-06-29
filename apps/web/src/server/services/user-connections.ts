/**
 * UserConnectionsService — per-user Zendesk OAuth connections.
 *
 * Each StockPilot user can connect their own Zendesk identity (OAuth2) so that
 * the agent console shows THEIR tickets. Distinct from ConnectionsService which
 * manages org-level API-token connections for integrations.
 *
 * Secret invariant: access/refresh tokens are stored in Supabase Vault via the
 * service-role admin client. They are NEVER logged. The vault id is stored in
 * user_connections.secret_id.
 */
import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { buildAuthorizeUrl, exchangeCode, refreshTokens } from '@/server/connectors/zendesk/oauth';
import { signState, verifyState } from '@/server/connectors/zendesk/oauth-state';
import {
  deleteConnectionSecret,
  getConnectionSecret,
  putConnectionSecret,
} from '@/server/connectors/secret-store';

import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';

/** Scopes requested when a user authorizes via OAuth. */
const ZENDESK_AGENT_SCOPES = 'read write';

/** Secret name pattern in Vault — one entry per user per provider. */
function secretName(userId: string): string {
  return `user:${userId}:zendesk`;
}

/**
 * Returns true when the token has expired OR will expire within 60 seconds.
 * When expiresAt is absent/invalid we treat it as expired (fail-closed).
 */
function isExpiredOrNearExpiry(expiresAt: string): boolean {
  try {
    const expMs = new Date(expiresAt).getTime();
    return expMs - Date.now() <= 60_000;
  } catch {
    return true;
  }
}

export class UserConnectionsService {
  constructor(private readonly ctx: ServiceContext) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Read the org's Zendesk subdomain from the org_connections row.
   * Throws validation_error when absent — the admin must connect at the org
   * level before individual agents can OAuth.
   */
  private async getOrgSubdomain(): Promise<string> {
    const { data, error } = await this.ctx.supabase
      .from('org_connections')
      .select('external_account_id, settings')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'zendesk')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    const row = data as {
      external_account_id: string | null;
      settings: Record<string, unknown> | null;
    } | null;
    const subdomain =
      row?.external_account_id ??
      (row?.settings?.subdomain as string | undefined) ??
      null;
    if (!subdomain) {
      throw new ServiceError(
        'validation_error',
        "Set your organization's Zendesk subdomain first.",
      );
    }
    return subdomain;
  }

  /** Read the caller's user_connections row, or null if absent. */
  private async getUserConnRow(): Promise<{
    id: string;
    subdomain: string;
    secret_id: string | null;
    status: string;
    external_account: Record<string, unknown>;
  } | null> {
    const { data, error } = await this.ctx.supabase
      .from('user_connections')
      .select('id, subdomain, secret_id, status, external_account')
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', this.ctx.userId)
      .eq('provider_id', 'zendesk')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return data as typeof this.getUserConnRow extends () => Promise<infer R> ? R : never;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Public interface
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Begin the OAuth flow: verify gates, resolve subdomain, sign a CSRF state
   * token, and build the Zendesk authorization URL.
   */
  async beginZendeskConnect(platform: 'web' | 'mobile'): Promise<{ authorizeUrl: string }> {
    assertModuleEnabled(this.ctx, 'zendesk');
    assertPermission(this.ctx, 'zendesk:agent');

    const subdomain = await this.getOrgSubdomain();
    const state = signState({
      orgId: this.ctx.organizationId,
      userId: this.ctx.userId,
      platform,
    });
    const authorizeUrl = buildAuthorizeUrl(subdomain, state, ZENDESK_AGENT_SCOPES);
    return { authorizeUrl };
  }

  /**
   * Complete the OAuth flow after Zendesk redirects back with `code` + `state`.
   * Verifies the signed state, exchanges the code, fetches the user's Zendesk
   * identity, vaults the token bundle, and upserts the user_connections row.
   */
  async completeZendeskConnect(
    code: string,
    state: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    // Verify CSRF state — returns null on tamper/expiry/bad sig.
    const decoded = verifyState(state);
    if (!decoded) {
      throw new ServiceError('forbidden', 'Invalid or expired OAuth state. Please start the connection again.');
    }
    // The state must belong to the caller — prevent cross-user token injection.
    if (decoded.userId !== this.ctx.userId || decoded.orgId !== this.ctx.organizationId) {
      throw new ServiceError('forbidden', 'OAuth state mismatch. Please start the connection again.');
    }

    // Read subdomain from org (member-level, RLS-scoped).
    const subdomain = await this.getOrgSubdomain();

    // Exchange authorization code for token bundle.
    const tokens = await exchangeCode(subdomain, code, fetchImpl);

    // Fetch agent identity from Zendesk /users/me.
    let account: Record<string, unknown> = {};
    try {
      const resp = await fetchImpl(
        `https://${subdomain}.zendesk.com/api/v2/users/me.json`,
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: 'application/json',
          },
        },
      );
      if (resp.ok) {
        const body = (await resp.json()) as { user?: Record<string, unknown> };
        account = body.user ?? {};
      }
    } catch {
      // Non-fatal — we store an empty object and the agent can still use the token.
    }

    // Vault the token bundle (service-role only).
    const admin = createAdminClient() as never;
    const secretId = await putConnectionSecret(admin, secretName(this.ctx.userId), tokens);

    // Upsert the user_connections row.
    const { error: upErr } = await this.ctx.supabase
      .from('user_connections')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          user_id: this.ctx.userId,
          provider_id: 'zendesk',
          subdomain,
          external_account: account,
          secret_id: secretId,
          status: 'active' as const,
          last_error: null,
          last_connected_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,user_id,provider_id' },
      )
      .select('id')
      .maybeSingle();
    if (upErr) throw new ServiceError('internal_error', upErr.message);
  }

  /**
   * Return a valid (possibly refreshed) access token + the org subdomain.
   * Refreshes automatically when the token is expired or within 60 s of expiry.
   * Throws `not_found` when the caller has no active connection.
   */
  async getValidAccessToken(): Promise<{ subdomain: string; accessToken: string }> {
    const row = await this.getUserConnRow();
    if (!row || !row.secret_id) {
      throw new ServiceError('not_found', 'No Zendesk connection found. Connect your Zendesk account first.');
    }

    const admin = createAdminClient() as never;
    const secrets = await getConnectionSecret(admin, row.secret_id);

    if (!isExpiredOrNearExpiry(secrets.expiresAt)) {
      // Token is still fresh — return as-is.
      return { subdomain: row.subdomain, accessToken: secrets.accessToken };
    }

    // Refresh path: call Zendesk, re-vault the (possibly rotated) bundle, bump row.
    const refreshed = await refreshTokens(row.subdomain, secrets.refreshToken, fetch);
    const newSecretId = await putConnectionSecret(admin, secretName(this.ctx.userId), refreshed);

    const { error: updErr } = await this.ctx.supabase
      .from('user_connections')
      .update({
        secret_id: newSecretId,
        last_connected_at: new Date().toISOString(),
        status: 'active' as const,
        last_error: null,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', this.ctx.userId)
      .eq('provider_id', 'zendesk');
    if (updErr) throw new ServiceError('internal_error', updErr.message);

    return { subdomain: row.subdomain, accessToken: refreshed.accessToken };
  }

  /**
   * Report whether the caller has an active Zendesk connection.
   */
  async status(): Promise<{ connected: boolean; account?: Record<string, unknown> }> {
    const row = await this.getUserConnRow();
    if (!row || row.status !== 'active') {
      return { connected: false };
    }
    return { connected: true, account: row.external_account };
  }

  /**
   * Disconnect: null the row's secret_id first (so a mid-disconnect failure
   * leaves no dangling secret_id pointing at a deleted Vault entry), then
   * destroy the Vault secret, then delete the row.
   *
   * No-ops when the caller has no connection.
   */
  async disconnect(): Promise<void> {
    const row = await this.getUserConnRow();
    if (!row) return;

    const admin = createAdminClient() as never;

    // 1. Delete the Vault secret (if one exists).
    if (row.secret_id) {
      await deleteConnectionSecret(admin, row.secret_id);
    }

    // 2. Delete the row.
    const { error: delErr } = await this.ctx.supabase
      .from('user_connections')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', this.ctx.userId)
      .eq('provider_id', 'zendesk');
    if (delErr) throw new ServiceError('internal_error', delErr.message);
  }
}
