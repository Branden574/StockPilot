import 'server-only';

import { isValidIsbn13 } from '@stockpilot/core';

import { ServiceError } from '@/server/services/context';

import { normalizeIsbn } from './lookup';

/** Written over an ISBN-13 match before the ISBN-10 pass: not a digit, X,
 *  space or dash, so no ISBN-10 can match on or across it. */
const HIDDEN = '#';

/**
 * Extract ISBN candidates from arbitrary text by scanning for any
 * sequence of 10 or 13 digits (with optional dashes/spaces between
 * them). Each match is run through normalizeIsbn() so non-ISBN
 * digit runs (page numbers, dates, phone numbers) get dropped if
 * they don't normalize to a valid 10/13-char ISBN.
 *
 * Returns ISBNs in the order they appear, deduped (first occurrence
 * wins). Caller decides whether to keep the order or sort.
 */
export function extractIsbnsFromText(text: string): string[] {
  if (!text) return [];
  // Two regexes: ISBN-13 first, then ISBN-10. Both allow optional
  // dashes/spaces between digit groups.
  const isbn13 = /(?:^|[^0-9])((?:97[89])(?:[\s-]?\d){10})(?=[^0-9]|$)/g;
  const isbn10 = /(?:^|[^0-9Xx])(\d(?:[\s-]?\d){8}[\s-]?[0-9Xx])(?=[^0-9Xx]|$)/g;

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (candidate: string) => {
    const normalized = normalizeIsbn(candidate);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  // The ISBN-10 pass reads the text with each checksum-valid ISBN-13 match
  // hidden (docket B76). Written with a dash or a space after its prefix
  // ("978-0-306-40615-7"), an ISBN-13 holds ten digits the ISBN-10 pattern
  // also matches ("0-306-40615-7"), and each was added as a made-up ISBN-10
  // that is looked up and fails (a 979 one as its first ten digits). A
  // 13-digit reading that fails its checksum stays visible, so a real ISBN-10
  // after a stray "978" is still found.
  const parts: string[] = [];
  let shown = 0;
  for (const m of text.matchAll(isbn13)) {
    const candidate = m[1] ?? '';
    add(candidate);
    if (!isValidIsbn13(candidate)) continue;
    // The match may start with the one character before the ISBN; the
    // ISBN itself ends the match.
    const start = m.index + m[0].length - candidate.length;
    parts.push(text.slice(shown, start), HIDDEN.repeat(candidate.length));
    shown = start + candidate.length;
  }
  parts.push(text.slice(shown));
  for (const m of parts.join('').matchAll(isbn10)) add(m[1] ?? '');
  return out;
}

export type SupportedFileKind =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'txt'
  | 'image';

export interface ExtractFromFileResult {
  kind: SupportedFileKind;
  isbns: string[];
  /** True when the file's text content was empty / unreadable. */
  empty: boolean;
}

/**
 * Detect file kind from filename extension first (cheap + reliable
 * for user-uploaded files), then fall back to MIME type. Returns
 * null when we don't have a parser for it.
 */
export function detectFileKind(
  filename: string,
  mimeType: string | null,
): SupportedFileKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.txt')) return 'txt';
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.heic')
  ) {
    return 'image';
  }

  const mt = (mimeType ?? '').toLowerCase();
  if (mt === 'application/pdf') return 'pdf';
  if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (
    mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mt === 'application/vnd.ms-excel'
  )
    return 'xlsx';
  if (mt === 'text/csv') return 'csv';
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('text/')) return 'txt';
  return null;
}

async function fileToText(buffer: Buffer, kind: SupportedFileKind): Promise<string> {
  switch (kind) {
    case 'pdf': {
      // Importing the lib path directly avoids pdf-parse's index
      // module trying to read a sample PDF on load.
      const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
        default: (b: Buffer) => Promise<{ text: string }>;
      };
      const out = await mod.default(buffer);
      return out.text ?? '';
    }
    case 'docx': {
      const mod = await import('mammoth');
      const result = await mod.extractRawText({ buffer });
      return result.value ?? '';
    }
    case 'xlsx': {
      const { xlsxBufferToCsv } = await import('@/lib/xlsx-to-csv');
      return xlsxBufferToCsv(buffer);
    }
    case 'csv':
    case 'txt':
      return buffer.toString('utf8');
    case 'image':
      // Images carry no text-layer content for our regex pass —
      // callers should route image kinds to the AI multimodal path
      // (lib/books/isbn-ai-extract.ts → aiExtractIsbnsFromBuffer).
      return '';
  }
}

export async function extractIsbnsFromFile(
  buffer: Buffer,
  filename: string,
  mimeType: string | null,
): Promise<ExtractFromFileResult> {
  const kind = detectFileKind(filename, mimeType);
  if (!kind) {
    // A ServiceError: the one sentence written for the person, which the
    // extract-isbns route answers as it is (every other failure there is a
    // library's text, answered with a fixed sentence and reported).
    throw new ServiceError(
      'validation_error',
      'Unsupported file type. Accepted: PDF, Word (.docx), Excel (.xlsx/.xls), CSV, TXT.',
    );
  }
  const text = await fileToText(buffer, kind);
  const isbns = extractIsbnsFromText(text);
  return { kind, isbns, empty: text.trim().length === 0 };
}
