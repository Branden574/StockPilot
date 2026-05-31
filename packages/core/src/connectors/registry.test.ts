import { describe, expect, it } from 'vitest';
import { CONNECTOR_REGISTRY, type ConnectorProviderId } from './registry';

describe('CONNECTOR_REGISTRY', () => {
  it('every entry id matches its key, declares ≥1 mode + a requiresModule', () => {
    for (const [key, def] of Object.entries(CONNECTOR_REGISTRY)) {
      expect(def.id).toBe(key);
      expect(def.modes.length).toBeGreaterThan(0);
      expect(def.requiresModule).toBeTruthy();
    }
  });
  it('quickbooks is push + subscribes to receipt.posted + requires integrations + has oauth', () => {
    const qbo = CONNECTOR_REGISTRY['quickbooks' as ConnectorProviderId];
    expect(qbo.modes).toContain('push');
    expect(qbo.subscribedTopics).toContain('receipt.posted');
    expect(qbo.requiresModule).toBe('integrations');
    expect(qbo.oauth).toBeDefined();
  });
  it('easypost is webhook-only, requires the shipping module, and has no oauth', () => {
    const ep = CONNECTOR_REGISTRY['easypost' as ConnectorProviderId];
    expect(ep).toBeDefined();
    expect(ep.modes).toContain('webhook');
    expect(ep.requiresModule).toBe('shipping');
    expect(ep.subscribedTopics).toEqual([]);
    expect(ep.oauth).toBeUndefined();
  });
});
