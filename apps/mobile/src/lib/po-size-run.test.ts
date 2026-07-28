import { describe, expect, it } from 'vitest';

import {
  buildPoBlocks,
  poRunSubtotal,
  poRunSubtotalLabel,
  poSizeLabel,
  type PoRunGroup,
  type PoRunLine,
} from './po-size-run';

function line(over: Partial<PoRunLine> & { id: string }): PoRunLine {
  return {
    quantity_ordered: 10,
    quantity_received: 0,
    groupId: null,
    variantSize: null,
    ...over,
  };
}

const shoes: PoRunGroup = {
  name: 'Nike Mercurial',
  countingUnit: 'pair',
  sizeValues: [
    { value: '9', sortOrder: 0 },
    { value: '10', sortOrder: 1 },
    { value: '11', sortOrder: 2 },
  ],
};

describe('buildPoBlocks', () => {
  it('collapses a group of 3 into one run and sorts by the scale', () => {
    const blocks = buildPoBlocks(
      [
        line({ id: 'c', groupId: 'g1', variantSize: '11' }),
        line({ id: 'a', groupId: 'g1', variantSize: '9' }),
        line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      ],
      { g1: shoes },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('run');
    expect(blocks[0]?.lines.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts XL after L with no scale on the group', () => {
    const blocks = buildPoBlocks(
      [
        line({ id: 'x', groupId: 'g1', variantSize: 'XL' }),
        line({ id: 'm', groupId: 'g1', variantSize: 'M' }),
        line({ id: 'l', groupId: 'g1', variantSize: 'L' }),
      ],
      { g1: { name: 'Team tee', countingUnit: 'each' } },
    );
    expect(blocks[0]?.lines.map((l) => l.variantSize)).toEqual(['M', 'L', 'XL']);
  });

  it('leaves every ungrouped line loose — the mobile default for every org', () => {
    const blocks = buildPoBlocks([line({ id: 'a' }), line({ id: 'b' })], {});
    expect(blocks.map((b) => b.kind)).toEqual(['loose', 'loose']);
  });

  it('leaves a lone grouped line loose', () => {
    const blocks = buildPoBlocks([line({ id: 'a', groupId: 'g1', variantSize: 'M' })], {
      g1: shoes,
    });
    expect(blocks[0]?.kind).toBe('loose');
  });

  it('falls back to loose rows when the group metadata never resolved', () => {
    // Without a group we cannot name the counting unit, and the unit is READ,
    // never inferred — so the screen must not invent a heading for it.
    const blocks = buildPoBlocks(
      [
        line({ id: 'a', groupId: 'g1', variantSize: '9' }),
        line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      ],
      {},
    );
    expect(blocks.map((b) => b.kind)).toEqual(['loose', 'loose']);
    expect(blocks.flatMap((b) => b.lines.map((l) => l.id))).toEqual(['a', 'b']);
  });

  it('matches the web layout: a run anchors where its first line sat', () => {
    const blocks = buildPoBlocks(
      [
        line({ id: 'x' }),
        line({ id: 'a', groupId: 'g1', variantSize: '9' }),
        line({ id: 'y' }),
        line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      ],
      { g1: shoes },
    );
    expect(blocks.map((b) => (b.kind === 'run' ? b.groupId : b.lines[0]?.id))).toEqual([
      'x',
      'g1',
      'y',
    ]);
  });
});

describe('poRunSubtotal', () => {
  const lines = [
    line({ id: 'a', groupId: 'g1', variantSize: '9' }),
    line({ id: 'b', groupId: 'g1', variantSize: '10' }),
    line({ id: 'c', groupId: 'g1', variantSize: '11' }),
  ];

  it('sums the entered quantities and counts only the sizes carrying one', () => {
    expect(poRunSubtotal(lines, { a: '4', b: '6', c: '14' })).toEqual({
      quantity: 24,
      sizes: 3,
    });
    expect(poRunSubtotal(lines, { a: '4', b: '0' })).toEqual({ quantity: 4, sizes: 1 });
  });

  it('ignores blanks and junk rather than reading them as zero-with-a-size', () => {
    expect(poRunSubtotal(lines, { a: '', b: 'abc', c: '3' })).toEqual({
      quantity: 3,
      sizes: 1,
    });
  });

  it('ignores a negative entry — a receipt never subtracts', () => {
    expect(poRunSubtotal(lines, { a: '-5', b: '2' })).toEqual({ quantity: 2, sizes: 1 });
  });
});

describe('poRunSubtotalLabel', () => {
  it('names the counting unit read off the group', () => {
    expect(poRunSubtotalLabel({ quantity: 24, sizes: 6 }, 'pair')).toBe(
      'Receiving 24 pairs across 6 sizes',
    );
    expect(poRunSubtotalLabel({ quantity: 1, sizes: 1 }, 'pair')).toBe(
      'Receiving 1 pair across 1 size',
    );
    expect(poRunSubtotalLabel({ quantity: 3, sizes: 2 }, 'each')).toBe(
      'Receiving 3 each across 2 sizes',
    );
  });

  it('says nothing is entered rather than printing a zero', () => {
    expect(poRunSubtotalLabel({ quantity: 0, sizes: 0 }, 'pair')).toBe(
      'Nothing entered yet for this run.',
    );
  });
});

describe('poSizeLabel', () => {
  it('labels a size-less variant instead of rendering an empty cell', () => {
    expect(poSizeLabel('10.5')).toBe('10.5');
    expect(poSizeLabel('  ')).toBe('No size');
    expect(poSizeLabel(null)).toBe('No size');
  });
});
