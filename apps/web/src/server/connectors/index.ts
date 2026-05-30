import type { Connector, ConnectorProviderId } from '@stockpilot/core';

/**
 * Connector implementation registry, keyed by provider id. Empty until Task 9
 * wires the QuickBooks connector. `Partial` so the drainer simply skips any
 * provider with no implementation yet (see runDrain in ./drainer).
 */
export const CONNECTORS: Partial<Record<ConnectorProviderId, Connector>> = {};
