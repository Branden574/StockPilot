import 'server-only';

import { normalizeIsbn } from './lookup';

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
  // Two regexes: ISBN-13 first (so we don't capture the "978..." prefix
  // as a 10-digit by mistake), then ISBN-10. Both allow optional
  // dashes/spaces between digit groups.
  const patterns: RegExp[] = [
    /(?:^|[^0-9])((?:97[89])(?:[\s-]?\d){10})(?=[^0-9]|$)/g,
    /(?:^|[^0-9Xx])(\d(?:[\s-]?\d){8}[\s-]?[0-9Xx])(?=[^0-9Xx]|$)/g,
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const candidate = m[1] ?? '';
      const normalized = normalizeIsbn(candidate);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
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
    throw new Error(
      `Unsupported file type. Accepted: PDF, Word (.docx), Excel (.xlsx/.xls), CSV, TXT.`,
    );
  }
  const text = await fileToText(buffer, kind);
  const isbns = extractIsbnsFromText(text);
  return { kind, isbns, empty: text.trim().length === 0 };
}
