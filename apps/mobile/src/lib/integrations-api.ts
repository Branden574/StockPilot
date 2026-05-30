import { api } from './api';

/**
 * Typed wrappers over the mobile `api()` client for the Integrations control
 * surface (Settings → Integrations). These mirror the web `ConnectionsService`
 * exports so the screen consumes exactly the GET shape the endpoint returns.
 *
 * SECRET INVARIANT: the connections list exposes status/realm/accountIds/health
 * only — never an OAuth token or a Vault secret handle. Connect is web-only
 * (no begin-connect wrapper here by design); mobile can monitor, disconnect,
 * and edit the account mapping.
 */

export type ConnectionStatus = 'pending' | 'active' | 'error' | 'disconnected';

export interface ConnectionView {
  id: string;
  providerId: string;
  status: ConnectionStatus;
  /** QBO realm id (a.k.a. company id) — surfaced as the connection "realm". */
  externalAccountId: string | null;
  /** Non-secret chart-of-accounts mapping handles. */
  accountIds: {
    billExpense?: string;
    inventoryAsset?: string;
    valuationOffset?: string;
  };
  lastConnectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export type SyncHealthStatus = 'pending' | 'success' | 'error' | 'dead';

export interface SyncHealthRow {
  topic: string;
  status: SyncHealthStatus;
  attempts: number;
  externalId: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ConnectionsListResult {
  connections: ConnectionView[];
  health: SyncHealthRow[];
}

export interface AccountMappingInput {
  billExpense: string;
  inventoryAsset: string;
  valuationOffset: string;
}

/** GET /api/v1/integrations/connections — list connections + recent sync health. */
export function getConnections(signal?: AbortSignal): Promise<ConnectionsListResult> {
  return api<ConnectionsListResult>('/api/v1/integrations/connections', { signal });
}

/** DELETE /api/v1/integrations/connections/<provider> — tears down the connection. */
export function disconnect(provider: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/v1/integrations/connections/${provider}`, {
    method: 'DELETE',
  });
}

/** POST /api/v1/integrations/connections/<provider>/account-mapping — saves the mapping. */
export function saveAccountMapping(
  provider: string,
  body: AccountMappingInput,
): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/v1/integrations/connections/${provider}/account-mapping`, {
    method: 'POST',
    body,
  });
}

/**
 * The mobile `api()` client throws `Error("API <status>: <body>")` on a non-2xx
 * response. The server is the source of truth for gating, so a 403 here means
 * the module is off or the user lacks `integrations:manage` — surface a friendly
 * inline message rather than the raw error text.
 */
export function isForbiddenError(err: unknown): boolean {
  return err instanceof Error && /^API 403\b/.test(err.message);
}
