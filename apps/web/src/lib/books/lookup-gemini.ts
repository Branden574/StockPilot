import 'server-only';

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

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

export async function fetchGeminiBookMetadata(isbn: string): Promise<BookMetadata | null> {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema as never,
      },
    });
    const result = await model.generateContent(
      `ISBN: ${isbn}\n\nIdentify this book. Follow the schema and confidence rules.`,
    );
    const raw = result.response.text();
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
