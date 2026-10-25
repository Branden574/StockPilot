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
  it('strips the leading quantity and moves the size to the end as its token', () => {
    expect(normalizeApparelName('25 - Small : Carolina Blue, Carolina Blue', 25)).toBe(
      'Carolina Blue, Carolina Blue - S',
    );
    expect(normalizeApparelName('30 - Medium : Carolina Blue, Carolina Blue', 30)).toBe(
      'Carolina Blue, Carolina Blue - M',
    );
  });

  it('leaves the sizes of one product as one size run', () => {
    const names = [
      normalizeApparelName('25 - Small : Carolina Blue, Carolina Blue', 25),
      normalizeApparelName('30 - Medium : Carolina Blue, Carolina Blue', 30),
      normalizeApparelName('12 - X-Large : Carolina Blue, Carolina Blue', 12),
      normalizeApparelName('6 - 2X-Large : Carolina Blue, Carolina Blue', 6),
    ];
    const keys = new Set(names.map((n) => sizeRunStyleKey(n)));
    expect(keys).toEqual(new Set(['carolina blue, carolina blue']));
    expect(names.map((n) => extractSize(n))).toEqual(['S', 'M', 'XL', '2XL']);
  });
});

describe('normalizeApparelName: the leading quantity', () => {
  it('is stripped only when it is the line quantity', () => {
    expect(normalizeApparelName('12 - Carolina Blue Tote', 12)).toBe('Carolina Blue Tote');
    // A model number, not a count: the line orders 3.
    expect(normalizeApparelName('511 - Chromebook C737LT', 3)).toBe('511 - Chromebook C737LT');
    // No quantity read from the document: nothing to compare with.
    expect(normalizeApparelName('25 - Carolina Blue Tote', 0)).toBe('25 - Carolina Blue Tote');
  });

  it('needs a dash or a colon after it, so a name that starts with a number keeps it', () => {
    expect(normalizeApparelName('3 Ring Binder', 3)).toBe('3 Ring Binder');
    expect(normalizeApparelName('2 x 4 Lumber', 2)).toBe('2 x 4 Lumber');
  });

  it('never leaves a name that is only a size, and never an empty one', () => {
    expect(normalizeApparelName('25 - Small', 25)).toBe('25 - Small');
    expect(normalizeApparelName('25 -', 25)).toBe('25 -');
  });
});

describe('normalizeApparelName: the size', () => {
  it('moves a size printed as its own part of the name to the end', () => {
    expect(normalizeApparelName('Gildan Tee - Small - Carolina Blue', 4)).toBe(
      'Gildan Tee - Carolina Blue - S',
    );
    expect(normalizeApparelName('T-Shirt - X-Small - Navy', 4)).toBe('T-Shirt - Navy - XS');
    expect(normalizeApparelName('Navy Hoodie - Size: Large', 4)).toBe('Navy Hoodie - L');
  });

  it('writes a trailing size word as its token, and leaves a trailing token alone', () => {
    expect(normalizeApparelName('Gildan Tee - Medium', 4)).toBe('Gildan Tee - M');
    expect(normalizeApparelName('Gildan Tee : Extra Large', 4)).toBe('Gildan Tee - XL');
    expect(normalizeApparelName('Gildan Tee - M', 4)).toBe('Gildan Tee - M');
  });

  it('leaves a size word that is part of a phrase where it is', () => {
    expect(normalizeApparelName('Large Format Paper', 4)).toBe('Large Format Paper');
    expect(normalizeApparelName('Hanes Large Logo Tee - Navy', 4)).toBe(
      'Hanes Large Logo Tee - Navy',
    );
  });

  it('leaves a name with two sizes alone (which one is the item?)', () => {
    expect(normalizeApparelName('Gildan Tee - Small - Large', 4)).toBe(
      'Gildan Tee - Small - Large',
    );
  });

  it('leaves youth and other sized systems alone, so they never join an adult run', () => {
    expect(normalizeApparelName('Gildan Tee - Youth Small - Navy', 4)).toBe(
      'Gildan Tee - Youth Small - Navy',
    );
    expect(normalizeApparelName('Nike Pegasus 41 - 10.5 - Black', 4)).toBe(
      'Nike Pegasus 41 - 10.5 - Black',
    );
  });

  it('writes every size word as a token the size-run grouping reads back', () => {
    for (const [word, token] of Object.entries(APPAREL_SIZE_WORDS)) {
      const name = normalizeApparelName(`Polo - ${word} - Navy`, 1);
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
      line({ lineNumber: 3, description: 'Persepolis', quantity: 10 }),
    ];
    const out = normalizeApparelLineNames(lines);
    expect(out.map((l) => l.description)).toEqual([
      'Carolina Blue - S',
      '1 - Setup : Small',
      'Persepolis',
    ]);
    // The size field is what the document printed; it is never rewritten.
    expect(out[0]).toEqual({ ...lines[0], description: 'Carolina Blue - S' });
    expect(out[1]).toBe(lines[1]);
    expect(out[2]).toBe(lines[2]);
  });
});
