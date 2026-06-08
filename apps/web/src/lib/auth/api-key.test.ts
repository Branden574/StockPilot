import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generateApiKey, hasScope, hashApiKey } from './api-key';

describe('hashApiKey', () => {
  it('is a deterministic sha256 hex', () => {
    expect(hashApiKey('sk_live_abc')).toBe(hashApiKey('sk_live_abc'));
    expect(hashApiKey('sk_live_abc')).toBe(
      createHash('sha256').update('sk_live_abc').digest('hex'),
    );
    expect(hashApiKey('sk_live_abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateApiKey', () => {
  it('mints a prefixed key whose stored hash matches and prefix is display-only', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(prefix).toBe(key.slice(0, 16));
    expect(hash).toBe(hashApiKey(key));
    // the prefix alone can't reconstruct the key or its hash
    expect(hashApiKey(prefix)).not.toBe(hash);
  });

  it('is unique per call', () => {
    expect(generateApiKey().key).not.toBe(generateApiKey().key);
  });
});

describe('hasScope', () => {
  const ctx = { organizationId: 'o', keyId: 'k', scopes: ['inventory:read', 'orders:read'] };
  it('matches granted scopes only', () => {
    expect(hasScope(ctx, 'inventory:read')).toBe(true);
    expect(hasScope(ctx, 'inventory:write')).toBe(false);
  });
});
