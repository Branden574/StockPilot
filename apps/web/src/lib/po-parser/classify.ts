import type { PoImportLineType } from '@stockpilot/core';

export interface ClassifyContext {
  /** Signed line total (negative = credit). Optional secondary signal. */
  signedAmount?: number;
}

/**
 * Classifies a PO line by description (and optionally a signed amount) into
 * one of the line_type buckets. Pure function — no I/O, deterministic.
 *
 * Priority: explicit keyword in description > signed-amount fallback >
 * inventory if the string looks like a product name > unknown.
 */
export function classifyLine(
  description: string | null | undefined,
  ctx: ClassifyContext = {},
): PoImportLineType {
  const text = (description ?? '').trim().toLowerCase();
  if (!text) return 'unknown';

  // Order matters — most specific first.
  if (/\btax(es)?\b/.test(text)) return 'tax';
  if (/\b(freight|shipping|delivery|carrier)\b/.test(text)) return 'freight';
  if (/\b(handling|processing)\b/.test(text) && /\b(fee|surcharge|charge)\b/.test(text)) {
    return 'fee';
  }
  if (/\b(fee|surcharge)\b/.test(text)) return 'fee';
  if (/\b(installation|labor|warranty|service|repair|subscription)\b/.test(text)) {
    return 'service';
  }
  if (/\b(discount|credit|rebate)\b/.test(text)) return 'discount';
  if (typeof ctx.signedAmount === 'number' && ctx.signedAmount < 0) return 'discount';

  // If the string is gibberish (just punctuation or single-char noise), unknown.
  if (!/[a-z]{3,}/.test(text)) return 'unknown';

  return 'inventory';
}
