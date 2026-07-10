import 'server-only';

import {
  GoogleGenerativeAI,
  SchemaType,
  type Part,
} from '@google/generative-ai';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
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

function buildModel() {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. AI extract is disabled until you add a key.',
    );
  }
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema as never,
    },
  });
}

function parseCandidates(raw: string): AiExtractCandidate[] {
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

async function callModelOnText(text: string): Promise<AiExtractCandidate[]> {
  const trimmed =
    text.length > MAX_PROMPT_CHARS
      ? text.slice(0, MAX_PROMPT_CHARS) +
        `\n\n[truncated; original was ${text.length} chars]`
      : text;
  if (resolveAiProvider() === 'claude') {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. AI extract is disabled until you add a key.');
    }
    const raw = await claudeGenerateJsonString({
      system: SYSTEM_PROMPT,
      prompt: trimmed,
      schema: responseSchema as unknown as Record<string, unknown>,
    });
    return parseCandidates(raw);
  }
  const model = buildModel();
  const result = await model.generateContent(trimmed);
  return parseCandidates(result.response.text());
}

/**
 * Multimodal call. Sends the raw file bytes (PDF or image) to
 * Gemini as inlineData, which means scanned/image PDFs and photos
 * of order sheets get OCR'd by the model itself — no local
 * tesseract dependency needed. PDF inline data is supported up to
 * roughly 50 MB or 1000 pages on Gemini 2.5 Flash; we cap upload
 * size separately at 10 MB so this is fine in practice.
 */
async function callModelOnBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<AiExtractCandidate[]> {
  const instruction =
    'Extract every ISBN you can find in the attached document, including ones inside images, tables, or scans. Follow the schema.';
  if (resolveAiProvider() === 'claude') {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. AI extract is disabled until you add a key.');
    }
    const raw = await claudeGenerateJsonString({
      system: SYSTEM_PROMPT,
      prompt: instruction,
      media: [{ data: buffer.toString('base64'), mediaType: mimeType }],
      schema: responseSchema as unknown as Record<string, unknown>,
    });
    return parseCandidates(raw);
  }
  const model = buildModel();
  const parts: Part[] = [
    { inlineData: { data: buffer.toString('base64'), mimeType } },
    { text: instruction },
  ];
  const result = await model.generateContent(parts);
  return parseCandidates(result.response.text());
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

/**
 * Internal: do the merge + verification dance given a regex
 * baseline and a set of AI candidates. Used by both the text-based
 * and buffer-based public entry points.
 */
async function mergeRegexAndAi(
  regexHits: string[],
  aiCandidates: AiExtractCandidate[],
): Promise<AiExtractResult> {
  const regexSet = new Set(regexHits);
  const verifiedLowConf = await verifyLowConfidence(aiCandidates);

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
    provenance.push({ ...c, source: 'ai', verified: c.confidence === 'low' });
  }

  const aiAdded = finalIsbns.length - regexHits.length;
  const droppedLowConf = aiCandidates.filter(
    (c) =>
      c.confidence === 'low' && !verifiedLowConf.has(c.isbn) && !regexSet.has(c.isbn),
  ).length;
  const notes = [
    `${regexHits.length} regex hit${regexHits.length === 1 ? '' : 's'}`,
    aiAdded > 0 ? `+${aiAdded} from AI` : null,
    droppedLowConf > 0
      ? `${droppedLowConf} unverified guess${droppedLowConf === 1 ? '' : 'es'} dropped`
      : null,
  ]
    .filter(Boolean)
    .join(', ');

  return { isbns: finalIsbns, candidates: provenance, notes };
}

/**
 * Buffer entry point — call this for PDFs and images. Lets Gemini
 * OCR scanned content directly. The regex pass runs against an empty
 * baseline (we don't pre-extract text), so all hits come from the
 * AI. Low-confidence guesses are still verified against the lookup
 * pipeline before being kept.
 */
export async function aiExtractIsbnsFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<AiExtractResult> {
  let aiCandidates: AiExtractCandidate[] = [];
  try {
    aiCandidates = await callModelOnBuffer(buffer, mimeType);
  } catch (err) {
    return {
      isbns: [],
      candidates: [],
      notes: `AI extraction unavailable (${err instanceof Error ? err.message : 'error'}).`,
    };
  }
  return mergeRegexAndAi([], aiCandidates);
}

export async function aiExtractIsbns(text: string): Promise<AiExtractResult> {
  const regexHits = extractIsbnsFromText(text);
  let aiCandidates: AiExtractCandidate[] = [];
  try {
    aiCandidates = await callModelOnText(text);
  } catch (err) {
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
  return mergeRegexAndAi(regexHits, aiCandidates);
}
