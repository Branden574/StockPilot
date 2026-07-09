import { describe, expect, it } from 'vitest';

import { buildPoCharges, type PoChargeSourceLine } from './charges';

const ORG = 'org-1';

// Mirrors the owner's real Microix PO (PO-KVAII-001690): 4 charges + 1 item.
function ownersLines(): PoChargeSourceLine[] {
  return [
    { line_type: 'freight', description: 'Shipping', line_total: 475, line_number: 1, qty_ordered_original: 1 },
    { line_type: 'tax', description: 'Sales tax 8.35%', line_total: 3999.23, line_number: 2, qty_ordered_original: 1 },
    { line_type: 'service', description: 'White Glove Service', line_total: 900, line_number: 3, qty_ordered_original: 100, unit_cost: 9 },
    { line_type: 'fee', description: 'CA E-WASTE FEE UNDER 15 INCH', line_total: 400, line_number: 4, qty_ordered_original: 100, unit_cost: 4 },
    { line_type: 'inventory', description: 'Acer Chromebook 511', line_total: 46995, line_number: 5 },
  ];
}

describe('buildPoCharges', () => {
  it('captures every non-inventory charge from the owner PO and sums them', () => {
    const { chargeRows, chargeTotal } = buildPoCharges(ownersLines(), ORG);
    expect(chargeRows).toHaveLength(4); // the inventory line is excluded
    // Charges total: 475 + 3999.23 + 900 + 400 = 5774.23. Grand total with the
    // $46,995 of goods = $52,769.23 (matches the Microix PO exactly).
    expect(chargeTotal).toBeCloseTo(5774.23, 2);
    expect(46995 + chargeTotal).toBeCloseTo(52769.23, 2);
  });

  it('preserves each charge label, type, amount, and provenance', () => {
    const { chargeRows } = buildPoCharges(ownersLines(), ORG);
    expect(chargeRows.map((c) => [c.charge_type, c.label, c.amount])).toEqual([
      ['freight', 'Shipping', 475],
      ['tax', 'Sales tax 8.35%', 3999.23],
      ['service', 'White Glove Service', 900],
      ['fee', 'CA E-WASTE FEE UNDER 15 INCH', 400],
    ]);
    expect(chargeRows.every((c) => c.organization_id === ORG)).toBe(true);
    expect(chargeRows.map((c) => c.source_line_number)).toEqual([1, 2, 3, 4]);
    expect(chargeRows.map((c) => c.sort_order)).toEqual([0, 1, 2, 3]);
  });

  it('excludes inventory lines entirely (they never become charges)', () => {
    const { chargeRows } = buildPoCharges(
      [{ line_type: 'inventory', description: 'Widget', line_total: 100, line_number: 1 }],
      ORG,
    );
    expect(chargeRows).toHaveLength(0);
  });

  it('stores a discount as a NEGATIVE amount regardless of the parser sign', () => {
    const positiveSign = buildPoCharges(
      [{ line_type: 'discount', description: 'Volume discount', line_total: 50, line_number: 1 }],
      ORG,
    );
    const negativeSign = buildPoCharges(
      [{ line_type: 'discount', description: 'Volume discount', line_total: -50, line_number: 1 }],
      ORG,
    );
    expect(positiveSign.chargeRows[0]!.amount).toBe(-50);
    expect(negativeSign.chargeRows[0]!.amount).toBe(-50);
    expect(positiveSign.chargeTotal).toBe(-50);
  });

  it('maps an unclassified non-inventory line to "other" so its amount is never dropped', () => {
    const { chargeRows, chargeTotal } = buildPoCharges(
      [{ line_type: 'unknown', description: 'Mystery surcharge', line_total: 12.5, line_number: 1 }],
      ORG,
    );
    expect(chargeRows[0]!.charge_type).toBe('other');
    expect(chargeRows[0]!.amount).toBe(12.5);
    expect(chargeTotal).toBe(12.5);
  });

  it('null/blank labels and missing totals degrade safely', () => {
    const { chargeRows, chargeTotal } = buildPoCharges(
      [
        { line_type: 'fee', description: null, line_total: null, line_number: null },
        { line_type: 'freight', description: '   ', line_total: 10, line_number: 2 },
      ],
      ORG,
    );
    expect(chargeRows[0]!.label).toBeNull();
    expect(chargeRows[0]!.amount).toBe(0);
    expect(chargeRows[0]!.source_line_number).toBeNull();
    expect(chargeRows[1]!.label).toBeNull(); // whitespace-only → null
    expect(chargeTotal).toBe(10);
  });
});
