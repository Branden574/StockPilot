import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  detectFileKind,
  extractIsbnsFromFile,
  ISBN_FILE_WRONG_TYPE_MESSAGE,
  uploadKindsForIsbnFile,
} from '@/lib/books/isbn-extract';
import { checkRateLimit } from '@/lib/rate-limit';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import { checkUploadBytes, UPLOAD_EMPTY_MESSAGE } from '@/server/security/upload-checks';
import { ServiceError } from '@/server/services/context';

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

  // A per-person limit before the body is read or parsed, closed like the
  // AI route beside it.
  const rl = await checkRateLimit(`isbn-extract:user:${ctx.userId}`, 20, 60_000, 'closed');
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many extractions. Try again shortly.' },
      { status: 429 },
    );
  }

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
  // An empty file: the one empty-file sentence of every upload path, and
  // nothing recorded (lab walk 6, W6-F1).
  if (file.size === 0) {
    return NextResponse.json(
      { error: 'validation_error', message: UPLOAD_EMPTY_MESSAGE },
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
    // Part 6: the bytes must be the kind the name claims, through the one
    // upload check, before any parser reads them (a refusal is recorded as a
    // security event in this organization). A name we have no parser for is
    // still the parser's own sentence below, with nothing judged.
    const claimed = detectFileKind(file.name, file.type || null);
    if (claimed) {
      const checked = await checkUploadBytes(new Uint8Array(buffer), {
        surface: 'isbn_file',
        accept: uploadKindsForIsbnFile(claimed),
        pdfHeader: 'in_first_kilobyte',
        organizationId: ctx.organizationId,
        headers: req.headers,
        wrongTypeMessage: ISBN_FILE_WRONG_TYPE_MESSAGE[claimed],
      });
      if (!checked.ok) {
        return NextResponse.json({ error: 'validation_error', message: checked.message }, { status: 400 });
      }
    }
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
  } catch (e) {
    // The parser's own sentence (an unsupported file type) as it is.
    if (e instanceof ServiceError && e.code !== 'internal_error') {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    // A PDF, Word or Excel library's text: reported, never answered (S16).
    return internalErrorResponse(e, 'books.extract-isbns', {
      organizationId: ctx.organizationId,
      extra: { filename: file.name, size: file.size },
      status: 400,
      message: 'Could not read this file. Try a different file.',
    });
  }
}
