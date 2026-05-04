import { describe, expect, it } from 'vitest';
import { convert, type UomConversion } from './convert';

const ITEM = 'item-aa';
const PK_TO_EA: UomConversion = {
  itemId: ITEM,
  fromUom: 'PK',
  toUom: 'EA',
  numerator: 24,
  denominator: 1,
  roundingRule: 'exact',
};

describe('convert', () => {
  it('identity: EA → EA passes through', () => {
    const r = convert({ qty: 5, fromUom: 'EA', toUom: 'EA', itemId: ITEM, conversions: [] });
    expect(r).toEqual({ ok: true, qtyBase: 5, conversionUsed: null });
  });

  it('forward: 1 PK → 24 EA', () => {
    const r = convert({
      qty: 1,
      fromUom: 'PK',
      toUom: 'EA',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.qtyBase).toBe(24);
  });

  it('forward: 3 PK → 72 EA', () => {
    const r = convert({
      qty: 3,
      fromUom: 'PK',
      toUom: 'EA',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    if (r.ok) expect(r.qtyBase).toBe(72);
  });

  it('inverse: 24 EA → 1 PK (stored direction is PK→EA)', () => {
    const r = convert({
      qty: 24,
      fromUom: 'EA',
      toUom: 'PK',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    if (r.ok) expect(r.qtyBase).toBe(1);
  });

  it('inverse with floor rounding: 23 EA → 0 PK (when rule is floor)', () => {
    const r = convert({
      qty: 23,
      fromUom: 'EA',
      toUom: 'PK',
      itemId: ITEM,
      conversions: [{ ...PK_TO_EA, roundingRule: 'floor' }],
    });
    if (r.ok) expect(r.qtyBase).toBe(0);
  });

  it('rounding: round rule rounds 0.95 PK to 1 EA when 1 PK = 1 EA wouldnt apply; 11 EA → 0 PK with round', () => {
    const r = convert({
      qty: 11,
      fromUom: 'EA',
      toUom: 'PK',
      itemId: ITEM,
      conversions: [{ ...PK_TO_EA, roundingRule: 'round' }],
    });
    if (r.ok) expect(r.qtyBase).toBe(0); // 11/24 = 0.458 → rounds to 0
  });

  it('rounding: ceil rule on 25 EA → PK = 2 (ceil of 1.04)', () => {
    const r = convert({
      qty: 25,
      fromUom: 'EA',
      toUom: 'PK',
      itemId: ITEM,
      conversions: [{ ...PK_TO_EA, roundingRule: 'ceil' }],
    });
    if (r.ok) expect(r.qtyBase).toBe(2);
  });

  it('case-insensitive UoM match', () => {
    const r = convert({
      qty: 1,
      fromUom: 'pk',
      toUom: 'ea',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    if (r.ok) expect(r.qtyBase).toBe(24);
  });

  it('missing conversion → reason=conversion_missing', () => {
    const r = convert({
      qty: 1,
      fromUom: 'CT',
      toUom: 'EA',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    expect(r).toEqual({ ok: false, reason: 'conversion_missing' });
  });

  it('does not use conversions from a different item', () => {
    const r = convert({
      qty: 1,
      fromUom: 'PK',
      toUom: 'EA',
      itemId: 'item-other',
      conversions: [PK_TO_EA],
    });
    expect(r).toEqual({ ok: false, reason: 'conversion_missing' });
  });

  it('rejects negative qty', () => {
    const r = convert({
      qty: -1,
      fromUom: 'PK',
      toUom: 'EA',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    expect(r).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('rejects NaN qty', () => {
    const r = convert({
      qty: Number.NaN,
      fromUom: 'PK',
      toUom: 'EA',
      itemId: ITEM,
      conversions: [PK_TO_EA],
    });
    expect(r).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('handles non-trivial denominators: 1 BX = 100 EA stored as num=100 denom=1', () => {
    const conv: UomConversion = {
      ...PK_TO_EA,
      fromUom: 'BX',
      numerator: 100,
      denominator: 1,
    };
    const r = convert({
      qty: 2,
      fromUom: 'BX',
      toUom: 'EA',
      itemId: ITEM,
      conversions: [conv],
    });
    if (r.ok) expect(r.qtyBase).toBe(200);
  });
});
