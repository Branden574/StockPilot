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
  // 5 files * 8 MB each * multi-second vision runs. The cap exists ONLY to stop
  // a runaway/programmatic loop from draining the org's Gemini quota — NOT to
  // throttle humans. A person can't out-scan this: each scan's vision run takes
  // ~6-10s, so a real user (even batch-scanning a stack or retrying) tops out
  // around a handful per minute. Set 90/min/user — comfortably above any human
  // (incl. rapid testing) yet still a hard ceiling on an automated loop. Every
  // POST counts (the check is before the expensive call); rate-limited requests
  // do NOT increment, so a blocked user can't dig themselves deeper.
  // FAIL OPEN: authenticated endpoint (withApiContext 401s above), so a
  // transient rate-limit RPC blip should log + allow, not stonewall — matching
  // lib/rate-limit's guidance (closed mode is for unauthenticated public
  // endpoints only).
  const rl = await checkRateLimit(`ai-po-scan:${ctx.userId}`, 90, 60_000, 'open');
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

  // Separate mode ("each file is its own PO") is OPT-IN: a caller must send
  // mode='separate' AND attach 2+ files. Any client that doesn't ask (e.g. an
  // older mobile build that captures multiple frames as pages of ONE PO) keeps
  // the historical merge behavior — so this stays backward-compatible. The web
  // scan form sends mode='separate' by default; single files always combine.
  const mode =
    form.get('mode') === 'separate' && files.length >= 2 ? 'separate' : 'combined';

  const svc = new PoImportsService(ctx);

  if (mode === 'separate') {
    // One import per file, extracted independently. A file that isn't a
    // readable PO is skipped and reported — it must not sink the whole batch.
    const imports: Array<{
      id: string;
      fileName: string;
      duplicateOf: string | null;
      lowConfidenceLines: number;
    }> = [];
    const failed: Array<{ fileName: string; message: string }> = [];
    for (const file of files) {
      try {
        const r = await svc.createFromScan({ files: [file], vendorId, warehouseId });
        imports.push({
          id: r.id,
          fileName: file.fileName,
          duplicateOf: r.duplicateOf,
          lowConfidenceLines: r.lowConfidenceLines,
        });
      } catch (e) {
        const message =
          e instanceof ServiceError
            ? e.message
            : 'Could not read this file as a purchase order.';
        if (!(e instanceof ServiceError)) {
          void reportError(e, {
            tag: 'po-imports.scan.separate',
            organizationId: ctx.organizationId,
            userIdHash: ctx.userId,
          });
        }
        failed.push({ fileName: file.fileName, message });
      }
    }
    if (imports.length === 0) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message:
            failed[0]?.message ??
            'None of the files could be read as a purchase order.',
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, mode: 'separate', imports, failed });
  }

  try {
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
