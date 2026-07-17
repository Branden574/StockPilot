import { describe, expect, it } from 'vitest';

import { permissionChangeMessage } from './permissions-realtime';

describe('permissionChangeMessage', () => {
  it('names the permission when granted', () => {
    const m = permissionChangeMessage('movements:edit_notes', true);
    expect(m.title).toBe('Access granted');
    // Uses the PERMISSION_META label ("Edit movement notes"), not the raw key.
    expect(m.description).toContain('Edit movement notes');
    expect(m.description).not.toContain('movements:edit_notes');
    expect(m.description).toMatch(/granted/i);
  });

  it('names the permission when revoked', () => {
    const m = permissionChangeMessage('movements:edit_notes', false);
    expect(m.description).toContain('Edit movement notes');
    expect(m.description).toMatch(/revoked/i);
  });

  it('names the permission when reset (granted = null → override removed)', () => {
    const m = permissionChangeMessage('movements:edit_notes', null);
    expect(m.description).toContain('Edit movement notes');
    expect(m.description).toMatch(/reset/i);
  });

  it('falls back to the generic message when no permission is provided (older pings)', () => {
    const m = permissionChangeMessage(undefined, true);
    expect(m.title).toBe('Your access was updated');
    expect(m.description).toBe('Your permissions changed — refreshing.');
  });

  it('falls back to generic for an unknown permission key', () => {
    const m = permissionChangeMessage('not:a_real_permission', true);
    expect(m.title).toBe('Your access was updated');
    expect(m.description).toBe('Your permissions changed — refreshing.');
  });
});
