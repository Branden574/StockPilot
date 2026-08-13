import { describe, expect, it } from 'vitest';

import {
  BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION,
  bookRackAcknowledgementIndex,
  bookRackAcknowledgementsMatch,
  bookRackFingerprint,
  describeBookRackClear,
  isBookRackChangeAcknowledged,
  parseBookRackChangeDetail,
  summarizeBookRackClears,
  toBookRackAcknowledgement,
} from './book-rack-placement';

describe('bookRackFingerprint', () => {
  it('is stable across case and surrounding whitespace', () => {
    expect(bookRackFingerprint(' 38 ', ' a ')).toBe(bookRackFingerprint('38', 'A'));
  });

  it('treats the 2026-07-23 composite shape as the same rack as the decomposed pair', () => {
    // ("38-A", null) is the legacy row the incident produced; ("38","A") is what
    // every writer stores now. They name ONE rack, so they must fingerprint the
    // same — otherwise the confirmation can never be answered for a legacy row.
    expect(bookRackFingerprint('38-A', null)).toBe(bookRackFingerprint('38', 'A'));
  });

  it('separates two different racks', () => {
    expect(bookRackFingerprint('38', 'A')).not.toBe(bookRackFingerprint('38', 'B'));
    expect(bookRackFingerprint('38', 'A')).not.toBe(bookRackFingerprint('22', 'A'));
  });

  it('does not collide across the number/row split', () => {
    // A joined "38-A" key would make these two identical. They are different
    // racks: "E2E-RACK-1" decomposes to (E2E-RACK, 1), never to (E2E, RACK-1).
    expect(bookRackFingerprint('E2E-RACK', '1')).not.toBe(bookRackFingerprint('E2E', 'RACK-1'));
  });

  it('fingerprints "no rack" distinctly from any rack', () => {
    expect(bookRackFingerprint(null, null)).toBe(bookRackFingerprint('   ', ''));
    expect(bookRackFingerprint(null, null)).not.toBe(bookRackFingerprint('38', null));
  });
});

describe('describeBookRackClear', () => {
  const item = { itemId: 'i1', itemName: 'Persepolis' };

  it('asks when a recorded rack is about to be ERASED and the holdings say so', () => {
    const conflict = describeBookRackClear({
      ...item,
      current: { rackNumber: '38', rackRow: 'A' },
      next: { rackNumber: null, rackRow: null },
      basis: 'resolves-to-destination',
    });
    expect(conflict).not.toBeNull();
    expect(conflict!.currentLabel).toBe('38-A');
    expect(conflict!.line).toBe('Rack 38-A will be cleared.');
    expect(conflict!.currentFingerprint).toBe(bookRackFingerprint('38', 'A'));
  });

  it('stays silent when the destination STATES a rack — a move is not this channel', () => {
    // The operator read "22-B" off the destination they picked. Turning that
    // into a blocking question would put a modal in front of every put-away.
    expect(
      describeBookRackClear({
        ...item,
        current: { rackNumber: '38', rackRow: 'A' },
        next: { rackNumber: '22', rackRow: 'B' },
        basis: 'resolves-to-destination',
      }),
    ).toBeNull();
  });

  it('stays silent when the book records no rack — filling a blank destroys nothing', () => {
    expect(
      describeBookRackClear({
        ...item,
        current: { rackNumber: null, rackRow: null },
        next: { rackNumber: null, rackRow: null },
        basis: 'resolves-to-destination',
      }),
    ).toBeNull();
  });

  it('stays silent when the basis cannot support the promise', () => {
    // 'unknown' = the caller did not read the holdings, or they say the book
    // stays split. The reconciliation will not clear anything, so asking would
    // be a false alarm.
    expect(
      describeBookRackClear({
        ...item,
        current: { rackNumber: '38', rackRow: 'A' },
        next: { rackNumber: null, rackRow: null },
        basis: 'unknown',
      }),
    ).toBeNull();
  });

  it('carries the label a legacy composite row reads as', () => {
    const conflict = describeBookRackClear({
      ...item,
      current: { rackNumber: '38-A', rackRow: null },
      next: {},
      basis: 'resolves-to-destination',
    });
    expect(conflict!.currentLabel).toBe('38-A');
    expect(conflict!.line).toBe('Rack 38-A will be cleared.');
  });
});

describe('the scoped acknowledgement', () => {
  const shown = describeBookRackClear({
    itemId: 'i1',
    itemName: 'Persepolis',
    current: { rackNumber: '38', rackRow: 'A' },
    next: {},
    basis: 'resolves-to-destination',
  })!;

  it('waives the erasure it was shown', () => {
    const index = bookRackAcknowledgementIndex(toBookRackAcknowledgement([shown]));
    expect(isBookRackChangeAcknowledged(index, shown)).toBe(true);
  });

  it('does NOT waive an erasure of a rack the client never displayed', () => {
    // The dialog showed 38-A; someone re-racked the book to 22-B before the
    // request landed. The acknowledgement is not an answer to THIS question.
    const index = bookRackAcknowledgementIndex(toBookRackAcknowledgement([shown]));
    const fresh = describeBookRackClear({
      itemId: 'i1',
      itemName: 'Persepolis',
      current: { rackNumber: '22', rackRow: 'B' },
      next: {},
      basis: 'resolves-to-destination',
    })!;
    expect(isBookRackChangeAcknowledged(index, fresh)).toBe(false);
  });

  it('does not let one book’s acknowledgement answer for another', () => {
    const index = bookRackAcknowledgementIndex(toBookRackAcknowledgement([shown]));
    expect(isBookRackChangeAcknowledged(index, { ...shown, itemId: 'i2' })).toBe(false);
  });

  it('keeps the FIRST fingerprint when a caller sends two for one book', () => {
    const index = bookRackAcknowledgementIndex([
      { itemId: 'i1', currentFingerprint: 'first' },
      { itemId: 'i1', currentFingerprint: 'second' },
    ]);
    expect(index.get('i1')).toBe('first');
  });

  it('ignores malformed entries rather than indexing them', () => {
    const index = bookRackAcknowledgementIndex([
      null as never,
      { itemId: 42 as never, currentFingerprint: 'x' },
      { itemId: 'i1', currentFingerprint: 'ok' },
    ]);
    expect([...index.entries()]).toEqual([['i1', 'ok']]);
  });
});

describe('bookRackAcknowledgementsMatch', () => {
  it('is order-insensitive', () => {
    const a = { itemId: 'i1', currentFingerprint: 'f1' };
    const b = { itemId: 'i2', currentFingerprint: 'f2' };
    expect(bookRackAcknowledgementsMatch([b, a], [a, b])).toBe(true);
  });

  it('reports a payload naming something we never answered', () => {
    expect(
      bookRackAcknowledgementsMatch(
        [{ itemId: 'i1', currentFingerprint: 'f1' }],
        [
          { itemId: 'i1', currentFingerprint: 'f1' },
          { itemId: 'i2', currentFingerprint: 'f2' },
        ],
      ),
    ).toBe(false);
  });

  it('treats a missing acknowledgement as covering nothing', () => {
    expect(
      bookRackAcknowledgementsMatch(undefined, [{ itemId: 'i1', currentFingerprint: 'f1' }]),
    ).toBe(false);
  });

  it('cannot be satisfied by smuggling a delimiter into an id', () => {
    // A joined key would let itemId 'i1","f1' impersonate the pair (i1, f1).
    expect(
      bookRackAcknowledgementsMatch(
        [{ itemId: 'i1","f1', currentFingerprint: '' }],
        [{ itemId: 'i1', currentFingerprint: 'f1' }],
      ),
    ).toBe(false);
  });
});

describe('parseBookRackChangeDetail', () => {
  const line = {
    itemId: 'i1',
    itemName: 'Persepolis',
    currentLabel: '38-A',
    line: 'Rack 38-A will be cleared.',
    currentFingerprint: 'fp',
  };

  it('reads rackItems off a RACK-ONLY refusal', () => {
    const parsed = parseBookRackChangeDetail({
      reason: BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION,
      rackItems: [line],
    });
    expect(parsed?.items).toEqual([line]);
  });

  it('reads rackItems off a COMBINED refusal that keeps the crate reason', () => {
    // The crate reason is what every already-shipped client matches on, so a
    // payload carrying both questions must keep it — and the rack half still
    // has to be readable from the same blob.
    const parsed = parseBookRackChangeDetail({
      reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
      items: [{ itemId: 'i1', itemName: 'Persepolis', currentFingerprint: 'c' }],
      rackItems: [line],
    });
    expect(parsed?.items).toEqual([line]);
  });

  it('rejects another conflict’s payload', () => {
    expect(parseBookRackChangeDetail({ reason: 'SOMETHING_ELSE', rackItems: [line] })).toBeNull();
  });

  it('rejects a payload with no rack lines', () => {
    expect(
      parseBookRackChangeDetail({ reason: BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION, rackItems: [] }),
    ).toBeNull();
    expect(
      parseBookRackChangeDetail({ reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION', items: [] }),
    ).toBeNull();
  });

  it('rejects a line with no fingerprint — it could never be answered', () => {
    const { currentFingerprint: _drop, ...noFingerprint } = line;
    expect(
      parseBookRackChangeDetail({
        reason: BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION,
        rackItems: [noFingerprint],
      }),
    ).toBeNull();
  });

  it('rejects a line with no sentence — an empty question is not a question', () => {
    expect(
      parseBookRackChangeDetail({
        reason: BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION,
        rackItems: [{ ...line, line: '' }],
      }),
    ).toBeNull();
  });

  it('rejects non-object details', () => {
    expect(parseBookRackChangeDetail(null)).toBeNull();
    expect(parseBookRackChangeDetail('nope')).toBeNull();
  });
});

describe('summarizeBookRackClears', () => {
  const of = (n: number, label: string) =>
    Array.from({ length: n }, () => ({
      currentLabel: label,
      line: `Rack ${label} will be cleared.`,
    }));

  it('collapses one rack shared by 200 books into a single sentence', () => {
    const s = summarizeBookRackClears(of(200, '38-A'));
    expect(s.total).toBe(200);
    expect(s.lines).toEqual(['Rack 38-A will be cleared.']);
    expect(s.groups).toEqual([
      { currentLabel: '38-A', line: 'Rack 38-A will be cleared.', count: 200 },
    ]);
  });

  it('orders groups largest first, then alphabetically', () => {
    const s = summarizeBookRackClears([...of(1, '22-B'), ...of(3, '38-A'), ...of(1, '10-C')]);
    expect(s.groups.map((g) => g.currentLabel)).toEqual(['38-A', '10-C', '22-B']);
  });

  it('does not merge two racks whose labels only look alike when joined', () => {
    const s = summarizeBookRackClears([
      { currentLabel: 'A', line: 'x' },
      { currentLabel: 'A', line: 'y' },
    ]);
    expect(s.groups).toHaveLength(2);
  });
});
