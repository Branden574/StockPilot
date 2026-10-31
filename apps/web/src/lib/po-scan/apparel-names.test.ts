import { describe, expect, it } from 'vitest';

import { extractSize, sizeRunStyleKey } from '@stockpilot/core';

import {
  APPAREL_SIZE_WORDS,
  normalizeApparelLineNames,
  normalizeApparelName,
} from './apparel-names';
import type { ExtractedPo } from './extract';

type Line = ExtractedPo['lines'][number];

const line = (p: Partial<Line>): Line => ({
  lineNumber: 1,
  description: '',
  vendorSku: '',
  quantity: 0,
  uom: 'EA',
  unitPrice: 0,
  lineTotal: 0,
  lineType: 'inventory',
  confidence: 0.9,
  size: '',
  sizeSystem: '',
  width: '',
  colorway: '',
  jerseyNumber: '',
  playerName: '',
  groupHint: '',
  serialNumber: '',
  mappingConfidence: 0,
  ...p,
});

describe('normalizeApparelName: the "<qty> - <size> : <colour>" invoice shape (2026-08-20)', () => {
  // The invoice prints each size as "<qty> - <size> : <colour>". Kept verbatim
  // as the item name, the size sat in the middle, so sizeRunStyleKey (which
  // reads only a TRAILING size) never grouped the run.
  // The scan reads each line's size into its own field as well (extract.ts
  // `size`); on that invoice it named the same size as the description.
  it('strips the leading quantity and moves the size to the end as its token', () => {
    expect(normalizeApparelName('25 - Small : Carolina Blue, Carolina Blue', 25, 'Small')).toBe(
      'Carolina Blue, Carolina Blue - S',
    );
    expect(normalizeApparelName('30 - Medium : Carolina Blue, Carolina Blue', 30, 'Medium')).toBe(
      'Carolina Blue, Carolina Blue - M',
    );
  });

  it('leaves the sizes of one product as one size run', () => {
    const names = [
      normalizeApparelName('25 - Small : Carolina Blue, Carolina Blue', 25, 'Small'),
      normalizeApparelName('30 - Medium : Carolina Blue, Carolina Blue', 30, 'Medium'),
      normalizeApparelName('12 - X-Large : Carolina Blue, Carolina Blue', 12, 'X-Large'),
      normalizeApparelName('6 - 2X-Large : Carolina Blue, Carolina Blue', 6, '2X-Large'),
    ];
    const keys = new Set(names.map((n) => sizeRunStyleKey(n)));
    expect(keys).toEqual(new Set(['carolina blue, carolina blue']));
    expect(names.map((n) => extractSize(n))).toEqual(['S', 'M', 'XL', '2XL']);
  });
});

describe('normalizeApparelName: the leading quantity', () => {
  it('is stripped only when it is the line quantity', () => {
    expect(normalizeApparelName('12 - Carolina Blue Tote', 12, '')).toBe('Carolina Blue Tote');
    // A model number, not a count: the line orders 3.
    expect(normalizeApparelName('511 - Chromebook C737LT', 3, '')).toBe('511 - Chromebook C737LT');
    // No quantity read from the document: nothing to compare with.
    expect(normalizeApparelName('25 - Carolina Blue Tote', 0, '')).toBe('25 - Carolina Blue Tote');
  });

  it('is a count when a spaced dash or a colon and a space follow it', () => {
    expect(normalizeApparelName('12 – Carolina Blue Tote', 12, '')).toBe('Carolina Blue Tote');
    expect(normalizeApparelName('12 — Carolina Blue Tote', 12, '')).toBe('Carolina Blue Tote');
    expect(normalizeApparelName('12: Carolina Blue Tote', 12, '')).toBe('Carolina Blue Tote');
    expect(normalizeApparelName('12 : Carolina Blue Tote', 12, '')).toBe('Carolina Blue Tote');
  });

  it('needs a dash or a colon after it, so a name that starts with a number keeps it', () => {
    expect(normalizeApparelName('3 Ring Binder', 3, '')).toBe('3 Ring Binder');
    expect(normalizeApparelName('2 x 4 Lumber', 2, '')).toBe('2 x 4 Lumber');
  });

  // A hyphen or a colon joined to the number makes it part of the name, the
  // same rule PART_SEPARATOR keeps for a hyphen inside a word. These lost
  // their first number whenever it equalled the line's quantity, and the
  // shortened text became the new record's name and its name-match key.
  it('keeps a number joined to the name by a hyphen or a colon', () => {
    for (const [printed, quantity] of [
      ['3-Ring Binder', 3],
      ['3-Ring Binder, 1 inch', 3],
      ['1-1/2" Binder', 1],
      ['1-1/2" Binder, White', 1],
      ['2-in-1 Laptop Charger', 2],
      ['1-Subject Notebook', 1],
      ['4-Pack AA Batteries', 4],
      ['1-2-3 Magic: Effective Discipline', 1],
      ['1:1 Chromebook Cover', 1],
      ['16:9 Widescreen Monitor', 16],
      ['3 -Ring Binder', 3],
      ['3- Ring Binder', 3],
    ] as const) {
      expect(normalizeApparelName(printed, quantity, '')).toBe(printed);
    }
  });

  it('never leaves a name that is only a size, and never an empty one', () => {
    expect(normalizeApparelName('25 - Small', 25, 'Small')).toBe('25 - Small');
    expect(normalizeApparelName('25 -', 25, '')).toBe('25 -');
  });
});

describe('normalizeApparelName: the size', () => {
  it('moves a size printed as its own part of the name to the end', () => {
    expect(normalizeApparelName('Gildan Tee - Small - Carolina Blue', 4, 'Small')).toBe(
      'Gildan Tee - Carolina Blue - S',
    );
    expect(normalizeApparelName('T-Shirt - X-Small - Navy', 4, 'X-Small')).toBe(
      'T-Shirt - Navy - XS',
    );
    expect(normalizeApparelName('Navy Hoodie - Size: Large', 4, 'Large')).toBe('Navy Hoodie - L');
  });

  it('writes a trailing size word as its token, and leaves a trailing token alone', () => {
    expect(normalizeApparelName('Gildan Tee - Medium', 4, 'Medium')).toBe('Gildan Tee - M');
    expect(normalizeApparelName('Gildan Tee : Extra Large', 4, 'Extra Large')).toBe(
      'Gildan Tee - XL',
    );
    expect(normalizeApparelName('Gildan Tee - M', 4, 'M')).toBe('Gildan Tee - M');
  });

  // The scan reads the size the document printed for a line into its own
  // field, and leaves it empty when the line has none. A word in the name
  // that reads as a size is only the line's size when that field says so: a
  // book printed "M: Son of the Century" (no size) became "Son of the
  // Century - M", which named the new record and was its name-match key.
  it('moves the size only when the line printed that same size', () => {
    expect(normalizeApparelName('M: Son of the Century', 2, '')).toBe('M: Son of the Century');
    expect(normalizeApparelName('Gildan Tee - Small - Navy', 4, '')).toBe(
      'Gildan Tee - Small - Navy',
    );
    expect(normalizeApparelName('Gildan Tee - Medium', 4, '')).toBe('Gildan Tee - Medium');
    // A different size, or a size of another system, is not this word.
    expect(normalizeApparelName('Gildan Tee - Small - Navy', 4, 'Medium')).toBe(
      'Gildan Tee - Small - Navy',
    );
    expect(normalizeApparelName('Gildan Tee - Small - Navy', 4, 'Youth Small')).toBe(
      'Gildan Tee - Small - Navy',
    );
    // The same size in another spelling is the same size.
    expect(normalizeApparelName('Gildan Tee - Small - Navy', 4, 'S')).toBe('Gildan Tee - Navy - S');
    expect(normalizeApparelName('Gildan Tee - XXL - Navy', 4, '2X-Large')).toBe(
      'Gildan Tee - Navy - 2XL',
    );
    // The count still goes when the line printed no size: it is the quantity.
    expect(normalizeApparelName('25 - Small : Carolina Blue', 25, '')).toBe(
      'Small : Carolina Blue',
    );
  });

  it('leaves a size word that is part of a phrase where it is', () => {
    expect(normalizeApparelName('Large Format Paper', 4, 'Large')).toBe('Large Format Paper');
    expect(normalizeApparelName('Hanes Large Logo Tee - Navy', 4, 'Large')).toBe(
      'Hanes Large Logo Tee - Navy',
    );
  });

  it('leaves a name with two sizes alone (which one is the item?)', () => {
    expect(normalizeApparelName('Gildan Tee - Small - Large', 4, 'Small')).toBe(
      'Gildan Tee - Small - Large',
    );
  });

  it('leaves youth and other sized systems alone, so they never join an adult run', () => {
    expect(normalizeApparelName('Gildan Tee - Youth Small - Navy', 4, 'Youth Small')).toBe(
      'Gildan Tee - Youth Small - Navy',
    );
    expect(normalizeApparelName('Nike Pegasus 41 - 10.5 - Black', 4, '10.5')).toBe(
      'Nike Pegasus 41 - 10.5 - Black',
    );
  });

  it('reads only its own size words: an inherited object member is never a size', () => {
    // The part comes from the scanned document. Indexed into a plain object,
    // "constructor" and "__proto__" read Object.prototype members (a function,
    // an object), which counted as a size and ended the name in
    // "function Object() { [native code] }" or "[object Object]".
    // The line's printed size is the same word, as the scan would read it, so
    // each case reaches the lookup of the name's parts: a printed size that is
    // not a size word returns the name before that lookup runs.
    for (const [part, printedSize] of [
      ['constructor', 'constructor'],
      ['__proto__', '__proto__'],
      ['toString', 'toString'],
      ['valueOf', 'valueOf'],
      ['hasOwnProperty', 'hasOwnProperty'],
      ['isPrototypeOf', 'isPrototypeOf'],
      ['Size: constructor', 'constructor'],
    ] as const) {
      const printed = `Gildan Tee - ${part} - Navy`;
      expect(normalizeApparelName(printed, 4, printedSize)).toBe(printed);
    }
    // A real size beside one of them still moves (the inherited name is just
    // a word of the name).
    expect(normalizeApparelName('Constructor Tee - Small - Navy', 4, 'Small')).toBe(
      'Constructor Tee - Navy - S',
    );
  });

  it('writes every size word as a token the size-run grouping reads back', () => {
    for (const [word, token] of Object.entries(APPAREL_SIZE_WORDS)) {
      const name = normalizeApparelName(`Polo - ${word} - Navy`, 1, word);
      expect(name).toBe(`Polo - Navy - ${token}`);
      expect(sizeRunStyleKey(name)).toBe('polo - navy');
      expect(extractSize(name)).toBe(token);
    }
  });
});

describe('normalizeApparelLineNames', () => {
  it('renames inventory lines only, and keeps every other field', () => {
    const lines = [
      line({
        lineNumber: 1,
        description: '25 - Small : Carolina Blue',
        quantity: 25,
        size: 'Small',
      }),
      line({ lineNumber: 2, description: '1 - Setup : Small', quantity: 1, lineType: 'fee' }),
      line({ lineNumber: 3, description: 'Harbor Lights Reader', quantity: 10 }),
    ];
    const out = normalizeApparelLineNames(lines, 500);
    expect(out.map((l) => l.description)).toEqual([
      'Carolina Blue - S',
      '1 - Setup : Small',
      'Harbor Lights Reader',
    ]);
    // The size field is what the document printed; it is never rewritten.
    expect(out[0]).toEqual({ ...lines[0], description: 'Carolina Blue - S' });
    expect(out[1]).toBe(lines[1]);
    expect(out[2]).toBe(lines[2]);
  });

  // Moving a size to the end can add characters ("S:Blue" is 6, "Blue - S"
  // is 8). The scan bounds every description (extract.ts MAX_SCAN_TEXT_LEN);
  // a result past the bound keeps the printed description rather than a cut
  // one, which could end mid-token.
  it('keeps the printed description when the new name would pass the length bound', () => {
    const colour = (n: number) => 'B'.repeat(n);
    // 2 + 494 = 496 printed; 494 + 4 = 498 renamed: within the bound.
    const fits = line({ description: `S:${colour(494)}`, quantity: 4, size: 'S' });
    // 2 + 496 = 498 printed; 496 + 4 = 500 renamed: exactly the bound.
    const atBound = line({ description: `S:${colour(496)}`, quantity: 4, size: 'S' });
    // 2 + 497 = 499 printed; 497 + 4 = 501 renamed: one past it.
    const over = line({ description: `S:${colour(497)}`, quantity: 4, size: 'S' });

    const [a, b, c] = normalizeApparelLineNames([fits, atBound, over], 500);

    expect(a!.description).toBe(`${colour(494)} - S`);
    expect(b!.description).toBe(`${colour(496)} - S`);
    expect(b!.description).toHaveLength(500);
    expect(c).toBe(over);
    expect(c!.description).toHaveLength(499);
  });

  it("reads each line's own printed size", () => {
    const lines = [
      line({ lineNumber: 1, description: 'Gildan Tee - Small - Navy', quantity: 4, size: 'Small' }),
      line({ lineNumber: 2, description: 'Gildan Tee - Small - Navy', quantity: 4, size: '' }),
      line({ lineNumber: 3, description: 'M: Son of the Century', quantity: 2, size: '' }),
    ];
    const out = normalizeApparelLineNames(lines, 500);
    expect(out[0]!.description).toBe('Gildan Tee - Navy - S');
    expect(out[1]).toBe(lines[1]);
    expect(out[2]).toBe(lines[2]);
  });

  // A checksum-valid ISBN as the vendor number makes the line a book, and a
  // book's title stays as printed: no count is dropped and no word moves,
  // even when the scan read a size for the line.
  it('keeps the printed title of a line whose vendor number is an ISBN', () => {
    const isbn13 = '9780000000019';
    const isbn10 = '0306406152';
    const lines = [
      line({ description: 'M: Son of the Century', quantity: 2, vendorSku: isbn13 }),
      line({ description: 'M: Son of the Century', quantity: 2, vendorSku: isbn13, size: 'M' }),
      line({ description: '25 - Harbor Lights Reader', quantity: 25, vendorSku: isbn10 }),
      line({
        description: 'Small : Big Book',
        quantity: 3,
        vendorSku: '978-0-306-40615-7',
        size: 'Small',
      }),
    ];
    const out = normalizeApparelLineNames(lines, 500);
    out.forEach((l, i) => expect(l).toBe(lines[i]));
  });

  it('still renames a line whose vendor number only looks like an ISBN', () => {
    // Thirteen digits that fail the ISBN checksum, and a garment's own SKU.
    const lines = [
      line({
        description: '25 - Small : Navy',
        quantity: 25,
        vendorSku: '9780000000010',
        size: 'Small',
      }),
      line({
        description: '25 - Small : Navy',
        quantity: 25,
        vendorSku: 'G500-SM-NVY',
        size: 'Small',
      }),
    ];
    const out = normalizeApparelLineNames(lines, 500);
    expect(out.map((l) => l.description)).toEqual(['Navy - S', 'Navy - S']);
  });
});
