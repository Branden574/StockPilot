import 'server-only';

import type { UploadKind } from '@/lib/upload-inspect';
import { ServiceError } from '@/server/services/context';

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

/**
 * PART 6: the kind a file CLAIMS (its name, then its MIME, above) is only a
 * declaration. Both ISBN extractors pass the bytes through the one upload
 * check, which must find exactly this kind in them before any parser or
 * model sees the file: a PDF's header in its first kilobyte (the PO import's
 * rule: this file is parsed and dropped, never stored or served), a Word or
 * Excel container with that program's own parts and no macro or control
 * parts, text with no binary bytes, or a picture.
 */
export function uploadKindsForIsbnFile(kind: SupportedFileKind): readonly UploadKind[] {
  switch (kind) {
    case 'pdf':
      return ['pdf'];
    case 'docx':
      return ['docx'];
    case 'xlsx':
      return ['xlsx'];
    case 'csv':
    case 'txt':
      return ['text'];
    case 'image':
      return ['png', 'jpeg', 'webp', 'heic'];
  }
}

/** The sentence for a file whose bytes are not the kind it claims: what to do, not what was seen. */
export const ISBN_FILE_WRONG_TYPE_MESSAGE: Readonly<Record<SupportedFileKind, string>> = {
  pdf: 'This file is not a PDF we can read. Save it as a PDF and upload it again.',
  docx: 'This file is not a Word document we can read. Save it as .docx and upload it again.',
  xlsx: 'This file is not an Excel workbook we can read. Save it as .xlsx and upload it again.',
  csv: 'This file is not plain text. Save it as CSV or TXT and upload it again.',
  txt: 'This file is not plain text. Save it as CSV or TXT and upload it again.',
  image: 'This file is not a picture we can read. Use a PNG, JPG, WEBP or HEIC image.',
};

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
