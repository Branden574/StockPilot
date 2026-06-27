import { describe, it, expect } from 'vitest';

import { ServiceError } from './context';

describe('ServiceError message sanitization (S13)', () => {
  it('replaces an internal_error message with a generic one (no schema leak)', () => {
    const raw =
      'new row violates row-level security policy for table "inventory_items"';
    const e = new ServiceError('internal_error', raw);
    // Public message must NOT contain the raw DB/schema text.
    expect(e.message).toBe('An internal error occurred. Please try again.');
    expect(e.message).not.toContain('inventory_items');
    expect(e.message).not.toContain('row-level security');
    // The raw detail is retained server-side for logging.
    expect(e.internalDetail).toBe(raw);
  });

  it('keeps app-authored messages for non-internal codes', () => {
    for (const code of ['validation_error', 'forbidden', 'not_found', 'conflict'] as const) {
      const e = new ServiceError(code, 'Type DELETE to confirm.');
      expect(e.message).toBe('Type DELETE to confirm.');
      expect(e.internalDetail).toBeUndefined();
    }
  });

  it('does not set internalDetail when the internal message is already generic', () => {
    const e = new ServiceError('internal_error', 'An internal error occurred. Please try again.');
    expect(e.internalDetail).toBeUndefined();
  });
});
