/**
 * Deterministic group + variant identity. Pure, no platform imports.
 *
 * These functions are the ONLY place identity keys are built. Web, Expo and
 * the server all call them, so a shoe added on a phone and the same shoe
 * arriving on a PO resolve to the same group_key. Requirements: "Matching
 * deterministic (keys above), never name-string-only."
 */

import type { SportsSubcategoryKey } from './tracking-modes';

/** Lower-case, collapse internal whitespace, trim. Never used for display. */
function norm(v: string | null | undefined): string {
  if (v == null) return '';
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a jersey/uniform number.
 *
 * Leading zeroes are MEANINGFUL and preserved: 0, 00, 07 and 7 are four
 * distinct numbers, and a player wearing 00 is not the same as one wearing 0.
 * This is why the value is TEXT and never an integer anywhere in the stack.
 *
 * Returns null for blank input. Throws nothing — validation lives in zod so
 * the caller controls the error surface.
 */
export function normalizeJerseyNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // Strip a leading '#' and surrounding whitespace, which is how these arrive
  // from spreadsheets ("#12", " 07 ").
  const trimmed = raw.trim().replace(/^#+/, '').trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/** True when the value is a legal jersey number: 1-4 digits, digits only. */
export function isValidJerseyNumber(v: string): boolean {
  return /^[0-9]{1,4}$/.test(v);
}

/**
 * Normalize a size for MATCHING. The caller must keep the original string
 * separately (inventory_items.variant_size_original) — requirements: "Keep
 * original imported text + normalized form".
 *
 * Rules, deliberately conservative:
 *   * Alpha sizes upper-case: ' xl ' -> 'XL'
 *   * Numeric sizes lose a trailing '.0' but KEEP halves: '10.0' -> '10',
 *     '10.5' -> '10.5'
 *   * A leading size-system word is stripped ONLY when it is redundant with
 *     the sizeSystem argument: normalizeSizeValue('US 10', 'US_MENS') -> '10'
 *
 * NEVER converts between systems. A UK 9 is not silently turned into a US 10;
 * that requires an approved mapping which does not exist yet.
 */
export function normalizeSizeValue(
  raw: string | null | undefined,
  sizeSystem?: string | null,
): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  // Strip a redundant system prefix ('US 10' under US_MENS -> '10').
  if (sizeSystem) {
    const prefix = sizeSystem.split('_')[0]?.toLowerCase();
    if (prefix) {
      const re = new RegExp(`^${prefix}\\s+`, 'i');
      s = s.replace(re, '').trim();
    }
  }

  // Numeric size: strip a trailing '.0' but never round a half away.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isInteger(n) ? String(n) : String(n);
  }

  return s.toUpperCase();
}

/** Attributes that identify a GROUP. Every field is optional; the key is the join. */
export interface GroupKeyParts {
  subcategoryKey: SportsSubcategoryKey | string;
  brand?: string | null;
  model?: string | null;
  styleNumber?: string | null;
  colorway?: string | null;
  team?: string | null;
  league?: string | null;
  season?: string | null;
  homeAway?: string | null;
  manufacturer?: string | null;
  color?: string | null;
  /** Fallback identity when nothing else is supplied. */
  name?: string | null;
}

/**
 * Build the group identity key.
 *
 * Shoes:   (subcat, brand, model, style_number, colorway)
 * Jerseys: (subcat, team, league, season, home_away, manufacturer, brand, style_number, color)
 *
 * The subcategory decides which slots participate, so a shoe key and a jersey
 * key can never collide. `name` is the LAST-RESORT slot and only participates
 * when every identifying attribute is blank — that is what stops this from
 * being name-string-only matching.
 *
 * `manufacturer` and `brand` are kept as two INDEPENDENT slots (never merged
 * with `??`) even though a jersey often only carries one of the two — folding
 * them together would let a manufacturer-only group and a brand-only group
 * collide on the same slot despite meaning different things.
 */
export function buildGroupKey(parts: GroupKeyParts): string {
  const sub = norm(parts.subcategoryKey);
  const slots: string[] =
    sub === 'jerseys' || sub === 'uniforms'
      ? [
          norm(parts.team),
          norm(parts.league),
          norm(parts.season),
          norm(parts.homeAway),
          norm(parts.manufacturer),
          norm(parts.brand),
          norm(parts.styleNumber),
          norm(parts.color),
        ]
      : [
          norm(parts.brand),
          norm(parts.model),
          norm(parts.styleNumber),
          norm(parts.colorway),
        ];

  const identifying = slots.filter((s) => s.length > 0);
  if (identifying.length === 0) {
    // Nothing identifying at all — fall back to the name so a group can still
    // be created, but mark it so the import review can flag it as weak.
    return `${sub}|name:${norm(parts.name)}`;
  }
  return [sub, ...slots].join('|');
}

/** Attributes that identify a VARIANT within its group. */
export interface VariantKeyParts {
  size?: string | null;
  sizeSystem?: string | null;
  width?: string | null;
  fit?: string | null;
  color?: string | null;
  jerseyNumber?: string | null;
  /** Only participates when the org groups jerseys by player (see open questions). */
  playerName?: string | null;
}

/**
 * Build the variant identity key. Slots are NAMED so an absent width and an
 * absent fit cannot shift a value into the wrong position.
 */
export function buildVariantKey(parts: VariantKeyParts): string {
  const pairs: Array<[string, string]> = [];
  const push = (k: string, v: string | null | undefined) => {
    const n = norm(v);
    if (n.length > 0) pairs.push([k, n]);
  };
  // jersey_number FIRST so a numbered variant sorts and reads naturally.
  push('number', parts.jerseyNumber);
  push('player', parts.playerName);
  push('size', parts.size);
  push('system', parts.sizeSystem);
  push('width', parts.width);
  push('fit', parts.fit);
  push('color', parts.color);
  if (pairs.length === 0) return 'default';
  return pairs.map(([k, v]) => `${k}=${v}`).join('|');
}

/** Human roll-up label: "6 variants · 52 pairs total". */
export function groupRollupLabel(
  variantCount: number,
  totalQuantity: number,
  countingUnitPlural: string,
): string {
  const v = `${variantCount} ${variantCount === 1 ? 'variant' : 'variants'}`;
  return `${v} · ${totalQuantity} ${countingUnitPlural} total`;
}
