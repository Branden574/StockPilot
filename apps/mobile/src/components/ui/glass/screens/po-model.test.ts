import { describe, expect, it } from 'vitest';

import { receiptTotals, receivedOf, sizeBlocks, sizeLeft, SIZES_PER_BLOCK } from './po-model';

/**
 * The arithmetic behind the PO receive screen's Liquid Glass size-run grid and
 * floating bar (iOS-Receive.dc.html): what the Left row and the "N units / N
 * still to come" words say. They read only the screen's own lines and draft.
 */
const line = (id: string, ordered: number, received = 0) => ({
  id,
  quantity_ordered: ordered,
  quantity_received: received,
  groupId: 'g',
  variantSize: id.toUpperCase(),
});

describe('sizeBlocks: the board draws five sizes across a phone', () => {
  it('keeps a run of five or fewer in one block, in order', () => {
    const run = ['xs', 's', 'm', 'l', 'xl'].map((s) => line(s, 1));
    expect(sizeBlocks(run)).toEqual([run]);
    expect(SIZES_PER_BLOCK).toBe(5);
  });

  it('splits a longer run into blocks of five, never reordering a size', () => {
    const run = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl'].map((s) => line(s, 1));
    const blocks = sizeBlocks(run);
    expect(blocks.map((b) => b.map((l) => l.id))).toEqual([
      ['xs', 's', 'm', 'l', 'xl'],
      ['2xl', '3xl'],
    ]);
  });

  it('draws nothing for an empty run', () => {
    expect(sizeBlocks([])).toEqual([]);
  });
});

describe('sizeLeft: the Left row', () => {
  it('is the outstanding quantity less what is typed now', () => {
    expect(sizeLeft(line('m', 24), '24')).toEqual({ text: '0', tone: 'ok' });
    expect(sizeLeft(line('l', 12), '8')).toEqual({ text: '4', tone: 'warn' });
  });

  it('counts an earlier receipt (partial receiving)', () => {
    expect(sizeLeft(line('l', 12, 5), '3')).toEqual({ text: '4', tone: 'warn' });
    expect(sizeLeft(line('l', 12, 12), '')).toEqual({ text: '0', tone: 'ok' });
  });

  it('reads over-receiving as +N in the danger tone', () => {
    expect(sizeLeft(line('m', 6), '9')).toEqual({ text: '+3', tone: 'danger' });
  });

  it('leaves the outstanding quantity for a box with nothing a receipt would take', () => {
    for (const typed of [undefined, '', 'abc', '-4', '0']) {
      expect(sizeLeft(line('s', 10), typed)).toEqual({ text: '10', tone: 'warn' });
    }
  });
});

describe('receiptTotals: the floating bar', () => {
  it('adds what is typed and what is still to come after it', () => {
    const lines = [line('m', 24), line('l', 12), line('xs', 0)];
    const draft = { m: { received: '24' }, l: { received: '8' } };
    expect(receiptTotals(lines, draft)).toEqual({ units: 32, stillToCome: 4 });
  });

  it('never counts an over-received size as negative still to come', () => {
    expect(receiptTotals([line('m', 6)], { m: { received: '9' } })).toEqual({
      units: 9,
      stillToCome: 0,
    });
  });

  it('reads an empty draft as nothing entered', () => {
    expect(receiptTotals([line('m', 6, 2)], {})).toEqual({ units: 0, stillToCome: 4 });
  });
});

describe('receivedOf', () => {
  it('reads each line’s typed text, empty when none', () => {
    expect(receivedOf([{ id: 'a' }, { id: 'b' }], { a: { received: '3' } })).toEqual({
      a: '3',
      b: '',
    });
  });
});
