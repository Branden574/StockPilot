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
 *
 * U2: float precision limit. Computation is `(qty * numerator) /
 * denominator`. JavaScript numbers are IEEE-754 doubles, so the result is
 * exact only while every intermediate stays under 2^53 ≈ 9e15. For real
 * inventory quantities (single-digit thousands × small numerator) this is
 * many orders of magnitude away from precision loss, but if a future
 * vendor ever ships absurdly-large numerators or quantities — say a
 * pallet ratio with `numerator = 1_000_000` and a 10M-EA receipt —
 * `applyRounding` may round to a value that's off by 1. A bigint refactor
 * was considered and rejected as too invasive for v1.
 *
 * U4: transitive inconsistency is not detected. If admin defines both
 * `CT → PK = 6` and `PK → EA = 24`, this helper does NOT auto-derive
 * `CT → EA`. Worse, if admin also defines `CT → EA = 200` (instead of the
 * arithmetically correct 144), there's no check that flags the
 * inconsistency. Documented as a known limitation; admin tooling is the
 * place to surface multi-hop conversion suggestions if/when needed.
 *
 * U8: `Math.round` is half-to-even-ish — it actually rounds half AWAY from
 * zero for positive numbers (so `Math.round(0.5) = 1`, `Math.round(1.5) =
 * 2`, `Math.round(2.5) = 3`). This is the spec-defined behavior but can
 * surprise users coming from bankers'-rounding contexts (where 2.5 → 2).
 * If you need bankers' rounding pick a different rule and add it here.
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
