import type { ConnectorMeta, ConnectorProviderId } from './types';
export type { ConnectorProviderId } from './types';

export const CONNECTOR_REGISTRY: Record<ConnectorProviderId, ConnectorMeta> = {
  quickbooks: {
    id: 'quickbooks',
    title: 'QuickBooks Online',
    modes: ['push'],
    subscribedTopics: ['receipt.posted', 'return.closed'],
    requiresModule: 'integrations',
    oauth: {
      authorizeBase: 'https://appcenter.intuit.com/connect/oauth2',
      scopes: ['com.intuit.quickbooks.accounting'],
    },
  },
  easypost: {
    id: 'easypost',
    title: 'EasyPost',
    // Webhook-only: we push label requests via the REST client (not the outbox)
    // and receive tracking updates via the EasyPost webhook. No OAuth — auth is
    // an API key stored in Vault. No outbox topics subscribed.
    modes: ['webhook'],
    subscribedTopics: [],
    requiresModule: 'shipping',
  },
  zendesk: {
    id: 'zendesk',
    title: 'Zendesk',
    // Push-only: create tickets from outbox events via the REST client.
    // Inbound webhooks (ticket sync) are Phase 2. Auth = an API token in Vault.
    modes: ['push'],
    subscribedTopics: ['return.created', 'public_request.created', 'order.problem'],
    requiresModule: 'zendesk',
  },
  sage_intacct: {
    id: 'sage_intacct',
    title: 'Sage Intacct',
    // Push only (PO + return value, mirroring QuickBooks). The "migrate from
    // Intacct" item/stock import is NOT a connector pull — it runs in a user
    // context via apps/web services/intacct-import.ts (ledger-correct creates,
    // permission-gated); add 'pull' here only alongside a real scheduledPull.
    // Built against the Intacct REST API v1 (GA 2025 R1); requires a Sage Web
    // Services developer license (sender ID) before the OAuth app exists —
    // SAGE_INTACCT_CLIENT_ID stays unset until the owner buys it.
    modes: ['push'],
    subscribedTopics: ['purchase_order.ordered', 'return.closed'],
    requiresModule: 'integrations',
    oauth: {
      authorizeBase: 'https://api.intacct.com/ia/api/v1/oauth2/authorize',
      // offline_access yields the refresh token (12h JWTs otherwise).
      scopes: ['offline_access'],
    },
  },
};
