import 'server-only';

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
import { env } from '@/lib/env';

import type { BookMetadata } from './lookup';

/**
 * 5th-source ISBN lookup via Gemini. Used ONLY as a fallback after
 * the 4 free public APIs (Google Books, Open Library × 2, LoC) all
 * return nothing — typically academic / educational publishers
 * (HMH, Pearson, McGraw-Hill, etc.) whose ISBNs aren't catalogued
 * in consumer book databases.
 *
 * HALLUCINATION GUARD
 *   - Strict structured response schema with a self-reported
 *     confidence enum. We drop everything below `medium`.
 *   - The model is told explicitly: if you don't recognize the ISBN,
 *     return null fields and confidence "low" rather than guessing.
 *   - Caller (lookup.ts) only invokes this when the free sources
 *     returned 0 — so a Gemini "low confidence" miss isn't worse
 *     than the existing failure mode.
 *
 * Returns null on:
 *   - Missing GEMINI_API_KEY (defensive — features just disable).
 *   - Low-confidence response.
 *   - Any thrown error from the SDK.
 */

const MODEL_NAME = env.GEMINI_MODEL;

const SYSTEM_PROMPT = `You identify books from ISBNs. Rules:
- If you recognize the ISBN with high or medium confidence, return
  title, authors (array), publisher, publishedDate (year is fine),
  and confidence "high" or "medium".
- If you do NOT recognize the ISBN or are guessing, return all
  fields as null and confidence "low". DO NOT invent details.
- Never include a description, page count, cover URL, or grade.
  Other sources cover those — your job is just bibliographic basics.`;

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING, nullable: true },
    authors: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    publisher: { type: SchemaType.STRING, nullable: true },
    publishedDate: { type: SchemaType.STRING, nullable: true },
    confidence: { type: SchemaType.STRING },
  },
  required: ['confidence'],
} as const;

interface GeminiBookResponse {
  title: string | null;
  authors?: string[];
  publisher: string | null;
  publishedDate: string | null;
  confidence: 'high' | 'medium' | 'low' | string;
}

/**
 * Reverse-verify an AI-claimed title against Google Books.
 *
 *   'confirmed'    — a Google Books edition of this title carries our ISBN.
 *   'contradicted' — Google Books KNOWS this title, but none of its editions
 *                    matches our ISBN (10 or 13 form) → the AI pinned a known
 *                    book onto the wrong ISBN. Drop it.
 *   'unknown'      — Google Books has no results for the title (or errored /
 *                    returned no identifiers at all) → can't disprove; keep.
 *
 * Exported for unit tests (fetch is mocked there).
 */
export async function verifyAiTitleAgainstGoogleBooks(
  isbn: string,
  title: string,
  firstAuthor: string | null,
): Promise<'confirmed' | 'contradicted' | 'unknown'> {
  try {
    const { isbnVariants } = await import('./isbn-variants');
    const ours = new Set(isbnVariants(isbn));
    if (ours.size === 0) return 'unknown';

    // NOTE: term separator must be a SPACE — a literal '+' gets percent-
    // encoded to %2B by URLSearchParams and Google returns zero results.
    const q = `intitle:"${title}"` + (firstAuthor ? ` inauthor:"${firstAuthor}"` : '');
    const params = new URLSearchParams({
      q,
      maxResults: '20',
      fields: 'items(volumeInfo(industryIdentifiers))',
    });
    if (env.GOOGLE_BOOKS_API_KEY) params.set('key', env.GOOGLE_BOOKS_API_KEY);
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'unknown';
    const data = (await res.json()) as {
      items?: Array<{
        volumeInfo?: { industryIdentifiers?: Array<{ identifier?: string }> };
      }>;
    };
    const items = data.items ?? [];
    if (items.length === 0) return 'unknown';

    const theirs = items.flatMap(
      (it) =>
        it.volumeInfo?.industryIdentifiers
          ?.map((id) => (id.identifier ?? '').replace(/[^0-9Xx]/g, '').toUpperCase())
          .filter(Boolean) ?? [],
    );
    // Editions exist but expose no ISBNs at all → can't disprove either way.
    if (theirs.length === 0) return 'unknown';
    return theirs.some((t) => ours.has(t)) ? 'confirmed' : 'contradicted';
  } catch {
    // Network hiccup must never take down the lookup — verification is
    // best-effort; fail open to the old behavior.
    return 'unknown';
  }
}

export async function fetchGeminiBookMetadata(isbn: string): Promise<BookMetadata | null> {
  const useClaude = resolveAiProvider() === 'claude';
  if (useClaude ? !env.ANTHROPIC_API_KEY : !env.GEMINI_API_KEY) return null;
  try {
    const prompt = `ISBN: ${isbn}\n\nIdentify this book. Follow the schema and confidence rules.`;
    let raw: string;
    if (useClaude) {
      raw = await claudeGenerateJsonString({
        system: SYSTEM_PROMPT,
        prompt,
        schema: responseSchema as unknown as Record<string, unknown>,
      });
    } else {
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: responseSchema as never,
        },
      });
      const result = await model.generateContent(prompt);
      raw = result.response.text();
    }
    let parsed: GeminiBookResponse;
    try {
      parsed = JSON.parse(raw) as GeminiBookResponse;
    } catch {
      return null;
    }

    // Confidence gate. Anything below medium is dropped — we'd rather
    // surface "no metadata found" than ship a hallucinated title.
    if (parsed.confidence !== 'high' && parsed.confidence !== 'medium') {
      return null;
    }
    if (!parsed.title || parsed.title.trim().length === 0) return null;

    const authors = Array.isArray(parsed.authors)
      ? parsed.authors.filter(
          (a): a is string => typeof a === 'string' && a.trim().length > 0,
        )
      : [];

    // REVERSE-VERIFICATION (hallucination guard, layer 2). The self-reported
    // confidence enum is not enough: in the field the model answered a real
    // HMH civics ISBN (9780544917149) with "The Martian" at claimed-high
    // confidence — a FAMOUS title grabbed off the publisher prefix. The
    // asymmetry that saves us: hallucinations are famous books, and famous
    // books ARE in Google Books with their real ISBNs. So look the claimed
    // title up; if Google Books KNOWS the title but none of its editions
    // carries this ISBN, the model is contradicted → drop. A title Google
    // Books has never heard of stays (that's the obscure-academic case this
    // 5th source exists for, and it can't be disproven).
    if (
      (await verifyAiTitleAgainstGoogleBooks(isbn, parsed.title.trim(), authors[0] ?? null)) ===
      'contradicted'
    ) {
      return null;
    }

    return {
      isbn,
      title: parsed.title.trim(),
      authors,
      publisher: parsed.publisher?.trim() || null,
      publishedDate: parsed.publishedDate?.trim() || null,
      // Description / pageCount / thumbnail / grade left null on purpose;
      // the model isn't asked for them and shouldn't fabricate them.
      description: null,
      pageCount: null,
      thumbnailUrl: null,
      grade: null,
      source: 'gemini',
    };
  } catch {
    return null;
  }
}
