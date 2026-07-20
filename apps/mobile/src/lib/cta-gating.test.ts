import { describe, expect, it } from 'vitest';

import type { Permission } from '@stockpilot/core';

import { showWriteCta } from './cta-gating';

describe('showWriteCta', () => {
  it('perms not loaded (undefined) → show, matching current behavior', () => {
    expect(showWriteCta(undefined, 'stock:adjust')).toBe(true);
    expect(showWriteCta(undefined, 'schedule:manage')).toBe(true);
  });

  it('loaded set holding the permission → show', () => {
    const perms = new Set<Permission>(['stock:adjust']);
    expect(showWriteCta(perms, 'stock:adjust')).toBe(true);
  });

  it('loaded set lacking the permission → hide', () => {
    const perms = new Set<Permission>(['items:read']);
    expect(showWriteCta(perms, 'stock:adjust')).toBe(false);
    expect(showWriteCta(perms, 'schedule:manage')).toBe(false);
  });

  it('empty loaded set hides write CTAs (viewer with zero grants)', () => {
    expect(showWriteCta(new Set<Permission>(), 'stock:adjust')).toBe(false);
  });
});
