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
 * The MFA gate's two refusals, in the phone's words. The server runs the gate
 * before the permission check on the mapping save and the disconnect
 * (assertPermission, mfaGateError) and answers 403 with details.reason:
 * `aal2_required` when the account has a verified factor and this session did
 * not sign in with it, `mfa_required` when the organization requires a factor
 * the account has not set up. Neither is a refusal of access: the owner or
 * admin keeps the screen and is told what to do. The phone has no in-place
 * step-up (a session reaches AAL2 only at sign-in), so the instruction is the
 * one the item screen's adjustment, the escalation and the book report give.
 */
export const INTEGRATIONS_AAL2_REQUIRED =
  'Your account uses an authenticator app, and this session did not sign in with it. Sign out and sign back in with your code, then try again. Nothing was changed.';
export const INTEGRATIONS_MFA_REQUIRED =
  'Your organization requires two-factor authentication. Set it up on the web, then sign in again. Nothing was changed.';

/** The MFA gate's reason on a 403 api() threw, or null for any other failure. */
function mfaGateReason(err: unknown): 'aal2_required' | 'mfa_required' | null {
  if (!(err instanceof Error) || (err as { status?: unknown }).status !== 403) return null;
  const details = (err as { details?: unknown }).details;
  const reason =
    details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
  return reason === 'aal2_required' || reason === 'mfa_required' ? reason : null;
}

/** The sentence for the MFA gate's refusal (above), or null when it is not one. */
export function integrationsMfaSentence(err: unknown): string | null {
  const reason = mfaGateReason(err);
  if (reason === 'aal2_required') return INTEGRATIONS_AAL2_REQUIRED;
  if (reason === 'mfa_required') return INTEGRATIONS_MFA_REQUIRED;
  return null;
}

/**
 * Whether the server refused the request with a 403. The server is the source
 * of truth for gating, so a 403 here means the module is off or the user lacks
 * `integrations:manage`: the screen shows its own Access denied state rather
 * than the raw server sentence. The MFA gate's 403 is not one of these
 * (integrationsMfaSentence): told "ask an admin", an owner or admin who only
 * had to sign in again with their code lost the screen (docket B10 review).
 *
 * Read from the status api() puts on its ApiError, never from the message: the
 * message is the server's sentence. This used to test the message for
 * "API 403", the text api() threw before its errors were typed (2026-07-31),
 * so no refusal matched and the Access denied state never showed (docket B10).
 */
export function isForbiddenError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { status?: unknown }).status === 403 &&
    mfaGateReason(err) === null
  );
}
