import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  aiExtractIsbns,
  aiExtractIsbnsFromBuffer,
} from '@/lib/books/isbn-ai-extract';
import { detectFileKind } from '@/lib/books/isbn-extract';
import { reportError } from '@/lib/error-reporter';
import { classifyAiError } from '@/lib/ai/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Multimodal Gemini calls on big PDFs can take 20-40s.
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * AI-augmented ISBN extraction. PDFs and images go straight to
 * Gemini's multimodal API, so scanned/image PDFs and photos of
 * order sheets get OCR'd and parsed in one call — no local OCR
 * dependency. Office docs and plain text are extracted to a string
 * locally first (cheaper) and run through the text-based path.
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
        message:
          'Unsupported file type. Accepted: PDF, Word, Excel, CSV, TXT, and common images (PNG/JPG/WEBP/HEIC).',
      },
      { status: 400 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // PDFs (including scanned/image PDFs) and standalone images go
    // through Gemini's multimodal API — it does the OCR for us, no
    // tesseract dependency. Office docs and text get pre-extracted
    // locally to keep tokens cheap.
    if (kind === 'pdf' || kind === 'image') {
      const mime =
        kind === 'pdf' ? 'application/pdf' : (file.type || 'image/png');
      const result = await aiExtractIsbnsFromBuffer(buffer, mime);
      return NextResponse.json({
        ok: true,
        kind,
        isbns: result.isbns,
        totalFound: result.isbns.length,
        candidates: result.candidates,
        notes: result.notes,
        filename: file.name,
        path: 'multimodal',
      });
    }

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
      path: 'text',
    });
  } catch (err) {
    void reportError(err, {
      tag: 'books.extract-isbns-ai',
      organizationId: ctx.organizationId,
      extra: { filename: file.name, size: file.size, kind },
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
  // csv / txt fall through here.
  return buffer.toString('utf8');
}
