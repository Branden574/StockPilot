import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ StyleSheet: { create: <T>(s: T) => s } }));

const { glassCountLine } = await import('./lookup');

/**
 * PLURAL. The glass Items count line read "1 items" (and Books "1
 * placements"): the line was `${count} items` with no singular. The count
 * line now agrees with its number.
 */
describe('the glass count line', () => {
  it('says one of a thing in the singular and any other number in the plural', () => {
    expect(glassCountLine(1, 'item', 'items')).toBe('1 item');
    expect(glassCountLine(0, 'item', 'items')).toBe('0 items');
    expect(glassCountLine(2, 'item', 'items')).toBe('2 items');
    expect(glassCountLine(1, 'placement', 'placements')).toBe('1 placement');
    expect(glassCountLine(37, 'placement', 'placements')).toBe('37 placements');
  });

  it('keeps the thousands separator the line had', () => {
    expect(glassCountLine(1234, 'item', 'items')).toBe(`${(1234).toLocaleString()} items`);
    expect(glassCountLine(1001, 'item', 'items')).toBe(`${(1001).toLocaleString()} items`);
  });
});

describe('the Items and Books tabs use it for their glass count line', () => {
  const MOBILE_ROOT = path.resolve(__dirname, '../../../../..');
  const flat = (file: string) =>
    readFileSync(path.join(MOBILE_ROOT, file), 'utf8').replace(/\s+/g, ' ');

  it('Items: "N items", one item in the singular; the load-error word is unchanged', () => {
    // listFailed: the read failed, or no workspace is known to read in
    // (no-workspace-screens.test.ts); the words are the same.
    const src = flat('app/(drawer)/(tabs)/inventory.tsx');
    expect(src).toContain(
      "<GlassSubline style={GLASS_LOOKUP.count}> {listFailed ? 'Items' : glassCountLine(datasetRowCount, 'item', 'items')} </GlassSubline>",
    );
    expect(src).not.toContain('${datasetRowCount.toLocaleString()} items`');
  });

  it('Books: "N placements", one placement in the singular', () => {
    const src = flat('app/(drawer)/(tabs)/books.tsx');
    expect(src).toContain(
      "<GlassSubline style={GLASS_LOOKUP.count}> {listFailed ? 'Placements' : glassCountLine(datasetRowCount, 'placement', 'placements')} </GlassSubline>",
    );
    expect(src).not.toContain('${datasetRowCount.toLocaleString()} placements`');
  });
});
