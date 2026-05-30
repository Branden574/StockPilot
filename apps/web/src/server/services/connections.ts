import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { deleteConnectionSecret } from '@/server/connectors/secret-store';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';

import { CONNECTOR_REGISTRY, type ConnectorProviderId } from '@stockpilot/core';

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
   */
  async list(): Promise<ConnectionsListResult> {
    assertModuleEnabled(this.ctx, 'integrations');

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

    // Fail fast on a misconfigured deployment: QBO_CLIENT_ID is optionalSecret
    // (defaults to ''). Without it the authorize URL carries client_id='' and
    // Intuit rejects the user with an opaque error AFTER the redirect. Surface
    // it here so we never write a stray pending row or leave the app.
    if (!env.QBO_CLIENT_ID) {
      throw new ServiceError(
        'validation_error',
        'QuickBooks is not configured on this deployment (missing QBO_CLIENT_ID).',
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
    // row and rotates the CSRF state rather than creating a duplicate. The env
    // is stamped so the callback + connector know which Intuit host to hit.
    const { error } = await this.ctx.supabase.from('org_connections').upsert(
      {
        organization_id: this.ctx.organizationId,
        provider_id: provider,
        status: 'pending',
        oauth_state: state,
        settings: { ...currentSettings, env: env.QBO_ENV },
        created_by: createdBy,
      },
      { onConflict: 'organization_id,provider_id' },
    );
    if (error) throw new ServiceError('internal_error', error.message);

    const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/integrations/${provider}/callback`;
    const url = new URL(meta.oauth.authorizeBase);
    url.searchParams.set('client_id', env.QBO_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', meta.oauth.scopes.join(' '));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
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
    assertModuleEnabled(this.ctx, 'integrations');
    assertPermission(this.ctx, 'integrations:manage');

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
    const nextSettings = {
      ...current,
      accountIds: {
        billExpense: mapping.billExpense.trim(),
        inventoryAsset: mapping.inventoryAsset.trim(),
        valuationOffset: mapping.valuationOffset.trim(),
      },
    };

    const { error: updateError } = await this.ctx.supabase
      .from('org_connections')
      .update({ settings: nextSettings })
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', provider);
    if (updateError) throw new ServiceError('internal_error', updateError.message);
  }
}
