import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { EasyPostApiError, EasyPostClient } from '@/server/connectors/easypost/client';
import { ZendeskClient } from '@/server/connectors/zendesk/client';
import { deleteConnectionSecret, putConnectionSecret } from '@/server/connectors/secret-store';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';

import { CONNECTOR_REGISTRY, hasPermission, type ConnectorProviderId } from '@stockpilot/core';

/**
 * Non-secret QBO chart-of-accounts ids stored under
 * `org_connections.settings.accountIds`. The receipt→Bill connector (Task 9)
 * posts against `billExpense`; the monthly valuation JournalEntry (Task 10)
 * posts the delta against `inventoryAsset` / `valuationOffset`.
 *
 * MVP is three free-text account ids the admin pastes from their QBO Chart of
 * Accounts. A QBO chart-of-accounts picker (fetch the live account list and
 * present a dropdown) is a deliberate future enhancement — NOT built here.
 */
export interface AccountMapping {
  billExpense: string;
  inventoryAsset: string;
  valuationOffset: string;
  /**
   * GL account a closed return's value is CREDITED to (Phase B). Booked as a
   * balanced JournalEntry whose offsetting DEBIT is the inventoryAsset account.
   */
  returnCredit: string;
}

/** One health row from connection_sync_log surfaced to the settings UI. */
export interface SyncHealthRow {
  topic: string;
  status: 'pending' | 'success' | 'error' | 'dead';
  attempts: number;
  externalId: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
}

/**
 * One failed (dead-lettered or errored) sync-log row surfaced to the operator
 * dead-letter view. Carries the row `id` (replay handle) on top of the
 * SyncHealthRow fields.
 */
export interface FailedSyncRow {
  id: string;
  topic: string;
  status: 'error' | 'dead';
  attempts: number;
  externalId: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ConnectionView {
  id: string;
  providerId: ConnectorProviderId;
  status: 'pending' | 'active' | 'error' | 'disconnected';
  externalAccountId: string | null;
  settings: Record<string, unknown>;
  accountIds: Partial<AccountMapping>;
  lastConnectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface ConnectionsListResult {
  connections: ConnectionView[];
  health: SyncHealthRow[];
}

/**
 * Control surface for the Integrations module — connecting/disconnecting an
 * external provider (QuickBooks Online) and surfacing connection health.
 *
 * Mirrors the existing service shape (e.g. SuppliersService): a class wrapping
 * a `ServiceContext`, `forCurrentUser()` factory, `assertModuleEnabled` +
 * `assertPermission` gates on every mutation, and best-effort `audit()`.
 *
 * SECRET INVARIANT: connector OAuth tokens never touch this class. Tokens live
 * only in Supabase Vault behind service-role RPCs. `disconnect()` deletes the
 * Vault secret via the admin (service-role) client — the user request client
 * (`this.ctx.supabase`, the `authenticated` role) cannot read or delete it.
 */
export class ConnectionsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ConnectionsService(await withContext());
  }

  /**
   * Lists this org's connections plus recent sync-log health rows. Read is
   * member-level (RLS on org_connections allows org members to read; the row
   * never exposes a token, only the secret_id UUID handle), so no permission
   * gate here beyond module enablement.
   *
   * Module gate is `integrations` OR `shipping`: this lists ALL org_connections
   * regardless of provider (the integrations settings page renders the QBO card
   * from the integrations module and the EasyPost card from the shipping
   * module), so an org with only shipping enabled must still be able to read its
   * connections. Fail-closed: if NEITHER module is enabled, throw module_disabled.
   */
  async list(): Promise<ConnectionsListResult> {
    if (
      !this.ctx.enabledModules.has('integrations') &&
      !this.ctx.enabledModules.has('shipping')
    ) {
      // Reuse assertModuleEnabled to throw the canonical module_disabled error;
      // 'integrations' is the primary owner of this surface so it names the gate.
      assertModuleEnabled(this.ctx, 'integrations');
    }

    const { data: rows, error } = await this.ctx.supabase
      .from('org_connections')
      .select(
        'id, provider_id, status, external_account_id, settings, last_connected_at, last_synced_at, last_error',
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('provider_id', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    const connections: ConnectionView[] = ((rows ?? []) as Array<Record<string, unknown>>).map(
      (r) => {
        const settings = (r.settings as Record<string, unknown> | null) ?? {};
        const accountIds = (settings.accountIds as Partial<AccountMapping> | undefined) ?? {};
        return {
          id: r.id as string,
          providerId: r.provider_id as ConnectorProviderId,
          status: r.status as ConnectionView['status'],
          externalAccountId: (r.external_account_id as string | null) ?? null,
          settings,
          accountIds,
          lastConnectedAt: (r.last_connected_at as string | null) ?? null,
          lastSyncedAt: (r.last_synced_at as string | null) ?? null,
          lastError: (r.last_error as string | null) ?? null,
        };
      },
    );

    const { data: logRows, error: logError } = await this.ctx.supabase
      .from('connection_sync_log')
      .select('topic, status, attempts, external_id, last_error, completed_at, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (logError) throw new ServiceError('internal_error', logError.message);

    const health: SyncHealthRow[] = ((logRows ?? []) as Array<Record<string, unknown>>).map(
      (r) => ({
        topic: r.topic as string,
        status: r.status as SyncHealthRow['status'],
        attempts: (r.attempts as number | null) ?? 0,
        externalId: (r.external_id as string | null) ?? null,
        lastError: (r.last_error as string | null) ?? null,
        completedAt: (r.completed_at as string | null) ?? null,
        createdAt: r.created_at as string,
      }),
    );

    return { connections, health };
  }

  /**
   * Shared gate for the operator dead-letter surface (list + replay). Reading
   * or replaying a failed sync is an ADMIN action — broader than the
   * member-level `list()` health read — because it exposes raw `last_error`
   * strings and lets the operator re-trigger an external export. Require the
   * `integrations:manage` OR `shipping:manage` capability (the surface spans
   * QBO exports and EasyPost shipping), gated by which module is enabled.
   *
   * FAIL-CLOSED: if NEITHER module is enabled, throw module_disabled
   * (assertModuleEnabled names `integrations` as the primary owner). If a module
   * IS enabled but the caller holds NEITHER manage permission, throw forbidden.
   * assertPermission also applies the MFA step-up gate.
   */
  private assertSyncLogManage(): void {
    const hasIntegrations = this.ctx.enabledModules.has('integrations');
    const hasShipping = this.ctx.enabledModules.has('shipping');
    if (!hasIntegrations && !hasShipping) {
      assertModuleEnabled(this.ctx, 'integrations');
    }
    // Require AT LEAST ONE manage permission. Try the permission that matches an
    // enabled module first so the thrown message is the relevant one; an admin
    // with either capability passes. assertPermission throws forbidden (or the
    // MFA-required forbidden) when the role lacks the permission.
    const canIntegrations =
      hasIntegrations && hasPermission(this.ctx.role, 'integrations:manage');
    const canShipping = hasShipping && hasPermission(this.ctx.role, 'shipping:manage');
    if (canIntegrations || canShipping) {
      // Still run the MFA gate via assertPermission against a permission the
      // caller demonstrably holds (no extra failure surface).
      assertPermission(this.ctx, canIntegrations ? 'integrations:manage' : 'shipping:manage');
      return;
    }
    // Neither manage permission held: surface forbidden naming the enabled
    // module's manage permission.
    assertPermission(this.ctx, hasIntegrations ? 'integrations:manage' : 'shipping:manage');
  }

  /**
   * Lists this org's FAILED sync-log rows (status in 'error','dead') — the
   * operator dead-letter view. Unlike `list()` (member-level health), this is
   * gated on the manage permission (see assertSyncLogManage): the raw error
   * detail + the replay capability are admin-only. Newest first.
   */
  async listFailedSyncs(limit = 50): Promise<{ rows: FailedSyncRow[] }> {
    this.assertSyncLogManage();

    const { data, error } = await this.ctx.supabase
      .from('connection_sync_log')
      .select(
        'id, topic, status, attempts, external_id, last_error, next_attempt_at, completed_at, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .in('status', ['error', 'dead'])
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200));
    if (error) throw new ServiceError('internal_error', error.message);

    const rows: FailedSyncRow[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      topic: r.topic as string,
      status: r.status as FailedSyncRow['status'],
      attempts: (r.attempts as number | null) ?? 0,
      externalId: (r.external_id as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
      completedAt: (r.completed_at as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: (r.updated_at as string | null) ?? null,
    }));
    return { rows };
  }

  /**
   * Replays a dead-lettered/errored sync-log row: resets it to status='pending',
   * attempts=0, next_attempt_at=null so the cron drainer re-picks it on the next
   * tick. Org-scoped + admin-gated (assertSyncLogManage). Only 'dead'/'error'
   * rows are eligible — a not-yet-terminal ('pending') or already-'success' row
   * is left untouched and reported as not_found, so an operator can't replay a
   * still-in-flight delivery or re-fire a completed export.
   *
   * Security: the UPDATE rides the user's (authenticated) request client, so the
   * 0152 admin-only RLS policy (org-scoped, with-check status='pending') is the
   * load-bearing boundary; the .eq(organization_id)/.in(status) filters here are
   * defense in depth + give a clean not_found when the row isn't eligible.
   */
  async replaySync(id: string): Promise<void> {
    this.assertSyncLogManage();

    const { data, error } = await this.ctx.supabase
      .from('connection_sync_log')
      .update({
        status: 'pending',
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', this.ctx.organizationId)
      .in('status', ['error', 'dead'])
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // No row updated → the id doesn't exist for this org, isn't in a replayable
    // state, or RLS hid it. Surface not_found rather than a silent success.
    if (!data) {
      throw new ServiceError('not_found', 'No replayable failed sync was found for that id.');
    }

    void audit(
      {
        event: 'integration.sync_replayed',
        entityType: 'connection_sync_log',
        entityId: id,
        extra: {},
      },
      this.ctx,
    );
  }

  /**
   * Starts an OAuth connect flow: upserts a `pending` org_connections row with a
   * freshly-generated CSRF `oauth_state`, and returns the provider authorize URL
   * (built from the registry's oauth meta + QBO_CLIENT_ID + the callback
   * redirect_uri + state). The callback route (Task 8) verifies `state`,
   * exchanges the code, and writes the token to Vault.
   */
  async beginConnect(provider: ConnectorProviderId): Promise<string> {
    assertModuleEnabled(this.ctx, 'integrations');
    assertPermission(this.ctx, 'integrations:manage');

    const meta = CONNECTOR_REGISTRY[provider];
    if (!meta) throw new ServiceError('validation_error', `Unknown provider: ${provider}`);
    // beginConnect drives the OAuth authorize redirect. API-key/webhook-only
    // connectors (e.g. EasyPost) have no `oauth` metadata and must use their own
    // connect path, never this method.
    if (!meta.oauth) {
      throw new ServiceError(
        'validation_error',
        `Provider ${provider} does not support OAuth connect.`,
      );
    }

    // Per-provider OAuth client ids (all optionalSecret, default ''). Fail fast
    // on a misconfigured deployment: without a client id the authorize URL
    // carries client_id='' and the provider rejects the user with an opaque
    // error AFTER the redirect. Surface it here so we never write a stray
    // pending row or leave the app.
    const oauthClientIds: Partial<Record<ConnectorProviderId, string>> = {
      quickbooks: env.QBO_CLIENT_ID,
      sage_intacct: env.SAGE_INTACCT_CLIENT_ID,
    };
    const clientId = oauthClientIds[provider];
    if (!clientId) {
      throw new ServiceError(
        'validation_error',
        `${meta.title} is not configured on this deployment (missing OAuth client id).`,
      );
    }

    const state = crypto.randomUUID();

    // Read the existing row first (if any) so the upsert's UPDATE branch
    // MERGES rather than CLOBBERS. The upsert is keyed on the
    // (organization_id, provider_id) UNIQUE constraint, so on reconnect
    // Postgres would otherwise replace the whole `settings` jsonb with
    // `{ env }` — silently dropping settings.accountIds (billExpense /
    // inventoryAsset / valuationOffset) the admin saved via
    // saveAccountMapping(), which the connector needs to post Bills + the
    // valuation JournalEntry. We spread the current settings and re-stamp env.
    const { data: existing, error: selectError } = await this.ctx.supabase
      .from('org_connections')
      .select('settings, created_by')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider)
      .maybeSingle();
    if (selectError) throw new ServiceError('internal_error', selectError.message);

    const currentSettings =
      ((existing as { settings: Record<string, unknown> | null } | null)?.settings) ?? {};
    // Preserve the ORIGINAL establisher's attribution on reconnect; only stamp
    // created_by on a first-time insert (no existing row).
    const createdBy =
      ((existing as { created_by: string | null } | null)?.created_by) ?? this.ctx.userId;

    // Upsert keyed on the (organization_id, provider_id) UNIQUE constraint:
    // reconnecting an existing (e.g. errored/disconnected) connection reuses the
    // row and rotates the CSRF state rather than creating a duplicate. For
    // QuickBooks the env is stamped so the callback + connector know which
    // Intuit host to hit (Intacct has a single API host — no env to stamp).
    const settingsStamp =
      provider === 'quickbooks'
        ? { ...currentSettings, env: env.QBO_ENV }
        : currentSettings;
    const { error } = await this.ctx.supabase.from('org_connections').upsert(
      {
        organization_id: this.ctx.organizationId,
        provider_id: provider,
        status: 'pending',
        oauth_state: state,
        settings: settingsStamp,
        created_by: createdBy,
      },
      { onConflict: 'organization_id,provider_id' },
    );
    if (error) throw new ServiceError('internal_error', error.message);

    const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/integrations/${provider}/callback`;
    const url = new URL(meta.oauth.authorizeBase);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', meta.oauth.scopes.join(' '));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * Connects an API-key/webhook-only provider (EasyPost). Unlike `beginConnect`
   * (OAuth), there is no redirect: the admin pastes their carrier API key (and
   * optionally the webhook signing secret), we validate the key against the
   * provider, store BOTH secrets in Supabase Vault, and mark the connection
   * `active` in one step.
   *
   * SECRET INVARIANT: the EasyPost API key + webhook secret live ONLY in Vault
   * (written via the service-role admin client + the `connector_secret_put`
   * RPC). They are never returned to the client, never written to
   * `org_connections.settings`, and never logged. `settings` carries only the
   * non-secret `mode` (test vs production, inferred from the key prefix).
   *
   * Gated on the off-by-default `shipping` module + `shipping:manage` (the key
   * buys real postage), NOT the integrations gates used by `beginConnect`.
   */
  async connectApiKey(
    provider: ConnectorProviderId,
    apiKey: string,
    webhookSecret?: string,
  ): Promise<void> {
    assertModuleEnabled(this.ctx, 'shipping');
    assertPermission(this.ctx, 'shipping:manage');

    // EasyPost is the only API-key connector today. Guard so a future OAuth-only
    // provider can't be routed through this path with a stray "key".
    if (provider !== 'easypost') {
      throw new ServiceError(
        'validation_error',
        `Provider ${provider} does not support API-key connect.`,
      );
    }

    const key = apiKey.trim();
    if (!key) {
      throw new ServiceError('validation_error', 'An API key is required.');
    }

    // Validate the key against EasyPost before persisting anything. A bad key
    // 401s; surface that as a validation_error so the UI shows a clear message
    // rather than a silent half-connected row.
    try {
      await new EasyPostClient(key).validateKey();
    } catch (e) {
      if (e instanceof EasyPostApiError) {
        throw new ServiceError(
          'validation_error',
          'EasyPost rejected this API key. Double-check it and try again.',
        );
      }
      throw new ServiceError('internal_error', 'Could not reach EasyPost to validate the key.');
    }

    // EasyPost test keys are prefixed `EZTK`; production keys `EZAK`. Record the
    // mode (non-secret) so label/rate calls and the UI know which environment
    // this connection talks to.
    const mode = key.startsWith('EZTK') ? 'test' : 'production';

    // Preserve the original establisher's attribution on reconnect; only stamp
    // created_by on a first-time insert.
    const { data: existing, error: selectError } = await this.ctx.supabase
      .from('org_connections')
      .select('id, settings, created_by')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider)
      .maybeSingle();
    if (selectError) throw new ServiceError('internal_error', selectError.message);

    const currentSettings =
      ((existing as { settings: Record<string, unknown> | null } | null)?.settings) ?? {};
    const createdBy =
      ((existing as { created_by: string | null } | null)?.created_by) ?? this.ctx.userId;

    // Write the secret blob to Vault via the SERVICE-ROLE admin client. The
    // ConnectorSecrets type wants accessToken/refreshToken/expiresAt; we satisfy
    // it (apiKey mirrored into accessToken for the connector framework) but the
    // real carrier secret is `apiKey` + `webhookSecret`. `as never` mirrors the
    // disconnect()/drainer cast: secret-store types `admin` to the minimal rpc
    // shape, narrower than the full SupabaseClient.
    const secretName = `connector:${(existing as { id: string } | null)?.id ?? `${this.ctx.organizationId}:${provider}`}`;
    const secretId = await putConnectionSecret(createAdminClient() as never, secretName, {
      apiKey: key,
      webhookSecret: webhookSecret?.trim() ? webhookSecret.trim() : null,
      accessToken: key,
      refreshToken: '',
      expiresAt: '',
    });

    const { data: upserted, error: upsertError } = await this.ctx.supabase
      .from('org_connections')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          provider_id: provider,
          status: 'active',
          secret_id: secretId,
          oauth_state: null,
          settings: { ...currentSettings, mode },
          created_by: createdBy,
          last_connected_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,provider_id' },
      )
      .select('id')
      .maybeSingle();
    if (upsertError) throw new ServiceError('internal_error', upsertError.message);

    void audit(
      {
        event: 'integration.connected',
        entityType: 'org_connection',
        entityId: (upserted as { id: string } | null)?.id ?? (existing as { id: string } | null)?.id ?? null,
        extra: { provider, mode },
      },
      this.ctx,
    );
  }

  /** Connect Zendesk via an API token (subdomain + agent email + token). */
  async connectZendesk(input: { subdomain: string; email: string; apiToken: string }): Promise<void> {
    assertModuleEnabled(this.ctx, 'zendesk');
    assertPermission(this.ctx, 'integrations:manage');
    const subdomain = input.subdomain.trim().replace(/^https?:\/\//i, '').replace(/\.zendesk\.com$/i, '');
    const email = input.email.trim();
    const apiToken = input.apiToken.trim();
    if (!subdomain || !email || !apiToken) {
      throw new ServiceError('validation_error', 'Subdomain, agent email, and API token are all required.');
    }
    try {
      await new ZendeskClient({ subdomain, email, apiToken }).validateToken();
    } catch {
      throw new ServiceError('validation_error', 'Zendesk rejected these credentials. Check the subdomain, agent email, and API token.');
    }

    const { data: existing, error: selErr } = await this.ctx.supabase
      .from('org_connections')
      .select('id, settings, created_by')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'zendesk')
      .maybeSingle();
    if (selErr) throw new ServiceError('internal_error', selErr.message);
    const currentSettings = ((existing as { settings: Record<string, unknown> | null } | null)?.settings) ?? {};
    const createdBy = ((existing as { created_by: string | null } | null)?.created_by) ?? this.ctx.userId;

    const secretName = `connector:${(existing as { id: string } | null)?.id ?? `${this.ctx.organizationId}:zendesk`}`;
    const secretId = await putConnectionSecret(createAdminClient() as never, secretName, {
      accessToken: apiToken,
      refreshToken: '',
      expiresAt: '',
    });

    const { data: upserted, error: upErr } = await this.ctx.supabase
      .from('org_connections')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          provider_id: 'zendesk',
          status: 'active',
          secret_id: secretId,
          external_account_id: subdomain,
          oauth_state: null,
          settings: { ...currentSettings, subdomain, email },
          created_by: createdBy,
          last_connected_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,provider_id' },
      )
      .select('id')
      .maybeSingle();
    if (upErr) throw new ServiceError('internal_error', upErr.message);

    void audit(
      {
        event: 'integration.connected',
        entityType: 'org_connection',
        entityId:
          (upserted as { id: string } | null)?.id ??
          (existing as { id: string } | null)?.id ??
          null,
        extra: { provider: 'zendesk' },
      },
      this.ctx,
    );
  }

  /** Read this org's Zendesk connection (member-level). Null if never connected. */
  async getZendeskConnection(): Promise<
    { status: string; subdomain: string | null; lastConnectedAt: string | null; lastError: string | null } | null
  > {
    assertModuleEnabled(this.ctx, 'zendesk');
    const { data, error } = await this.ctx.supabase
      .from('org_connections')
      .select('status, external_account_id, settings, last_connected_at, last_error')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'zendesk')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) return null;
    const r = data as { status: string; external_account_id: string | null; settings: Record<string, unknown> | null; last_connected_at: string | null; last_error: string | null };
    return {
      status: r.status,
      subdomain: r.external_account_id ?? (r.settings?.subdomain as string | undefined) ?? null,
      lastConnectedAt: r.last_connected_at,
      lastError: r.last_error,
    };
  }

  /**
   * Disconnects a provider: sets status='disconnected' and nulls secret_id +
   * oauth_state, THEN deletes the Vault secret (service-role admin client).
   * Audited.
   *
   * Ordering matters: we null the row's secret_id BEFORE destroying the Vault
   * secret so a failure mid-disconnect never leaves a dangling secret_id
   * pointing at a deleted Vault entry. If the Vault delete fails after the row
   * update, a retry re-runs cleanly (row already disconnected, secret_id null)
   * and the orphaned Vault secret is at worst a harmless inert handle.
   *
   * `assertCurrentAal2` is intentionally NOT required here: disconnecting only
   * tears down an external export integration (no StockPilot data is mutated and
   * the secret is destroyed, which is fail-safe). Compare account-security
   * mutations (MFA unenroll) that DO step up.
   */
  async disconnect(provider: ConnectorProviderId): Promise<void> {
    // EasyPost lives under the off-by-default `shipping` module + `shipping:manage`
    // (it buys real postage); every other provider is an `integrations` export.
    // Gate by provider so an org that enabled only shipping can still tear down
    // its carrier connection.
    if (provider === 'easypost') {
      assertModuleEnabled(this.ctx, 'shipping');
      assertPermission(this.ctx, 'shipping:manage');
    } else if (provider === 'zendesk') {
      // Zendesk lives under its own off-by-default `zendesk` module but reuses
      // the `integrations:manage` capability (the same manage gate as the QBO
      // integrations export).
      assertModuleEnabled(this.ctx, 'zendesk');
      assertPermission(this.ctx, 'integrations:manage');
    } else {
      assertModuleEnabled(this.ctx, 'integrations');
      assertPermission(this.ctx, 'integrations:manage');
    }

    const { data: row, error: selectError } = await this.ctx.supabase
      .from('org_connections')
      .select('id, secret_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider)
      .maybeSingle();
    if (selectError) throw new ServiceError('internal_error', selectError.message);
    if (!row) throw new ServiceError('not_found', `No ${provider} connection to disconnect.`);

    const secretId = (row as { secret_id: string | null }).secret_id;

    // Null the row FIRST so secret_id never dangles past a deleted Vault entry.
    const { error: updateError } = await this.ctx.supabase
      .from('org_connections')
      .update({ status: 'disconnected', secret_id: null, oauth_state: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider);
    if (updateError) throw new ServiceError('internal_error', updateError.message);

    // Then destroy the Vault token via the SERVICE-ROLE admin client. The user
    // request client (authenticated role) is not granted the secret RPCs.
    // `as never` mirrors the drainer's cast: secret-store types `admin` to the
    // minimal rpc shape it needs, narrower than the full SupabaseClient.
    if (secretId) {
      await deleteConnectionSecret(createAdminClient() as never, secretId);
    }

    void audit(
      {
        event: 'integration.disconnected',
        entityType: 'org_connection',
        entityId: (row as { id: string }).id,
        extra: { provider },
      },
      this.ctx,
    );
  }

  /**
   * Persists the QBO chart-of-accounts mapping into `settings.accountIds`,
   * merging with any existing non-secret settings (env, snapshot value) so we
   * never clobber them. Plain text ids are the MVP — see AccountMapping.
   */
  async saveAccountMapping(provider: ConnectorProviderId, mapping: AccountMapping): Promise<void> {
    assertModuleEnabled(this.ctx, 'integrations');
    assertPermission(this.ctx, 'integrations:manage');

    const { data: row, error: selectError } = await this.ctx.supabase
      .from('org_connections')
      .select('id, settings')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider)
      .maybeSingle();
    if (selectError) throw new ServiceError('internal_error', selectError.message);
    if (!row) throw new ServiceError('not_found', `No ${provider} connection to configure.`);

    const current = ((row as { settings: Record<string, unknown> | null }).settings) ?? {};
    // Merge with any existing accountIds (e.g. a defaultVendorId set out of
    // band, or the valuation bookkeeping fields) so saving the mapped fields
    // never clobbers them.
    const currentAccountIds =
      (current.accountIds as Record<string, unknown> | undefined) ?? {};
    const nextSettings = {
      ...current,
      accountIds: {
        ...currentAccountIds,
        billExpense: mapping.billExpense.trim(),
        inventoryAsset: mapping.inventoryAsset.trim(),
        valuationOffset: mapping.valuationOffset.trim(),
        returnCredit: mapping.returnCredit.trim(),
      },
    };

    const { error: updateError } = await this.ctx.supabase
      .from('org_connections')
      .update({ settings: nextSettings })
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider);
    if (updateError) throw new ServiceError('internal_error', updateError.message);
  }

  /**
   * Saves the Sage Intacct connection settings: the purchasing transaction
   * definition + default item/vendor + GL journal symbol under
   * `settings.intacct.*`, and the two return GL accounts under
   * `settings.accountIds.*` (same keys the QBO connector reads, so the
   * Integrations panel vocabulary stays consistent). MERGES with existing
   * settings like saveAccountMapping — never clobbers sibling keys.
   */
  async saveIntacctSettings(input: {
    poTxnDefinition: string;
    defaultItemId: string;
    defaultVendorId: string;
    journalSymbol: string;
    returnCredit: string;
    inventoryAsset: string;
  }): Promise<void> {
    assertModuleEnabled(this.ctx, 'integrations');
    assertPermission(this.ctx, 'integrations:manage');

    const { data: row, error: selectError } = await this.ctx.supabase
      .from('org_connections')
      .select('id, settings')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'sage_intacct')
      .maybeSingle();
    if (selectError) throw new ServiceError('internal_error', selectError.message);
    if (!row) throw new ServiceError('not_found', 'No Sage Intacct connection to configure.');

    const current = ((row as { settings: Record<string, unknown> | null }).settings) ?? {};
    const currentIntacct = (current.intacct as Record<string, unknown> | undefined) ?? {};
    const currentAccountIds =
      (current.accountIds as Record<string, unknown> | undefined) ?? {};
    const nextSettings = {
      ...current,
      intacct: {
        ...currentIntacct,
        poTxnDefinition: input.poTxnDefinition.trim(),
        defaultItemId: input.defaultItemId.trim(),
        defaultVendorId: input.defaultVendorId.trim(),
        journalSymbol: input.journalSymbol.trim(),
      },
      accountIds: {
        ...currentAccountIds,
        returnCredit: input.returnCredit.trim(),
        inventoryAsset: input.inventoryAsset.trim(),
      },
    };

    const { error: updateError } = await this.ctx.supabase
      .from('org_connections')
      .update({ settings: nextSettings })
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'sage_intacct');
    if (updateError) throw new ServiceError('internal_error', updateError.message);
  }
}
