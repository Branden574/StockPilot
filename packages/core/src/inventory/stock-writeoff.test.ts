import { describe, expect, it } from 'vitest';

import {
  RACK_WRITE_OFF_MOVEMENT_TYPE,
  formatArchiveStockBlockMessage,
  formatBulkArchiveStockBlockMessage,
  formatHoldingLabel,
  formatLocationArchiveStockBlockMessage,
  formatStockQuantity,
} from './stock-writeoff';

describe('formatStockQuantity', () => {
  it('trims the numeric(14,4) trailing zeros for whole counts', () => {
    expect(formatStockQuantity(140)).toBe('140');
    expect(formatStockQuantity(181.0)).toBe('181');
  });
  it('keeps a genuine fractional quantity', () => {
    expect(formatStockQuantity(2.5)).toBe('2.5');
  });
  it('is safe on non-finite input', () => {
    expect(formatStockQuantity(Number.NaN)).toBe('0');
  });
});

describe('formatHoldingLabel', () => {
  it('names a rack/crate by its own name', () => {
    expect(formatHoldingLabel('rack', '100-A')).toBe('100-A');
  });
  it('reads the system buckets as words', () => {
    expect(formatHoldingLabel('staging', 'Staging Zone')).toBe('Staging');
    expect(formatHoldingLabel('unplaced', 'x')).toBe('Unplaced');
  });
});

describe('formatArchiveStockBlockMessage', () => {
  it("matches Andrew's Persepolis case with pluralized units and every location", () => {
    const msg = formatArchiveStockBlockMessage(181, [
      { label: '100-A', quantity: 140 },
      { label: '38-B', quantity: 41 },
    ]);
    expect(msg).toBe(
      'Cannot archive: 181 units still on hand (140 in 100-A, 41 in 38-B). ' +
        'Remove or move the stock first, or archive it anyway to write it off.',
    );
  });
  it('uses the singular "unit" for exactly one', () => {
    expect(formatArchiveStockBlockMessage(1, [{ label: 'A', quantity: 1 }])).toContain(
      '1 unit still on hand',
    );
  });
  it('still blocks (no location clause) when on-hand exists but has no holdings', () => {
    expect(formatArchiveStockBlockMessage(5, [])).toBe(
      'Cannot archive: 5 units still on hand. ' +
        'Remove or move the stock first, or archive it anyway to write it off.',
    );
  });
});

describe('formatBulkArchiveStockBlockMessage', () => {
  it('names the count of affected items', () => {
    expect(formatBulkArchiveStockBlockMessage(3)).toContain('3 selected items still hold stock');
    expect(formatBulkArchiveStockBlockMessage(1)).toContain('1 selected item still holds stock');
  });
});

describe('RACK_WRITE_OFF_MOVEMENT_TYPE', () => {
  it('is a removal, not a transfer', () => {
    expect(RACK_WRITE_OFF_MOVEMENT_TYPE).toBe('remove');
  });
});

// ---------------------------------------------------------------------------
// THE LOCATION SIDE OF THE SAME GUARD — rack 100-A, 2026-08-19
//
// Archiving an ITEM that still holds stock was guarded; archiving a LOCATION
// that still holds stock was not. That asymmetry is worse than it sounds: the
// natural reaction to "there is a rack here that should not exist" is to delete
// the rack, and doing so soft-deletes a row whose item_stock_levels holdings
// survive. The units keep counting toward on-hand and valuation while the
// location they name disappears from every list — the phantom rack becomes an
// INVISIBLE phantom rack.
//
// So the copy must NOT reuse the item wording. Archiving an item "writes off"
// its stock in the sense that it stops being visible; archiving a location does
// not remove anything at all, and telling an operator it does would be a lie
// pointed straight at the failure mode.
// ---------------------------------------------------------------------------
describe('formatLocationArchiveStockBlockMessage', () => {
  it('names the location, the total, and the items holding it', () => {
    const msg = formatLocationArchiveStockBlockMessage('100-A', 22, [
      { name: 'Science Dimensions Earth & Space Science', quantity: 12 },
      { name: 'Science Dimensions Earth & Space Science', quantity: 10 },
    ]);
    expect(msg).toContain('100-A');
    expect(msg).toContain('22 units');
    expect(msg).toContain('2 items');
    expect(msg).toContain('12 of Science Dimensions Earth & Space Science');
  });

  it('says what archiving anyway ACTUALLY does — never "write it off"', () => {
    const msg = formatLocationArchiveStockBlockMessage('100-A', 22, [
      { name: 'A book', quantity: 22 },
    ]);
    // The whole point of a separate builder. Archiving a location removes no
    // stock; promising otherwise is how the orphan gets created deliberately.
    expect(msg).not.toMatch(/write it off/i);
    expect(msg).toContain('still counted');
    expect(msg).toContain('hidden location');
  });

  it('singularises one unit and one item', () => {
    const msg = formatLocationArchiveStockBlockMessage('37-B', 1, [
      { name: 'A book', quantity: 1 },
    ]);
    expect(msg).toContain('1 unit ');
    expect(msg).toContain('1 item');
    expect(msg).not.toContain('units');
    expect(msg).not.toContain('items');
  });

  it('caps the named items and counts the rest, so a 50-item rack is readable', () => {
    const holders = Array.from({ length: 50 }, (_, i) => ({ name: `Book ${i}`, quantity: 2 }));
    const msg = formatLocationArchiveStockBlockMessage('22-A', 100, holders);
    expect(msg).toContain('Book 0');
    expect(msg).toContain('and 47 more');
    expect(msg).not.toContain('Book 20');
  });

  it('drops the parenthetical entirely when no items are named', () => {
    const msg = formatLocationArchiveStockBlockMessage('22-A', 5, []);
    expect(msg).toContain('5 units');
    expect(msg).not.toContain('(');
  });
});
