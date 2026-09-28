import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ORG_TIMEZONE_OPTIONS } from '@/lib/timezone-options';

/**
 * Every zone the organization settings offer must be one the Book Order
 * Totals SQL accepts as it is (no fallback). pgTAP 0379 (D12) proves the SQL
 * half over a literal list; this pins that literal to the settings constant,
 * so adding a zone to the settings without the SQL proof fails here.
 */
describe('Book Order Totals zones', () => {
  it('pgTAP 0379 holds exactly ORG_TIMEZONE_OPTIONS', () => {
    const file = readFileSync(
      path.resolve(__dirname, '../../../../../supabase/tests/0379_book_order_totals.test.sql'),
      'utf8',
    );
    const block = file.slice(file.indexOf('ORG_TIMEZONE_OPTIONS, as a literal'));
    const m = /unnest\(array\[([^\]]+)\]\) z/.exec(block);
    expect(m).not.toBeNull();
    const zones = m![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(zones).toEqual([...ORG_TIMEZONE_OPTIONS]);
  });
  it('every option has the IANA shape the SQL tries (Area/Location, or UTC/GMT)', () => {
    for (const z of ORG_TIMEZONE_OPTIONS as readonly string[]) {
      expect(z === 'UTC' || z === 'GMT' || /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(z)).toBe(
        true,
      );
    }
  });
});
