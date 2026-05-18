/**
 * AI Shelf Scan — prompt assembly + response parsing.
 *
 * Pure functions, no Supabase / network deps, so the route handler
 * stays thin and these can be unit-tested in isolation. See
 * docs/superpowers/specs/2026-05-17-ai-shelf-scan-design.md for
 * the design rationale.
 */
import { SchemaType, type ResponseSchema } from '@google/generative-ai';

/**
 * Confidence below this forces an explicit user-tap-to-confirm on the
 * review screen (amber chip). At or above, the line auto-pre-fills
 * with a green chip — still tap-able to override, but no review
 * required. Tuned from the initial Gemini-2.0-Flash calibration on
 * book covers: ≥0.85 is roughly the inflection point where false
 * positives start dropping below 5%.
 */
export const AI_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Description of one cycle-count line as the AI sees it. The mapping
 * back to the actual line + item rows happens in the route handler
 * after parsing.
 */
export interface ShelfScanLineInput {
  /** cycle_count_lines.id — round-trips to identify the row to update. */
  lineId: string;
  /** Item SKU — Gemini's primary identifier in the response. */
  sku: string;
  /** Item display name (book title). Helps Gemini disambiguate when
   *  the SKU isn't visible in the photo (almost always). */
  name: string;
  /** ISBN if known. Most book rows have it stored on `barcode` or in
   *  custom_fields. Boosts accuracy when the back-cover is visible. */
  isbn?: string | null;
  /** Author. Used by the model to disambiguate when titles repeat
   *  across editions. */
  author?: string | null;
}

/**
 * Parsed entry from the Gemini response, mapped back to the cycle
 * count line + filtered to remove any hallucinated SKUs.
 */
export interface ShelfScanResult {
  lineId: string;
  sku: string;
  count: number;
  /** Clamped to [0, 1]. */
  confidence: number;
  notes?: string;
}

/**
 * Structured-output schema we pass to Gemini. The generative-ai SDK
 * enforces this on the model side so we never need to defensively
 * parse free-form text.
 */
export const SHELF_SCAN_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    results: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          sku: { type: SchemaType.STRING },
          count: { type: SchemaType.INTEGER },
          confidence: { type: SchemaType.NUMBER },
          notes: { type: SchemaType.STRING },
        },
        required: ['sku', 'count', 'confidence'],
      },
    },
  },
  required: ['results'],
};

/**
 * Builds the Gemini prompt. Keeps the title-set inline as JSON so the
 * model has a strict allowlist of SKUs to choose from; the parser
 * still filters defensively in case it goes off-script.
 */
export function buildShelfScanPrompt(lineSet: readonly ShelfScanLineInput[]): string {
  // Reduce to the minimum fields the model needs — keeps the prompt
  // tight and avoids leaking internal IDs to the model context.
  const titleSet = lineSet.map((l) => ({
    sku: l.sku,
    title: l.name,
    ...(l.author ? { author: l.author } : {}),
    ...(l.isbn ? { isbn: l.isbn } : {}),
  }));

  return [
    'You are counting visible books on the shelf in this photo against a known set of titles.',
    'Return a JSON object {"results": [...]}. Each result has:',
    '  - sku: must match EXACTLY one of the provided SKUs (case-sensitive). Do not invent SKUs.',
    '  - count: how many copies of that title you can see (whole number ≥ 0).',
    '  - confidence: 0.0 to 1.0 — your certainty that the title and count are both correct.',
    '  - notes: optional one-sentence rationale.',
    '',
    'Rules:',
    '- Only return rows for titles you can clearly see in the image. Do not guess.',
    '- If the same title appears multiple times, return ONE result with count = total copies visible.',
    '- A spine half-occluded but identifiable counts — include it with lower confidence.',
    '- Books in frame that AREN\'T in the title set: ignore them entirely.',
    '- If nothing in the title set is visible, return {"results": []}.',
    '',
    'Title set (only consider these — pick by SKU):',
    JSON.stringify(titleSet, null, 2),
  ].join('\n');
}

/**
 * Parses Gemini's structured output, clamps confidence, drops SKUs
 * that don't exist in the line set (hallucinations), and maps each
 * matched SKU back to its `lineId` so the mobile review screen can
 * pre-fill the right rows.
 *
 * Returns a clean list of results. Never throws — a malformed
 * response or a response with no matches simply yields an empty
 * array, which the caller renders as the "nothing detected" state.
 */
export function parseShelfScanResponse(
  raw: string,
  lineSet: readonly ShelfScanLineInput[],
): ShelfScanResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some Gemini fallback paths wrap output in ```json fences even
    // when the structured-output schema should prevent it. Strip and
    // retry once before giving up.
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return [];
    }
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('results' in parsed) ||
    !Array.isArray((parsed as { results: unknown }).results)
  ) {
    return [];
  }

  // O(1) SKU → lineId lookup — keeps the filter cheap even on counts
  // with hundreds of lines.
  const lineBySku = new Map<string, ShelfScanLineInput>();
  for (const l of lineSet) {
    lineBySku.set(l.sku, l);
  }

  const results: ShelfScanResult[] = [];
  for (const entry of (parsed as { results: unknown[] }).results) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as {
      sku?: unknown;
      count?: unknown;
      confidence?: unknown;
      notes?: unknown;
    };
    if (typeof row.sku !== 'string') continue;
    const matched = lineBySku.get(row.sku);
    if (!matched) continue; // hallucinated SKU — drop silently

    const count =
      typeof row.count === 'number' && Number.isFinite(row.count) && row.count >= 0
        ? Math.floor(row.count)
        : null;
    if (count === null) continue;

    const rawConfidence = typeof row.confidence === 'number' ? row.confidence : 0;
    const confidence = Math.max(0, Math.min(1, rawConfidence));

    results.push({
      lineId: matched.lineId,
      sku: matched.sku,
      count,
      confidence,
      ...(typeof row.notes === 'string' && row.notes.length > 0
        ? { notes: row.notes.slice(0, 500) }
        : {}),
    });
  }

  return results;
}

/**
 * Convenience predicate so call sites stay readable.
 */
export function isHighConfidence(c: number): boolean {
  return c >= AI_CONFIDENCE_THRESHOLD;
}
