import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { PoImportsService } from '@/server/services/po-imports';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vision extraction can take 6-10s on a large multi-page PO. Tell
// Vercel to allow up to 60s before terminating.
export const maxDuration = 60;

const ACCEPT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

const MAX_BYTES_PER_FILE = 8 * 1024 * 1024; // 8 MB
const MAX_FILES = 5;
// Cumulative cap across all attached files. Per-file × max-files yields
// 40 MB which can overflow the Gemini Flash request budget on multi-page
// PDFs even when each file is within its individual cap. 24 MB leaves
// comfortable headroom under Gemini's payload ceiling.
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * Phone-scanned PO endpoint.
 *
 * Accepts multipart/form-data with one or more `file` fields (multi-frame
 * captures or multi-page scans). Optional `vendorId` and `warehouseId`
 * fields hint the vendor mapping lookup.
 *
 * Runs Gemini Flash extraction, persists a po_imports row + lines, and
 * returns the import id so the caller (mobile or web) can navigate to
 * the existing review screen.
 */
export async function POST(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // PO scan extraction is the heaviest Gemini call in the app — up to
  // 5 files * 8 MB each * multi-second vision runs. Cap at 12/min/user
  // so a single client (or a runaway upload loop) can't drain the
  // org's quota.
  const rl = await checkRateLimit(`ai-po-scan:${ctx.userId}`, 12, 60_000, 'closed');
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: 'Too many PO scans in a short window. Try again in a minute.',
        retryAt: rl.resetAt,
      },
      { status: 429 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_form', message: (e as Error).message },
      { status: 400 },
    );
  }

  const fileEntries = form.getAll('file').filter((v): v is File => v instanceof File);
  if (fileEntries.length === 0) {
    return NextResponse.json(
      { error: 'no_file', message: 'Attach at least one file under "file".' },
      { status: 400 },
    );
  }
  if (fileEntries.length > MAX_FILES) {
    return NextResponse.json(
      {
        error: 'too_many_files',
        message: `Limit is ${MAX_FILES} files per request — split into smaller scans.`,
      },
      { status: 400 },
    );
  }

  let totalBytes = 0;
  for (const f of fileEntries) {
    if (!ACCEPT_TYPES.has(f.type)) {
      return NextResponse.json(
        {
          error: 'unsupported_type',
          message: `Unsupported file type: ${f.type}. Use JPEG/PNG/WEBP/HEIC or PDF.`,
        },
        { status: 415 },
      );
    }
    if (f.size > MAX_BYTES_PER_FILE) {
      return NextResponse.json(
        {
          error: 'file_too_large',
          message: `${f.name} is ${(f.size / 1024 / 1024).toFixed(1)}MB; max is 8MB per file.`,
        },
        { status: 413 },
      );
    }
    totalBytes += f.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      {
        error: 'payload_too_large',
        message: `Combined upload is ${(totalBytes / 1024 / 1024).toFixed(1)}MB; max is ${MAX_TOTAL_BYTES / 1024 / 1024}MB across all files.`,
      },
      { status: 413 },
    );
  }

  const vendorId =
    typeof form.get('vendorId') === 'string' ? (form.get('vendorId') as string) : null;
  const warehouseId =
    typeof form.get('warehouseId') === 'string' ? (form.get('warehouseId') as string) : null;

  // Read every file's bytes upfront so Gemini gets all frames in one call.
  const files = await Promise.all(
    fileEntries.map(async (f) => ({
      bytes: new Uint8Array(await f.arrayBuffer()),
      mimeType: f.type,
      fileName: f.name,
    })),
  );

  try {
    const svc = new PoImportsService(ctx);
    const result = await svc.createFromScan({ files, vendorId, warehouseId });
    return NextResponse.json({
      ok: true,
      id: result.id,
      duplicateOf: result.duplicateOf,
      lowConfidenceLines: result.lowConfidenceLines,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'forbidden'
          ? 403
          : e.code === 'validation_error'
            ? 400
            : e.code === 'not_found'
              ? 404
              : 500;
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status },
      );
    }
    void reportError(e, {
      tag: 'po-imports.scan',
      organizationId: ctx.organizationId,
      userIdHash: ctx.userId,
    });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: e instanceof Error ? e.message : 'Scan failed.',
      },
      { status: 500 },
    );
  }
}
