import { describe, expect, it } from 'vitest';
import { transferableHoldings } from '@/lib/placements';

describe('transferableHoldings', () => {
  it('excludes items where kind is staging or unplaced (with qty > 0)', () => {
    const holdings = [
      { kind: 'staging', quantity: 5 },
      { kind: 'unplaced', quantity: 3 },
      { kind: 'rack', quantity: 10 },
    ];
    const result = transferableHoldings(holdings);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'rack', quantity: 10 });
  });

  it('excludes items where quantity <= 0', () => {
    const holdings = [
      { kind: 'rack', quantity: 0 },
      { kind: 'bin', quantity: -1 },
      { kind: 'rack', quantity: 5 },
    ];
    const result = transferableHoldings(holdings);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'rack', quantity: 5 });
  });

  it('keeps items with kind rack, bin, or null when quantity > 0', () => {
    const holdings = [
      { kind: 'rack', quantity: 8 },
      { kind: 'bin', quantity: 2 },
      { kind: null, quantity: 4 },
    ];
    const result = transferableHoldings(holdings);
    expect(result).toHaveLength(3);
  });
});
