import { NextResponse, type NextRequest } from 'next/server';

import { TRAINING_NEGATIVE_LABEL, trainingSizeLabelSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { SizeCountsService } from '@/server/services/size-counts';
import { sizeCountError } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Persistent per-size training-sample counts for the capture screen's
 *  progress (survives leaving + returning to the screen). */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const svc = new SizeCountsService(ctx);
    const stats = await svc.getTrainingStats();
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return sizeCountError(e);
  }
}

const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload one opt-in labeled training sample for the Instant Size Count
 * detector (multipart: image + sizeLabel + optional metadata). Step 1 of the
 * on-device-model track.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`size-count-training:${ctx.userId}`, 300, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 415 });
  }

  let imageBytes: ArrayBuffer;
  let mimeType: string;
  let sizeLabel: string;
  let isNegative = false;
  let metadata: Record<string, unknown> = {};
  let deviceId: string | null = null;
  try {
    const form = await req.formData();
    const file = form.get('image');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'image field is required' }, { status: 400 });
    }
    if (file.size > PHOTO_MAX_BYTES) {
      return NextResponse.json({ error: 'image too large' }, { status: 413 });
    }
    // The SHARED contract (packages/core), so the Expo capture screen, this
    // route and migration 0305's CHECK cannot drift. It canonicalises as well
    // as validates — '9.0' and ' xl ' land as '9' and 'XL' — so one physical
    // size never becomes two buckets in the training-stats counts map.
    const parsedLabel = trainingSizeLabelSchema.safeParse(form.get('sizeLabel') ?? '');
    if (!parsedLabel.success) {
      return NextResponse.json({ error: 'invalid sizeLabel' }, { status: 400 });
    }
    sizeLabel = parsedLabel.data;
    isNegative = sizeLabel === TRAINING_NEGATIVE_LABEL || form.get('isNegative') === 'true';
    deviceId = form.get('deviceId') ? String(form.get('deviceId')) : null;
    const rawMeta = form.get('metadata');
    if (rawMeta) {
      try {
        const parsed = JSON.parse(String(rawMeta));
        if (parsed && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
      } catch {
        // ignore bad metadata — the label + image are what matter
      }
    }
    mimeType = file.type.startsWith('image/') ? file.type : 'image/jpeg';
    imageBytes = await file.arrayBuffer();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid_body' },
      { status: 400 },
    );
  }

  try {
    const svc = new SizeCountsService(ctx);
    const result = await svc.recordTrainingSample({
      imageBytes,
      mimeType,
      sizeLabel,
      isNegative,
      metadata,
      deviceId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return sizeCountError(e);
  }
}
