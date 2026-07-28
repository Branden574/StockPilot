import { describe, expect, it } from 'vitest';

import { groupCountSheetLines, type CycleCountPdfLine } from './cycle-count';

function line(over: Partial<CycleCountPdfLine> = {}): CycleCountPdfLine {
  return {
    sku: 'SKU-1',
    name: 'Item',
    unitOfMeasure: 'each',
    location: null,
    expectedQuantity: 1,
    ...over,
  };
}

describe('groupCountSheetLines', () => {
  it('leaves a non-sports sheet completely flat — one unnamed block', () => {
    const lines = [line({ sku: 'A' }), line({ sku: 'B' })];
    const blocks = groupCountSheetLines(lines);
    expect(blocks).toHaveLength(1);
    // A null name is what suppresses every header and subtotal downstream.
    expect(blocks[0]!.name).toBeNull();
    expect(blocks[0]!.lines).toHaveLength(2);
  });

  it('buckets a size run under its group and subtotals it', () => {
    const blocks = groupCountSheetLines([
      line({ sku: 'PEG-9', groupId: 'g1', groupName: 'Pegasus 41', expectedQuantity: 4, unitOfMeasure: 'pair' }),
      line({ sku: 'PEG-10', groupId: 'g1', groupName: 'Pegasus 41', expectedQuantity: 6, unitOfMeasure: 'pair' }),
      line({ sku: 'PEG-11', groupId: 'g1', groupName: 'Pegasus 41', expectedQuantity: 2, unitOfMeasure: 'pair' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.name).toBe('Pegasus 41');
    expect(blocks[0]!.expectedSubtotal).toBe(12);
    // PAIR is a display convention with no conversion — the subtotal says so.
    expect(blocks[0]!.unit).toBe('pair');
  });

  it('buckets on the group ID, never the display name', () => {
    // Two seasons of one jersey can legitimately share a name. Merging them
    // would print one subtotal for two products.
    const blocks = groupCountSheetLines([
      line({ sku: 'A', groupId: 'g1', groupName: 'Falcons Home Jersey', expectedQuantity: 3 }),
      line({ sku: 'B', groupId: 'g2', groupName: 'Falcons Home Jersey', expectedQuantity: 5 }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.expectedSubtotal).sort()).toEqual([3, 5]);
  });

  it('puts the ungrouped remainder LAST, under its own heading', () => {
    const blocks = groupCountSheetLines([
      line({ sku: 'LOOSE' }),
      line({ sku: 'PEG-9', groupId: 'g1', groupName: 'Pegasus 41' }),
    ]);
    expect(blocks.map((b) => b.name)).toEqual(['Pegasus 41', 'Ungrouped items']);
  });

  it('orders the group blocks by name so the printed sheet is stable', () => {
    const blocks = groupCountSheetLines([
      line({ sku: 'z', groupId: 'g2', groupName: 'Zephyr' }),
      line({ sku: 'a', groupId: 'g1', groupName: 'Alpha' }),
    ]);
    expect(blocks.map((b) => b.name)).toEqual(['Alpha', 'Zephyr']);
  });

  it('subtotals counted quantities only when something was counted', () => {
    const uncounted = groupCountSheetLines([
      line({ groupId: 'g1', groupName: 'G', expectedQuantity: 4 }),
    ]);
    // A blank count sheet must print a blank, never a misleading 0.
    expect(uncounted[0]!.countedSubtotal).toBeNull();

    const counted = groupCountSheetLines([
      line({ groupId: 'g1', groupName: 'G', expectedQuantity: 4, countedQuantity: 3 }),
      line({ groupId: 'g1', groupName: 'G', expectedQuantity: 2, countedQuantity: null }),
    ]);
    // Partial coverage subtotals what was actually counted.
    expect(counted[0]!.countedSubtotal).toBe(3);
  });

  it('never re-expresses a mixed-unit block in a single unit', () => {
    const blocks = groupCountSheetLines([
      line({ groupId: 'g1', groupName: 'G', unitOfMeasure: 'pair' }),
      line({ groupId: 'g1', groupName: 'G', unitOfMeasure: 'each' }),
    ]);
    expect(blocks[0]!.unit).toBe('units (mixed)');
  });

  it('falls back to a neutral header when a grouped line carries no group name', () => {
    const blocks = groupCountSheetLines([line({ groupId: 'g1', groupName: null })]);
    expect(blocks[0]!.name).toBe('Product group');
  });

  it('subtotals only the lines on THIS sheet — a group total is never stored', () => {
    // A count covering three of a group's six sizes subtotals those three.
    const blocks = groupCountSheetLines([
      line({ groupId: 'g1', groupName: 'G', expectedQuantity: 1 }),
      line({ groupId: 'g1', groupName: 'G', expectedQuantity: 1 }),
    ]);
    expect(blocks[0]!.expectedSubtotal).toBe(2);
  });
});
