import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { PoImportsService } from '@/server/services/po-imports';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

import { optionalPoImportDisplayNameSchema } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vision extraction can take 6-10s on a large multi-page PO. Tell
// Vercel to allow up to 60s before terminating.
export const maxDuration = 60;

// Kept in lockstep with PO_IMPORT_SCAN_MIME_TYPES (lib/po-imports/mime.ts,
// which explains why heic and heif always travel as a pair) and with the
// po-imports bucket pin (migrations 0325 + 0332).
const ACCEPT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
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
 * Hard ceiling on the raw `displayNames` field before it is even parsed.
 * MAX_FILES names of 160 characters plus JSON punctuation is well under 1 KB;
 * 4 KB leaves room for escaping without letting an unbounded text part into
 * JSON.parse.
 */
const MAX_DISPLAY_NAMES_BYTES = 4096;

/**
 * Parses the `displayNames` JSON array — see this module's POST header for the
 * contract. Returns one entry per import (nulls for unnamed), or a message.
 *
 * `expected` is the number of imports this request will create, NOT the number
 * of files: combined mode merges N files into one import and therefore takes
 * exactly one name.
 */
function parseDisplayNames(
  raw: FormDataEntryValue | null,
  expected: number,
): { names: Array<string | null> } | { error: string } {
  // Omitted → every import unnamed. This is the old-client path and must stay
  // a success, never a validation error.
  if (raw == null) return { names: Array.from({ length: expected }, () => null) };
  if (typeof raw !== 'string') {
    return { error: 'displayNames must be a JSON array of names.' };
  }
  if (raw.length > MAX_DISPLAY_NAMES_BYTES) {
    return { error: 'displayNames is too large.' };
  }
  // An empty string is treated as "omitted" — some form serializers send a
  // present-but-blank field, and refusing that would break naming for no gain.
  if (raw.trim() === '') return { names: Array.from({ length: expected }, () => null) };

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { error: 'displayNames must be a JSON array of names.' };
  }
  if (!Array.isArray(decoded)) {
    return { error: 'displayNames must be a JSON array of names.' };
  }
  // LOUD, not lenient: padding or truncating here is exactly how name N ends up
  // on file N-1, permanently and invisibly.
  if (decoded.length !== expected) {
    return {
      error: `displayNames must have exactly ${expected} entr${expected === 1 ? 'y' : 'ies'} — one per import — but got ${decoded.length}.`,
    };
  }

  const names: Array<string | null> = [];
  for (const entry of decoded) {
    if (entry !== null && typeof entry !== 'string') {
      return { error: 'Each displayNames entry must be a string or null.' };
    }
    const parsed = optionalPoImportDisplayNameSchema.safeParse(entry);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'That import name is not valid.' };
    }
    names.push(parsed.data);
  }
  return { names };
}

/**
 * Phone-scanned PO endpoint.
 *
 * Accepts multipart/form-data with one or more `file` fields (multi-frame
 * captures or multi-page scans). Optional `vendorId` and `warehouseId`
 * fields hint the vendor mapping lookup.
 *
 * NAMING (mig 0332) — the wire contract, ONE shape only:
 *
 *   `displayNames` — a single field holding a JSON ARRAY of (string | null),
 *   index-aligned with the imports this request will create:
 *
 *     • SEPARATE mode — one import per file, so the array has exactly ONE
 *       ENTRY PER FILE and entry[i] names file[i].
 *     • COMBINED mode — the files are pages of ONE purchase order, so the
 *       array has exactly ONE entry, which names that single import.
 *     • Omitted entirely — every import is created unnamed, exactly as before
 *       this field existed. That is what an older mobile build sends, and it
 *       must keep working; nothing here is required.
 *
 *   A length that does not match the import count is a 400, never a guess. The
 *   silent alternative (pad, truncate, or slide) mis-associates names across
 *   files, which is permanent and looks exactly like a user's own typo.
 *
 *   WHY JSON AND NOT A REPEATED `displayName` FIELD: repeated multipart parts
 *   look like the natural fit, but "file 2 has no name" has to travel as an
 *   EMPTY part — and an empty-valued part is not reliably preserved across
 *   multipart implementations (happy-dom's parser, which this route's tests run
 *   under, drops them outright). One dropped empty shifts every later name onto
 *   the wrong file. A JSON array carries `null` as a real value, so the
 *   alignment cannot be lost in transport, and a truncated array is caught by
 *   the length check instead of being silently obeyed.
 *
 * Names are validated SERVER-SIDE against the shared schema — the browser's
 * input `maxLength` is a courtesy, not a control.
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

  // Names, parsed AFTER the mode is settled because the required array length
  // is "one per IMPORT" — see the contract in this route's header. Validated
  // here (400 with the real message) rather than left to the service, so a bad
  // name in a 5-file batch is refused BEFORE any vision call is paid for; the
  // service still re-validates every one of them.
  const expectedNames = mode === 'separate' ? files.length : 1;
  const namesResult = parseDisplayNames(form.get('displayNames'), expectedNames);
  if ('error' in namesResult) {
    return NextResponse.json(
      { error: 'validation_error', message: namesResult.error },
      { status: 400 },
    );
  }
  const displayNames = namesResult.names;

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
    for (const [index, file] of files.entries()) {
      try {
        // file[i] gets name[i]. The array is already length-checked against
        // files.length above, so this index cannot silently miss.
        const r = await svc.createFromScan({
          files: [file],
          vendorId,
          warehouseId,
          displayName: displayNames[index] ?? null,
        });
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
    // ONE import, therefore exactly ONE name (the length check above already
    // refused anything else).
    const result = await svc.createFromScan({
      files,
      vendorId,
      warehouseId,
      displayName: displayNames[0] ?? null,
    });
    return NextResponse.json({
      ok: true,
      id: result.id,
      duplicateOf: result.duplicateOf,
      lowConfidenceLines: result.lowConfidenceLines,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      // Use the shared mapper rather than a hand-rolled ladder: the local one
      // had no 'conflict' case, so a legitimate 409 (concurrent re-import of
      // the same file) reached the browser as a 500 with a red console error,
      // making an ordinary "someone beat you to it" look like a crash.
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
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
