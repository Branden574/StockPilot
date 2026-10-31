import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { poStatusLabel } from './po-status';

/**
 * The purchase order screen's header names the PO's status in words.
 *
 * THE DEFECT (docket B10). The header's own labelForStatus knew draft,
 * expected_inbound, ordered and partially_received, and printed anything else
 * as stored: a received PO's header read "Acme · received" and a cancelled
 * one "Acme · cancelled", where every other status was a word ("Partial").
 */

describe('poStatusLabel', () => {
  it.each([
    ['draft', 'Draft'],
    ['expected_inbound', 'Expected'],
    ['ordered', 'Ordered'],
    ['partially_received', 'Partial'],
    ['received', 'Received'],
    ['cancelled', 'Cancelled'],
  ])('%s reads %s', (status, words) => {
    expect(poStatusLabel(status)).toBe(words);
  });

  it('a status this build does not know is said in words, never as the stored key', () => {
    expect(poStatusLabel('on_hold')).toBe('On hold');
    expect(poStatusLabel('closed')).toBe('Closed');
  });

  it('an inherited object member is not a status', () => {
    expect(poStatusLabel('constructor')).toBe('Constructor');
    expect(poStatusLabel('__proto__')).toBe('Proto');
    expect(poStatusLabel('toString')).toBe('ToString');
  });

  it('no status says nothing', () => {
    expect(poStatusLabel('')).toBe('');
    expect(poStatusLabel(null)).toBe('');
    expect(poStatusLabel(undefined)).toBe('');
    expect(poStatusLabel('__')).toBe('');
  });

  // The web's PO badge is the other place a PO's status is named; the two
  // must say the same word for every status the web knows.
  it('says the same word as the web PO badge for every status', () => {
    const web = readFileSync(
      path.resolve(__dirname, '../../../web/src/components/po/po-status-badge.tsx'),
      'utf8',
    );
    const entries = [...web.matchAll(/^\s+(\w+): \{ variant: '\w+', label: '([^']+)' \},$/gm)];
    expect(entries.map((m) => m[1])).toEqual([
      'draft',
      'expected_inbound',
      'ordered',
      'partially_received',
      'received',
      'cancelled',
    ]);
    for (const [, status, label] of entries) {
      expect(poStatusLabel(status), status).toBe(label);
    }
  });
});
