import { describe, expect, it } from 'vitest';

import { recordStatusSuffix } from './record-status-suffix';

/**
 * The one status mark core puts after a record's name (B56): the Book Order
 * Totals report's warehouse and charter options, and a purchase order's
 * bill-to charter on the web and the phone. It was a private copy inside
 * the report's words; a second copy would drift.
 */
describe('recordStatusSuffix', () => {
  it('marks an archived or an inactive record', () => {
    expect(recordStatusSuffix('archived')).toBe(' (archived)');
    expect(recordStatusSuffix('inactive')).toBe(' (inactive)');
  });

  it('marks nothing else: active, no status, or a status it does not know', () => {
    expect(recordStatusSuffix('active')).toBe('');
    expect(recordStatusSuffix(null)).toBe('');
    expect(recordStatusSuffix(undefined)).toBe('');
    expect(recordStatusSuffix('other')).toBe('');
    expect(recordStatusSuffix('')).toBe('');
  });
});
