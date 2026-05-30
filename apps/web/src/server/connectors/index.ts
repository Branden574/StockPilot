import type { Connector, ConnectorProviderId } from '@stockpilot/core';

import { quickbooksConnector } from './quickbooks';

/**
 * Connector implementation registry, keyed by provider id. `Partial` so the
 * drainer simply skips any provider with no implementation yet (see runDrain in
 * ./drainer). The QuickBooks connector (push-only receipt → Bill export) is
 * registered here by Task 9.
 */
export const CONNECTORS: Partial<Record<ConnectorProviderId, Connector>> = {
  quickbooks: quickbooksConnector,
};
