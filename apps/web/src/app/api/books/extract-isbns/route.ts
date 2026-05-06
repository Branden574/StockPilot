import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { extractIsbnsFromFile } from '@/lib/books/isbn-extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// PDF / xlsx parsing on bigger files can take a few seconds.
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — generous for textbook order sheets

/**
 * POST a multipart/form-data with a single `file` field. Returns
 * the ISBNs the parser found in that file, normalized + deduped.
 *
 *   Request:  FormData { file: File }
 *   Response: { ok: true, kind, isbns: string[], totalFound, empty }
 *
 * Auth-gated to org members so we don't burn server CPU on parsing
 * uploads from unauthenticated traffic.
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
        message: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 10 MB — split into smaller files.`,
      },
      { status: 413 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await extractIsbnsFromFile(buffer, file.name, file.type || null);
    if (result.kind === 'image') {
      // Regex can't read images. Tell the client to use the AI path.
      return NextResponse.json(
        {
          error: 'unsupported_for_regex',
          message:
            'Images and scanned files have no text layer the regex can scan. Use "Extract with AI" for images and scanned PDFs.',
        },
        { status: 400 },
      );
    }
    return NextResponse.json({
      ok: true,
      kind: result.kind,
      isbns: result.isbns,
      totalFound: result.isbns.length,
      empty: result.empty,
      filename: file.name,
    });
  } catch (err) {
    void reportError(err, {
      tag: 'books.extract-isbns',
      organizationId: ctx.organizationId,
      extra: { filename: file.name, size: file.size },
    });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'Could not parse this file.',
      },
      { status: 400 },
    );
  }
}
