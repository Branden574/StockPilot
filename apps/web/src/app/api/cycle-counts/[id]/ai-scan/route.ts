import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { env } from '@/lib/env';
import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
import {
  buildShelfScanPrompt,
  parseShelfScanResponse,
  SHELF_SCAN_RESPONSE_SCHEMA,
  type ShelfScanLineInput,
} from '@/lib/ai/shelf-scan';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI Shelf Scan v1 — POST endpoint.
 *
 * Flow:
 *   1. Auth + rate-limit gate.
 *   2. Validate cycle count belongs to caller's org and is in_progress
 *      (assertSessionAccess inside CycleCountsService throws otherwise).
 *   3. Load the books-only line set via getLineSetForAiScan.
 *   4. Read the multipart photo body (already compressed client-side
 *      to WebP master from `compressImageVariants` in apps/mobile).
 *   5. Upload the photo to the `cycle-count-scans` bucket — service
 *      role since the request was already authorized above.
 *   6. Call Gemini 2.0 Flash with the structured-output schema.
 *   7. Parse + filter the response (drops hallucinated SKUs).
 *   8. Persist a `cycle_count_ai_scans` row with the raw response.
 *   9. Return { scanId, photoSignedUrl, results } for the mobile
 *      review screen to render.
 */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_TTL_SEC = 60 * 60; // photo URL only needs to live during the review session

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: cycleCountId } = await params;

  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  if (!env.GEMINI_API_KEY) {
    return NextResponse.json({ error: 'feature_unavailable' }, { status: 503 });
  }

  // 10 scans/min/user. Each scan involves multipart upload + Gemini
  // round-trip, so this is meaningfully tighter than the
  // identify-from-photo cap (30/min) — the realistic mobile capture
  // cadence on a shelf is one every ~5-10 seconds anyway.
  const rl = await checkRateLimit(`ai-shelf-scan:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      { status: 429 },
    );
  }

  // Read multipart body. Only image/webp + image/jpeg accepted — the
  // mobile compress pipeline outputs WebP; the JPEG fallback covers
  // older devices where the canvas encode failed and the raw camera
  // file got uploaded.
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    return NextResponse.json(
      { error: 'expected multipart/form-data' },
      { status: 415 },
    );
  }
  let photoBlob: Blob;
  try {
    const form = await req.formData();
    const file = form.get('image');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'image field is required' }, { status: 400 });
    }
    photoBlob = file;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid_body' },
      { status: 400 },
    );
  }
  if (photoBlob.size > PHOTO_MAX_BYTES) {
    return NextResponse.json(
      { error: `image too large (max ${PHOTO_MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }
  const mimeType = photoBlob.type.startsWith('image/') ? photoBlob.type : 'image/jpeg';

  // Load the line set BEFORE uploading the photo + calling the vision model —
  // getLineSetForAiScan now runs the FULL pre-flight gate (module +
  // stock:adjust permission + warehouse scope + assignee lock + in_progress
  // status), so an unauthorized / non-assignee / closed-count request fails
  // fast without wasting a paid vision call or a storage write.
  const svc = new CycleCountsService(ctx);
  let lineSet: ShelfScanLineInput[];
  try {
    lineSet = await svc.getLineSetForAiScan(cycleCountId);
  } catch (e) {
    return serviceErrorToResponse(e);
  }
  if (lineSet.length === 0) {
    return NextResponse.json(
      { error: 'no_books', message: 'This cycle count has no book lines to scan.' },
      { status: 422 },
    );
  }

  // Upload the photo to the cycle-count-scans bucket. Service role
  // because the photo path is org-scoped + the request was already
  // authorized via withApiContext. Path:
  //   {organization_id}/{cycle_count_id}/{uuid}.webp
  const admin = createAdminClient();
  const photoExt =
    mimeType === 'image/webp' ? 'webp' : mimeType === 'image/png' ? 'png' : 'jpg';
  const photoStoragePath = `${ctx.organizationId}/${cycleCountId}/${crypto.randomUUID()}.${photoExt}`;
  const photoBytes = await photoBlob.arrayBuffer();
  const { error: uploadErr } = await admin.storage
    .from('cycle-count-scans')
    .upload(photoStoragePath, photoBytes, {
      contentType: mimeType,
      upsert: false,
    });
  if (uploadErr) {
    return NextResponse.json(
      { error: 'storage_failed', message: uploadErr.message },
      { status: 502 },
    );
  }

  // Mint a signed URL the mobile client can use to render the photo
  // on the review screen. 1 hour TTL — review session is short and
  // the URL doesn't need to outlive it.
  const { data: signed, error: signErr } = await admin.storage
    .from('cycle-count-scans')
    .createSignedUrl(photoStoragePath, SIGNED_URL_TTL_SEC);
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: 'storage_failed', message: signErr?.message ?? 'sign_failed' },
      { status: 502 },
    );
  }

  // Call the vision model. Structured-output schema enforces the response
  // shape; parseShelfScanResponse defensively filters anything that
  // sneaks past (hallucinated SKU, out-of-range confidence, etc).
  const base64 = Buffer.from(photoBytes).toString('base64');
  const prompt = buildShelfScanPrompt(lineSet);
  const useClaude = resolveAiProvider() === 'claude';
  const modelVersion = useClaude ? env.ANTHROPIC_MODEL : env.GEMINI_MODEL;

  let rawResponse: string;
  try {
    if (useClaude) {
      rawResponse = await claudeGenerateJsonString({
        prompt,
        media: [{ data: base64, mediaType: mimeType }],
        schema: SHELF_SCAN_RESPONSE_SCHEMA,
      });
    } else {
      const model = new GoogleGenerativeAI(env.GEMINI_API_KEY).getGenerativeModel({
        model: env.GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SHELF_SCAN_RESPONSE_SCHEMA,
        },
      });
      const result = await model.generateContent([
        { text: prompt },
        { inlineData: { data: base64, mimeType } },
      ]);
      rawResponse = result.response.text();
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'vision_failed', message: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }

  const results = parseShelfScanResponse(rawResponse, lineSet);

  // Persist the audit row regardless of whether the user later
  // confirms — abandoned scans are useful signal for tuning.
  let scanId: string;
  try {
    const inserted = await svc.insertAiScan({
      cycleCountId,
      photoStoragePath,
      geminiResponse: safeJsonParse(rawResponse),
      modelVersion,
    });
    scanId = inserted.id;
  } catch (e) {
    return serviceErrorToResponse(e);
  }

  return NextResponse.json({
    scanId,
    photoSignedUrl: signed.signedUrl,
    results,
  });
}

function serviceErrorToResponse(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    const status =
      e.code === 'not_found'
        ? 404
        : e.code === 'forbidden' || e.code === 'module_disabled'
          ? 403
          : e.code === 'validation_error'
            ? 400
            : 500;
    return NextResponse.json({ error: e.code, message: e.message }, { status });
  }
  return NextResponse.json(
    { error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' },
    { status: 500 },
  );
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}
