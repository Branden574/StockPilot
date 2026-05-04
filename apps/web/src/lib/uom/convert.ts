/**
 * Per-item UoM conversion helper.
 *
 * Conversions are stored as integer numerator/denominator to avoid float
 * drift: "1 PK = 24 EA" → numerator=24, denominator=1. This file is the
 * pure-logic side; the DB read happens in services/uom-conversions.ts.
 *
 * Identity (X → X) is always allowed. Inverse (Y → X when X → Y is stored)
 * is computed on the fly. Transitive paths (CT → PK → EA) are NOT supported
 * in v1 — admin must define the direct conversion.
 */

export type RoundingRule = 'exact' | 'floor' | 'ceil' | 'round';

export interface UomConversion {
  itemId: string;
  fromUom: string;
  toUom: string;
  numerator: number;
  denominator: number;
  roundingRule: RoundingRule;
}

export interface ConvertInput {
  qty: number;
  fromUom: string;
  toUom: string;
  itemId: string;
  conversions: UomConversion[];
}

export type ConvertResult =
  | { ok: true; qtyBase: number; conversionUsed: UomConversion | null }
  | { ok: false; reason: 'conversion_missing' | 'invalid_input' };

const eq = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

function applyRounding(value: number, rule: RoundingRule): number {
  switch (rule) {
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
    case 'round':
      return Math.round(value);
    case 'exact':
    default:
      return value;
  }
}

export function convert(input: ConvertInput): ConvertResult {
  if (!Number.isFinite(input.qty) || input.qty < 0) {
    return { ok: false, reason: 'invalid_input' };
  }

  // Identity: same UoM in/out — pass through.
  if (eq(input.fromUom, input.toUom)) {
    return { ok: true, qtyBase: input.qty, conversionUsed: null };
  }

  const matchesItem = (c: UomConversion) => c.itemId === input.itemId;

  // Direct conversion: stored fromUom → toUom.
  const direct = input.conversions
    .filter(matchesItem)
    .find((c) => eq(c.fromUom, input.fromUom) && eq(c.toUom, input.toUom));
  if (direct) {
    const raw = (input.qty * direct.numerator) / direct.denominator;
    return {
      ok: true,
      qtyBase: applyRounding(raw, direct.roundingRule),
      conversionUsed: direct,
    };
  }

  // Inverse: stored toUom → fromUom; flip the ratio.
  const inverse = input.conversions
    .filter(matchesItem)
    .find((c) => eq(c.fromUom, input.toUom) && eq(c.toUom, input.fromUom));
  if (inverse) {
    const raw = (input.qty * inverse.denominator) / inverse.numerator;
    return {
      ok: true,
      qtyBase: applyRounding(raw, inverse.roundingRule),
      conversionUsed: inverse,
    };
  }

  return { ok: false, reason: 'conversion_missing' };
}
