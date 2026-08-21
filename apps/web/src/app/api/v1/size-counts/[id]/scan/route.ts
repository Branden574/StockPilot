import { GoogleGenerativeAI, type ResponseSchema } from '@google/generative-ai';
import { NextResponse, type NextRequest } from 'next/server';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
import {
  parseSizeScanResponse,
  SIZE_SCAN_PROMPT,
  SIZE_SCAN_RESPONSE_SCHEMA,
} from '@/lib/ai/size-scan';
import { withApiContext } from '@/lib/auth/api-context';
import { scanDocumentBytes, THREAT_MESSAGES } from '@/lib/document-threat-scan';
import { env } from '@/lib/env';
import { isSniffedKindAllowedInBucket, MIME_FOR_KIND, sniffImage } from '@/lib/image-signature';
import { checkRateLimit } from '@/lib/rate-limit';
import { SizeCountsService } from '@/server/services/size-counts';

import { sizeCountError } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A vision round-trip on a 1600px photo runs a few seconds; the default 15s
 *  cap would turn an ordinary slow response into a 504 mid-count. */
export const maxDuration = 60;

/**
 * AI SIZE-STICKER SCAN — photograph a garment or a stack, get a proposed tally.
 *
 * ═══ THIS ROUTE WRITES NOTHING ═══
 *
 * It returns a PROPOSAL. Nothing reaches `size_count_events` until the operator
 * confirms it and the client posts it to the existing `/events` endpoint with
 * `recognitionMethod: 'box_overview'` and the per-reading confidence.
 *
 * That split is the whole safety model, and it is not incidental. The scanner
 * is measured at roughly 95% on the training corpus (see
 * `scripts/size-scan-eval/`), which is good enough to save a great deal of
 * tapping and NOT good enough to write a stock count unattended. One in twenty
 * readings being wrong is fine when a person is looking at the list and can
 * strike a row out; it is not fine when the list is the count. Keeping the
 * write on the existing reviewed path means the scan can only ever save work,
 * never silently create it.
 *
 * The whole known-limitations list lives in `lib/ai/size-scan.ts` — briefly:
 * XXXL is read as XXL about a quarter of the time, and XXXXL/XXXXXL have never
 * been evaluated at all because the corpus contains no examples of them.
 */

/** 6 MB, matching the vision cap on the other photo routes. The phone resizes
 *  to a 1600px long edge (~300 KB) before it ever gets here, so this only ever
 *  catches a client that did not. */
const SCAN_MAX_BYTES = 6 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // ═══ EVERY REFUSAL HAPPENS BEFORE ANY SPEND ═══
  //
  // Module, permission, session existence, open status and warehouse scope are
  // all settled inside getScanContext, ahead of the body read and the vision
  // call. A route that reads the photo first and checks afterwards has already
  // paid for the call and already handed a customer's photograph to an external
  // provider by the time it discovers the caller had no business here.
  const svc = new SizeCountsService(ctx);
  let scanContext: Awaited<ReturnType<SizeCountsService['getScanContext']>>;
  try {
    scanContext = await svc.getScanContext(id);
  } catch (e) {
    return sizeCountError(e);
  }

  // Per-user: a brisk scan cadence on a stack of boxes is one every few
  // seconds, so 20/min is generous while still capping a runaway client.
  const rl = await checkRateLimit(`size-count-scan:${ctx.userId}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }
  // Per-ORG, and the reason is money rather than abuse. The per-user limit
  // bounds a stuck client; it does nothing about twenty staff scanning all day
  // on a plan nobody costed. This is the only ceiling on what one org can spend
  // on vision here, and without it there is none.
  const orgRl = await checkRateLimit(`size-count-scan-org:${ctx.organizationId}`, 2000, 24 * 60 * 60 * 1000);
  if (!orgRl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited_org', retryAt: orgRl.resetAt },
      { status: 429 },
    );
  }

  if (!(req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 415 });
  }
  let photo: Blob;
  try {
    const form = await req.formData();
    const file = form.get('image');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'image field is required' }, { status: 400 });
    }
    photo = file;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid_body' },
      { status: 400 },
    );
  }
  if (photo.size > SCAN_MAX_BYTES) {
    return NextResponse.json(
      { error: `image too large (max ${SCAN_MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }

  // ═══ VERIFY THE BYTES BEFORE THE AI SEES THEM ═══
  //
  // This photo never lands in storage — it is read, classified and dropped — so
  // there is no object to protect. The check is here because the bytes go to an
  // EXTERNAL PROVIDER, which is the same reason the cycle-count scan sniffs
  // before its base64 hand-off. The declared Content-Type is the client's word
  // for it and decides nothing.
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const sniffed = sniffImage(bytes);
  if (!sniffed || !isSniffedKindAllowedInBucket(sniffed.kind, 'size-count-training')) {
    return NextResponse.json(
      {
        error: 'invalid_image',
        message: 'This file could not be read because it failed our security checks.',
      },
      { status: 422 },
    );
  }
  const threat = scanDocumentBytes(bytes, sniffed.kind);
  if (threat) {
    return NextResponse.json(
      { error: 'invalid_image', message: THREAT_MESSAGES[threat.code] },
      { status: 422 },
    );
  }

  // The provider is resolved per REQUEST, never at module scope: resolveAiProvider
  // reads env that a deploy can change, and a value captured at import time
  // survives in a warm instance long after the rollback switch was flipped.
  const useClaude = resolveAiProvider() === 'claude';
  if (useClaude ? !env.ANTHROPIC_API_KEY : !env.GEMINI_API_KEY) {
    return NextResponse.json({ error: 'feature_unavailable' }, { status: 503 });
  }
  // The ESCALATED model, not the global one — this route's accuracy was
  // measured on it (see the note on ANTHROPIC_SIZE_SCAN_MODEL in lib/env.ts).
  // Recorded on every event it produces, so a later audit can tell which model
  // read a given count.
  const modelVersion = useClaude ? env.ANTHROPIC_SIZE_SCAN_MODEL : env.GEMINI_MODEL;
  // The SNIFFED mime, never the declared one — the same rule the upload paths
  // follow, for the same reason.
  const mediaType = MIME_FOR_KIND[sniffed.kind];
  const base64 = Buffer.from(bytes).toString('base64');

  let raw: string;
  try {
    if (useClaude) {
      raw = await claudeGenerateJsonString({
        prompt: SIZE_SCAN_PROMPT,
        schema: SIZE_SCAN_RESPONSE_SCHEMA,
        media: [{ data: base64, mediaType }],
        model: env.ANTHROPIC_SIZE_SCAN_MODEL,
        maxTokens: 2048,
        // NO `temperature`. sonnet-5+ rejects the parameter outright and 400s
        // the whole call — which would present as a scanner that never reads
        // anything. The forced tool plus the schema already constrain the
        // output, so there is nothing the parameter was buying here.
      });
    } else {
      const model = new GoogleGenerativeAI(env.GEMINI_API_KEY).getGenerativeModel({
        model: env.GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          // Cast: identical JSON to what Claude gets (SchemaType.OBJECT IS
          // "object"), but the SDK's ResponseSchema type does not model
          // `propertyOrdering` — the field this schema's accuracy depends on.
          responseSchema: SIZE_SCAN_RESPONSE_SCHEMA as unknown as ResponseSchema,
          temperature: 0,  // Gemini still takes it, and determinism is wanted.
        },
      });
      const result = await model.generateContent([
        { text: SIZE_SCAN_PROMPT },
        { inlineData: { data: base64, mimeType: mediaType } },
      ]);
      raw = result.response.text();
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'vision_failed', message: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }

  const result = parseSizeScanResponse(raw);

  // Sizes outside the counted group's own scale are reported separately rather
  // than dropped. A sports group counted in a five-size scale can still have a
  // stray XXXL dot in the box, and the operator is the one who should decide
  // what that means — silently discarding it would present a short count as a
  // complete one.
  const allowed = new Set(scanContext.allowedSizes);
  const counts = result.counts.filter((c) => allowed.has(c.size));
  const outsideGroupScale = result.counts.filter((c) => !allowed.has(c.size));

  return NextResponse.json({
    counts,
    outsideGroupScale,
    // Every reading, including the ones that were dropped and why. The operator
    // reviewing a tally needs to be able to tell "there was no sticker" from
    // "there was one and we would not read it" — a bare count cannot say which.
    stickers: result.stickers,
    discarded: result.discarded,
    modelVersion,
    groupName: scanContext.groupName,
  });
}
