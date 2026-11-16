import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';

import { refusedQueuedAdjustMessage } from './adjust-outbox';
import { PARKED_FOR_AUTHENTICATOR_COPY, shownLastError } from './parked-set-up-words';

/**
 * A row in Settings > Unsent work whose stored message is the server's
 * sentence for the authenticator answer is not sent (a person decides with
 * the current facts). What the reader shows for it is a plain
 * sentence saying so, chosen by an exact match on the stored message: no
 * code was stored for those rows. Only what is displayed changes.
 */

const SET_UP_SENTENCE =
  'Multi-factor authentication required. Enroll in MFA before performing this action.';

const ADJUST_PAYLOAD = { itemId: 'item-1', quantityChange: -2, itemLabel: 'Polo S (POLO-S)' };

describe('shownLastError', () => {
  it.each([
    ['a receipt', 'receive_po_line'],
    ['a count', 'record_count'],
    ['a bundle distribution', 'distribute_bundle'],
    ['a size count', 'size_count_event'],
  ])('%s parked on the set-up answer reads the plain sentence', (_name, kind) => {
    for (const stored of [SET_UP_SENTENCE, AUTHENTICATOR_SET_UP_OWED_COPY]) {
      expect(shownLastError({ status: 'rejected', kind, payload: {}, lastError: stored })).toBe(
        PARKED_FOR_AUTHENTICATOR_COPY,
      );
    }
  });

  it('an adjustment keeps naming the item and the change', () => {
    const stored = refusedQueuedAdjustMessage(ADJUST_PAYLOAD, SET_UP_SENTENCE);
    expect(
      shownLastError({
        status: 'rejected',
        kind: 'adjust_stock',
        payload: ADJUST_PAYLOAD,
        lastError: stored,
      }),
    ).toBe(`−2 to Polo S (POLO-S). ${PARKED_FOR_AUTHENTICATOR_COPY}`);
  });

  it('every other stored message is shown as it was', () => {
    const others = [
      'Missing permission: stock:adjust',
      `${SET_UP_SENTENCE} `,
      `Note: ${SET_UP_SENTENCE}`,
      'Re-authenticate with MFA before performing this action.',
      refusedQueuedAdjustMessage(ADJUST_PAYLOAD, 'Missing permission: stock:adjust'),
      '',
    ];
    for (const lastError of others) {
      for (const kind of ['receive_po_line', 'adjust_stock']) {
        expect(
          shownLastError({ status: 'rejected', kind, payload: ADJUST_PAYLOAD, lastError }),
        ).toBe(lastError);
      }
    }
    expect(
      shownLastError({ status: 'rejected', kind: 'receive_po_line', payload: {}, lastError: null }),
    ).toBeNull();
  });

  it('an adjustment whose stored item differs from its payload is shown as it was', () => {
    const stored = refusedQueuedAdjustMessage(
      { ...ADJUST_PAYLOAD, itemLabel: 'Other' },
      SET_UP_SENTENCE,
    );
    expect(
      shownLastError({
        status: 'rejected',
        kind: 'adjust_stock',
        payload: ADJUST_PAYLOAD,
        lastError: stored,
      }),
    ).toBe(stored);
  });

  it('a row still queued is never given the parked sentence', () => {
    for (const status of ['pending', 'failed', 'sending', 'ok']) {
      expect(
        shownLastError({
          status,
          kind: 'receive_po_line',
          payload: {},
          lastError: SET_UP_SENTENCE,
        }),
      ).toBe(SET_UP_SENTENCE);
    }
  });

  it('the sentence is plain and names the authenticator', () => {
    expect(PARKED_FOR_AUTHENTICATOR_COPY).toBe(
      'Not sent: your organization required an authenticator before this could be saved. If it is still needed, enter it again.',
    );
    expect(PARKED_FOR_AUTHENTICATOR_COPY).not.toMatch(/MFA|two-factor|multi-factor|2FA/i);
  });
});

describe('the queue reader uses it for every row it hands out', () => {
  const code = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s+/g, ' ');
  const queue = code(readFileSync(path.resolve(__dirname, 'queue.ts'), 'utf8'));

  it('rowFromDb builds lastError through shownLastError, and nothing else maps last_error', () => {
    expect(queue).toContain("import { shownLastError } from './parked-set-up-words';");
    const fn = queue.slice(
      queue.indexOf('function rowFromDb('),
      queue.indexOf('function safeParse('),
    );
    expect(fn).toContain('const payload = safeParse(r.payload_json);');
    expect(fn).toContain(
      'lastError: shownLastError({ status: r.status, kind: r.kind, payload, lastError: r.last_error }),',
    );
    // The stored column is read in that one place.
    expect(queue.match(/\.last_error\b/g)).toHaveLength(1);
  });
});
