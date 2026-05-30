import { describe, expect, it } from 'vitest';
import { CONNECTOR_REGISTRY, type ConnectorProviderId } from './registry';

describe('CONNECTOR_REGISTRY', () => {
  it('every entry id matches its key and declares ≥1 mode + requiresModule integrations', () => {
    for (const [key, def] of Object.entries(CONNECTOR_REGISTRY)) {
      expect(def.id).toBe(key);
      expect(def.modes.length).toBeGreaterThan(0);
      expect(def.requiresModule).toBe('integrations');
    }
  });
  it('quickbooks is push + subscribes to receipt.posted', () => {
    const qbo = CONNECTOR_REGISTRY['quickbooks' as ConnectorProviderId];
    expect(qbo.modes).toContain('push');
    expect(qbo.subscribedTopics).toContain('receipt.posted');
  });
});
