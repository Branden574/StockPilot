import type { ModuleId } from '../modules/registry';

export type ConnectorMode = 'push' | 'pull' | 'bidi' | 'webhook';
export type ConnectorProviderId = 'quickbooks' | 'easypost'; // grows: 'amazon' | ...

export interface OutboxEvent {
  id: string;
  organizationId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  createdAt: string;
}

export interface ConnectionRef {
  id: string;
  organizationId: string;
  providerId: ConnectorProviderId;
  status: 'pending' | 'active' | 'error' | 'disconnected';
  externalAccountId: string | null;
  settings: Record<string, unknown>;
}

export interface ConnectorSecrets {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  [k: string]: unknown;
}

export interface PushResult {
  ok: boolean;
  externalId?: string;
  retryable?: boolean;
  error?: string;
}

/** Injected seam to the service layer so connectors stay unit-testable. */
export interface ConnectorDeps {
  /** SupabaseClient (service-role) — typed `unknown` here so core stays free of the supabase dep. */
  admin: unknown;
  fetch: typeof fetch;
  getMapping(
    connectionId: string,
    entityType: string,
    localId: string | null,
  ): Promise<{ externalId: string; externalMeta: Record<string, unknown> } | null>;
  putMapping(
    connectionId: string,
    organizationId: string,
    entityType: string,
    localId: string | null,
    externalId: string,
    externalMeta?: Record<string, unknown>,
  ): Promise<void>;
}

export interface Connector {
  readonly id: ConnectorProviderId;
  readonly modes: ConnectorMode[];
  readonly subscribedTopics: string[];
  handleOutboxEvent(
    event: OutboxEvent,
    conn: ConnectionRef,
    secrets: ConnectorSecrets,
    deps: ConnectorDeps,
  ): Promise<PushResult>;
  refreshAuth?(conn: ConnectionRef, secrets: ConnectorSecrets): Promise<ConnectorSecrets>;
  // YAGNI seams — unimplemented for QBO:
  scheduledPull?(conn: ConnectionRef, secrets: ConnectorSecrets, deps: ConnectorDeps): Promise<void>;
  verifyWebhook?(req: Request, conn: ConnectionRef, secrets: ConnectorSecrets): Promise<boolean>;
  handleWebhook?(
    req: Request,
    conn: ConnectionRef,
    secrets: ConnectorSecrets,
    deps: ConnectorDeps,
  ): Promise<void>;
}

export interface ConnectorMeta {
  id: ConnectorProviderId;
  title: string;
  modes: ConnectorMode[];
  subscribedTopics: string[];
  /** The module that must be enabled for this connector to operate (e.g. 'integrations'). */
  requiresModule: ModuleId;
  /** OAuth metadata. Optional — API-key/webhook-only connectors (e.g. EasyPost) omit it. */
  oauth?: { authorizeBase: string; scopes: string[] };
}
