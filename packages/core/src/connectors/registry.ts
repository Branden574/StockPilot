import type { ConnectorMeta, ConnectorProviderId } from './types';
export type { ConnectorProviderId } from './types';

export const CONNECTOR_REGISTRY: Record<ConnectorProviderId, ConnectorMeta> = {
  quickbooks: {
    id: 'quickbooks',
    title: 'QuickBooks Online',
    modes: ['push'],
    subscribedTopics: ['receipt.posted'],
    requiresModule: 'integrations',
    oauth: {
      authorizeBase: 'https://appcenter.intuit.com/connect/oauth2',
      scopes: ['com.intuit.quickbooks.accounting'],
    },
  },
};
