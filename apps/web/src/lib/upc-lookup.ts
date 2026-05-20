/**
 * UPC enrichment chain. Pure-ish module so it stays unit-testable —
 * the AI describer is injected as a callback. The route handler wires
 * in the real Gemini call.
 *
 * Chain: UPCitemdb free trial → optional Gemini description-only
 * fallback → not_found. Local-DB short-circuit happens in the route,
 * not here, because that needs the request's Supabase client.
 *
 * Strict rule: AI is ONLY used to write a description. It is never
 * asked to guess a name, brand, model number, or product identity.
 * See docs/superpowers/specs/2026-05-20-upc-lookup-and-model-number-design.md
 */

export interface UpcEnrichment {
  name: string;
  description: string | null;
  brand: string | null;
  modelNumber: string | null;
  imageUrl: string | null;
}

export type UpcLookupSource = 'upcitemdb' | 'ai-fallback' | 'not_found';

export interface UpcLookupResult {
  source: UpcLookupSource;
  enrichment: UpcEnrichment | null;
}

export interface UpcLookupOptions {
  /** Inject a real fetch (defaults to global). Lets tests stub it. */
  fetcher?: typeof fetch;
  /** Toggle the AI description fallback. Off by default in tests. */
  enableAiFallback?: boolean;
  /** Real Gemini call, injected so the chain stays unit-testable. */
  describeWithAi?: (name: string, brand: string | null) => Promise<string>;
  /** Per-request timeout in ms for UPCitemdb. Defaults to 5000. */
  timeoutMs?: number;
}

const UPCITEMDB_TRIAL_URL = 'https://api.upcitemdb.com/prod/trial/lookup';
const DEFAULT_TIMEOUT_MS = 5000;

const blankToNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
};

/**
 * Parse a UPCitemdb response into our shape. Drops blank fields to
 * null. Returns null if the response is empty OR if the first item
 * has no usable title — a hit without a name is worse than no hit.
 */
export function parseUpcitemdbResponse(raw: unknown): UpcEnrichment | null {
  if (!raw || typeof raw !== 'object') return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const first = items[0] as Record<string, unknown>;
  const name = blankToNull(first.title);
  if (!name) return null;

  const images = Array.isArray(first.images) ? (first.images as unknown[]) : [];
  const firstImage = images.length > 0 ? blankToNull(images[0]) : null;

  return {
    name,
    description: blankToNull(first.description),
    brand: blankToNull(first.brand),
    modelNumber: blankToNull(first.model),
    imageUrl: firstImage,
  };
}

/**
 * AI fills the description gap when UPCitemdb gave us a name + brand
 * but no description. We require *something* identifying (name) so AI
 * is constrained to enhance, not invent.
 */
export function shouldUseAiDescription(e: UpcEnrichment): boolean {
  if (!e.name || !e.name.trim()) return false;
  if (!e.description) return true;
  return e.description.trim().length === 0;
}

export function buildAiDescriptionPrompt(name: string, brand: string | null): string {
  const brandClause = brand && brand.trim() ? ` by ${brand.trim()}` : '';
  return (
    `Write a 2-sentence inventory description for: '${name}'${brandClause}. ` +
    `Focus on practical attributes useful to a warehouse manager (size, color, key features). ` +
    `Do not invent product specs, model numbers, or brand details — describe only what is implied by the name.`
  );
}

/**
 * Run the chain. The route handler calls this AFTER checking the
 * local DB; this function does not touch Supabase.
 */
export async function lookupUpc(
  upc: string,
  opts: UpcLookupOptions,
): Promise<UpcLookupResult> {
  const clean = String(upc ?? '').trim();
  if (!clean) throw new Error('lookupUpc: empty UPC');

  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let enrichment: UpcEnrichment | null = null;
  let source: UpcLookupSource = 'not_found';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetcher(
        `${UPCITEMDB_TRIAL_URL}?upc=${encodeURIComponent(clean)}`,
        { signal: controller.signal, headers: { accept: 'application/json' } },
      );
      if (resp.ok) {
        const json = (await resp.json()) as unknown;
        enrichment = parseUpcitemdbResponse(json);
        if (enrichment) source = 'upcitemdb';
      }
      // 429 / 5xx / 4xx all fall through to not_found — caller may still
      // trigger AI fallback below if enabled and there's something to
      // describe (currently: only when we already have a name from a hit).
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network blip, abort, parse fail — fall through to not_found
    enrichment = null;
  }

  if (
    opts.enableAiFallback &&
    enrichment &&
    shouldUseAiDescription(enrichment) &&
    opts.describeWithAi
  ) {
    try {
      const desc = await opts.describeWithAi(enrichment.name, enrichment.brand);
      const clean = desc?.trim();
      if (clean) {
        enrichment = { ...enrichment, description: clean };
        source = 'ai-fallback';
      }
    } catch {
      // AI failed → keep the partial upcitemdb data + null description
    }
  }

  return { source, enrichment };
}
