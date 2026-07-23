import { describe, expect, it } from 'vitest';

import {
  RACK_WRITE_OFF_MOVEMENT_TYPE,
  formatArchiveStockBlockMessage,
  formatBulkArchiveStockBlockMessage,
  formatHoldingLabel,
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
