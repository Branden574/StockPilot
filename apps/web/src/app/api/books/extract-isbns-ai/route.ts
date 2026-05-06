import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { aiExtractIsbns } from '@/lib/books/isbn-ai-extract';
import { detectFileKind } from '@/lib/books/isbn-extract';
import { reportError } from '@/lib/error-reporter';
import { classifyAiError } from '@/lib/ai/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Gemini call + verification round trips can stretch into 30s on
// long documents; give plenty of headroom.
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Like /api/books/extract-isbns but augmented with a Gemini pass.
 * Picks up ISBNs the regex misses (line breaks, weird formatting,
 * spreadsheet column ordering) and proposes ISBNs for title-only
 * references. Low-confidence guesses are verified against the live
 * lookup pipeline before being returned, so we never hallucinate.
 */
export async function POST(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'validation_error', message: 'Expected multipart/form-data with a `file` field.' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Missing `file` field.' },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: 'validation_error', message: 'File is empty.' },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 10 MB.`,
      },
      { status: 413 },
    );
  }

  const kind = detectFileKind(file.name, file.type || null);
  if (!kind) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: 'Unsupported file type. Accepted: PDF, Word, Excel, CSV, TXT.',
      },
      { status: 400 },
    );
  }

  try {
    // Reuse the deterministic extractor's file-to-text pipeline by
    // calling it for plain text; we only need the text dump here.
    // The cheap path is just to call extractIsbnsFromFile and grab
    // its text — but that doesn't expose the text. So we duplicate
    // the file→text dispatch here. (Tiny cost; keeps the modules
    // independent.)
    const buffer = Buffer.from(await file.arrayBuffer());
    const text = await fileToText(buffer, kind);
    const result = await aiExtractIsbns(text);
    return NextResponse.json({
      ok: true,
      kind,
      isbns: result.isbns,
      totalFound: result.isbns.length,
      candidates: result.candidates,
      notes: result.notes,
      filename: file.name,
    });
  } catch (err) {
    void reportError(err, {
      tag: 'books.extract-isbns-ai',
      organizationId: ctx.organizationId,
      extra: { filename: file.name, size: file.size },
    });
    const classified = classifyAiError(err);
    return NextResponse.json(
      { error: classified.code, message: classified.userMessage },
      { status: classified.status },
    );
  }
}

async function fileToText(
  buffer: Buffer,
  kind: ReturnType<typeof detectFileKind>,
): Promise<string> {
  if (kind === 'pdf') {
    const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
      default: (b: Buffer) => Promise<{ text: string }>;
    };
    const out = await mod.default(buffer);
    return out.text ?? '';
  }
  if (kind === 'docx') {
    const mod = await import('mammoth');
    const r = await mod.extractRawText({ buffer });
    return r.value ?? '';
  }
  if (kind === 'xlsx') {
    const xlsx = await import('xlsx');
    const wb = xlsx.read(buffer, { type: 'buffer' });
    const chunks: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      chunks.push(xlsx.utils.sheet_to_csv(sheet));
    }
    return chunks.join('\n');
  }
  return buffer.toString('utf8');
}
