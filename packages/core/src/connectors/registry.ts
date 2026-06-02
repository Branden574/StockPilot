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
};
