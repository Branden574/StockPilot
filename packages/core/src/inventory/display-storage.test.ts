import { describe, expect, it } from 'vitest';

import { readBookStorage, readDisplayStorage, readItemRack } from './book-storage';

describe('readDisplayStorage — the legacy spellings older imports still carry', () => {
  it('reads the structured book pair', () => {
    expect(
      readDisplayStorage({ book_rack_number: '38', book_rack_row: 'A' }, 'book').rackLabel,
    ).toBe('38-A');
  });

  it('falls back to the legacy free-text label when there is no structured pair', () => {
    // These rows predate the number/row split. Reading only the canonical keys
    // renders a blank rack for stock that IS recorded — the state the native
    // hand-rolled copy existed to avoid.
    for (const key of ['rackLabel', 'rack_label', 'rack']) {
      expect(readDisplayStorage({ [key]: '38-A' }, 'book').rackLabel).toBe('38-A');
      expect(readDisplayStorage({ [key]: '12-C' }, 'product').rackLabel).toBe('12-C');
    }
  });

  it('prefers the structured pair over a stale legacy label', () => {
    // A row carrying both is described by the pair: the pair is what every
    // writer maintains, so the free-text value is the one that goes stale.
    const info = readDisplayStorage(
      { book_rack_number: '38', book_rack_row: 'A', rack: '99-Z' },
      'book',
    );
    expect(info.rackLabel).toBe('38-A');
  });

  it("reads the other family's keys only as a fallback, never in preference", () => {
    const both = readDisplayStorage(
      { book_rack_number: '38', book_rack_row: 'A', rack_number: '99', rack_row: 'Z' },
      'book',
    );
    expect(both.rackLabel).toBe('38-A');
    const productBoth = readDisplayStorage(
      { book_rack_number: '38', book_rack_row: 'A', rack_number: '99', rack_row: 'Z' },
      'product',
    );
    expect(productBoth.rackLabel).toBe('99-Z');
    // ...but a book with ONLY the neutral keys still shows its rack.
    expect(readDisplayStorage({ rack_number: '7', rack_row: 'B' }, 'book').rackLabel).toBe(
      '7-B',
    );
  });

  it('reads the pre-prefix crate and grade spellings', () => {
    // Reading only book_crate_* is what made crate colour and number render
    // blank on the phone (owner caught 2026-07-10).
    expect(readDisplayStorage({ crateColor: 'blue' }, 'book').crateColor).toBe('blue');
    expect(readDisplayStorage({ crate_color: 'gray' }, 'book').crateColor).toBe('gray');
    expect(readDisplayStorage({ crateNumber: '12' }, 'book').crateNumber).toBe('12');
    expect(readDisplayStorage({ crate_number: 'BIN' }, 'book').crateNumber).toBe('BIN');
    expect(readDisplayStorage({ grade: 'K' }, 'book').grade).toBe('K');
    // Canonical still wins.
    expect(
      readDisplayStorage({ book_crate_color: 'red', crateColor: 'blue' }, 'book').crateColor,
    ).toBe('red');
  });

  it('returns all-null for an item with nothing recorded', () => {
    expect(readDisplayStorage(null, 'book')).toEqual({
      rackLabel: null,
      rackNumber: null,
      rackRow: null,
      legacyRackLabel: null,
      crateColor: null,
      crateNumber: null,
      grade: null,
    });
  });

  it('refuses an object rather than rendering "[object Object]" on the item screen', () => {
    // custom_fields is operator- and import-writable JSONB, so a non-scalar is
    // reachable. `String({})` is "[object Object]" — a string a picker would
    // read as a rack name.
    const info = readDisplayStorage(
      { book_rack_number: { nested: true }, book_rack_row: ['A'] },
      'book',
    );
    expect(info.rackLabel).toBeNull();
  });

  it('still coerces a NUMERIC rack, which is a real shape and must keep working', () => {
    // JSON writes 38 as a number. Rejecting it would blank the rack on rows
    // that are perfectly well recorded — the opposite of this reader's purpose.
    expect(readDisplayStorage({ book_rack_number: 38, book_rack_row: 'A' }, 'book').rackLabel)
      .toBe('38-A');
  });

  it('treats a whitespace-only legacy label as absent', () => {
    expect(readDisplayStorage({ rack: '   ' }, 'book').rackLabel).toBeNull();
  });
});

describe('the canonical readers must NOT learn the legacy spellings', () => {
  // THIS IS THE LOAD-BEARING TEST OF THE WHOLE SPLIT.
  //
  // readBookStorage feeds the before-map that the crate and rack
  // acknowledgement gates fingerprint. A fingerprint is a promise to a client:
  // the phone computes the same pair and returns it to prove it answered the
  // question it was shown. If the server starts reading a key the shipped
  // client does not, the two stop agreeing and every live device's
  // acknowledgement dead-ends — the exact Critical the rack channel was built
  // around. A future "why are these two functions almost the same, let me
  // merge them" is the realistic way that ships.
  it('readBookStorage ignores the legacy free-text label', () => {
    expect(readBookStorage({ rackLabel: '38-A' }).rackLabel).toBeNull();
    expect(readBookStorage({ rack_label: '38-A' }).rackLabel).toBeNull();
    expect(readBookStorage({ rack: '38-A' }).rackLabel).toBeNull();
  });

  it('readBookStorage ignores the pre-prefix crate spellings', () => {
    expect(readBookStorage({ crateColor: 'blue' }).crateColor).toBeNull();
    expect(readBookStorage({ crate_color: 'blue' }).crateColor).toBeNull();
    expect(readBookStorage({ crateNumber: '12' }).crateNumber).toBeNull();
  });

  it('readBookStorage does not cross into the neutral rack_* keys', () => {
    expect(readBookStorage({ rack_number: '38', rack_row: 'A' }).rackLabel).toBeNull();
  });

  it('readItemRack does not cross into the book_rack_* keys', () => {
    expect(readItemRack({ book_rack_number: '38', book_rack_row: 'A' }).rackLabel).toBeNull();
  });
});

describe('the legacy label is reported only when it is the value being shown', () => {
  it('legacyRackLabel is null when a structured pair supplied the label', () => {
    // Otherwise a formatter handed both would render the live rack AND a dead
    // free-text value that no writer maintains.
    const info = readDisplayStorage(
      { book_rack_number: '38', book_rack_row: 'A', rack: '99-Z' },
      'book',
    );
    expect(info.rackLabel).toBe('38-A');
    expect(info.legacyRackLabel).toBeNull();
  });

  it('legacyRackLabel carries the value when it IS the label', () => {
    const info = readDisplayStorage({ rack_label: '99-Z' }, 'book');
    expect(info.rackLabel).toBe('99-Z');
    expect(info.legacyRackLabel).toBe('99-Z');
    // The structured pieces stay null — a caller can tell "recorded the old
    // way" from "recorded properly", which is a different confidence.
    expect(info.rackNumber).toBeNull();
    expect(info.rackRow).toBeNull();
  });
});
