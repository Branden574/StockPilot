import 'server-only';

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

import { env } from '@/lib/env';

import { extractIsbnsFromText } from './isbn-extract';
import { lookupIsbn, normalizeIsbn } from './lookup';

/**
 * AI-augmented ISBN extraction. The deterministic regex in
 * isbn-extract.ts already handles clean ISBN runs reliably; this
 * adds a Gemini pass that's good at:
 *
 *   - ISBNs broken across lines or with weird separators
 *   - Tables / spreadsheets where the ISBN column is labeled
 *   - Title-only references like "Wonders Grade 4 Student Book" —
 *     the model proposes a likely ISBN, which we then VERIFY against
 *     the live lookup pipeline before keeping it. Unverifiable
 *     guesses are dropped, so we never hallucinate ISBNs into the
 *     user's import list.
 *
 * Returns the union of (regex hits) ∪ (model hits that resolved to
 * real metadata), deduped, in original-text order where possible.
 */

const MODEL_NAME = env.GEMINI_MODEL;
// Cap how much text we send to the model. Order sheets and PDFs can
// be huge; the model only needs enough context to find ISBNs/titles.
const MAX_PROMPT_CHARS = 80_000;

const SYSTEM_PROMPT = `You extract book references from text dumps of
PDFs, Word docs, Excel sheets, and CSVs. Return ONLY the structured
JSON described in the function call schema. Rules:

- Find every ISBN-10 or ISBN-13. Normalize to digits-only (no dashes
  or spaces). For ISBN-10 keep a trailing X uppercase.
- If the text references a book by title (with or without author /
  publisher) but no ISBN is given, propose your best guess at the
  ISBN-13 and include the title and author in the same row so a
  human can sanity-check it. Mark such rows with confidence "low".
- Confidence is "high" when the ISBN is printed in the text exactly,
  "medium" when you reconstructed digits across line breaks, "low"
  when you guessed from title/author alone.
- Do not invent titles. If you only have an ISBN, leave title null.
- Drop any candidate that isn't a plausible ISBN (10 or 13 digits,
  ISBN-13 starts with 978 or 979).`;

export interface AiExtractCandidate {
  isbn: string;
  title: string | null;
  author: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface AiExtractResult {
  isbns: string[];
  /** Per-ISBN provenance, mostly for logging/debug. */
  candidates: Array<AiExtractCandidate & { verified: boolean; source: 'regex' | 'ai' }>;
  /** Short note summarizing what happened — surfaced to the user. */
  notes: string;
}

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    candidates: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          isbn: { type: SchemaType.STRING },
          title: { type: SchemaType.STRING },
          author: { type: SchemaType.STRING },
          confidence: { type: SchemaType.STRING },
        },
        required: ['isbn', 'confidence'],
      },
    },
  },
  required: ['candidates'],
} as const;

async function callGemini(text: string): Promise<AiExtractCandidate[]> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. AI extract is disabled until you add a key.',
    );
  }
  const trimmed =
    text.length > MAX_PROMPT_CHARS
      ? text.slice(0, MAX_PROMPT_CHARS) +
        `\n\n[truncated; original was ${text.length} chars]`
      : text;

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema as never,
    },
  });
  const result = await model.generateContent(trimmed);
  const raw = result.response.text();
  let parsed: { candidates?: AiExtractCandidate[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: AiExtractCandidate[] = [];
  for (const c of parsed.candidates ?? []) {
    if (!c?.isbn) continue;
    const norm = normalizeIsbn(c.isbn);
    if (!norm) continue;
    out.push({
      isbn: norm,
      title: c.title ?? null,
      author: c.author ?? null,
      confidence:
        c.confidence === 'high' || c.confidence === 'medium' || c.confidence === 'low'
          ? c.confidence
          : 'medium',
    });
  }
  return out;
}

/**
 * Verify low-confidence candidates against the real lookup pipeline.
 * If lookupIsbn returns metadata, the ISBN exists; we keep it. If
 * not, we drop it — better to under-extract than to hallucinate a
 * fake ISBN into someone's import list.
 *
 * High/medium confidence candidates are trusted (they came directly
 * from the document text) but we still verify them lazily — if they
 * later fail in the bulk preview, that's fine.
 */
async function verifyLowConfidence(
  candidates: AiExtractCandidate[],
): Promise<Set<string>> {
  const targets = candidates.filter((c) => c.confidence === 'low');
  if (targets.length === 0) return new Set();
  const verified = new Set<string>();
  // Concurrency 4, same budget as the dashboard lookups.
  const concurrency = 4;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const c = targets[idx]!;
      try {
        const meta = await lookupIsbn(c.isbn);
        if (meta?.title) verified.add(c.isbn);
      } catch {
        // ignore — treated as unverified
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );
  return verified;
}

export async function aiExtractIsbns(text: string): Promise<AiExtractResult> {
  const regexHits = extractIsbnsFromText(text);
  const regexSet = new Set(regexHits);

  let aiCandidates: AiExtractCandidate[] = [];
  try {
    aiCandidates = await callGemini(text);
  } catch (err) {
    // If Gemini fails (billing, rate limit, etc.) fall back to the
    // regex-only result. Caller already saw regex hits as the
    // primary signal anyway.
    return {
      isbns: regexHits,
      candidates: regexHits.map((isbn) => ({
        isbn,
        title: null,
        author: null,
        confidence: 'high' as const,
        verified: true,
        source: 'regex' as const,
      })),
      notes: `AI extraction unavailable (${err instanceof Error ? err.message : 'error'}). Returning regex hits only.`,
    };
  }

  const verifiedLowConf = await verifyLowConfidence(aiCandidates);

  // Build the union: regex hits first (already ordered by appearance),
  // then AI candidates that aren't already in the regex set and pass
  // verification when low-confidence.
  const seen = new Set<string>(regexHits);
  const finalIsbns: string[] = [...regexHits];
  const provenance: AiExtractResult['candidates'] = regexHits.map((isbn) => ({
    isbn,
    title: null,
    author: null,
    confidence: 'high' as const,
    verified: true,
    source: 'regex' as const,
  }));

  for (const c of aiCandidates) {
    if (seen.has(c.isbn)) continue;
    const okToKeep = c.confidence === 'low' ? verifiedLowConf.has(c.isbn) : true;
    if (!okToKeep) continue;
    seen.add(c.isbn);
    finalIsbns.push(c.isbn);
    provenance.push({
      ...c,
      source: 'ai',
      verified: c.confidence === 'low',
    });
  }

  const aiAdded = finalIsbns.length - regexHits.length;
  const droppedLowConf =
    aiCandidates.filter(
      (c) => c.confidence === 'low' && !verifiedLowConf.has(c.isbn) && !regexSet.has(c.isbn),
    ).length;
  const notes = [
    `${regexHits.length} regex hit${regexHits.length === 1 ? '' : 's'}`,
    aiAdded > 0 ? `+${aiAdded} from AI` : null,
    droppedLowConf > 0 ? `${droppedLowConf} unverified guess${droppedLowConf === 1 ? '' : 'es'} dropped` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return { isbns: finalIsbns, candidates: provenance, notes };
}
