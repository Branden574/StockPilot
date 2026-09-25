import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { resolveCapturedAt } from '@/lib/cycle-counts/capture-time';
import { checkRateLimit } from '@/lib/rate-limit';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  countedQuantity: z.coerce.number().min(0).max(1_000_000_000),
  reason: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // AI Shelf Scan v1 — when the count came from an AI proposal that
  // the user confirmed on the review screen, this points at the
  // cycle_count_ai_scans row. NULL/omitted for manual + barcode
  // entries (unchanged existing behavior).
  aiScanId: z.string().uuid().nullable().optional(),
  // Offline capture time (0369). Read LENIENTLY by resolveCapturedAt: a value
  // that cannot be read is dropped (the record is then an online record, as
  // today), never refused. The phone's drain treats a 400 as final and would
  // discard the operator's count over a bad timestamp. Old bundles send
  // neither key.
  capturedAt: z.unknown().optional(),
  clientSentAt: z.unknown().optional(),
});

/**
 * Mobile scan-to-count: record (or overwrite) a line's counted qty.
 * Single-line endpoint; the mobile client batches its own scans
 * locally and replays them through here as it reconnects.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  // The server clock at ARRIVAL, read before anything else (0369). An offline
  // capture is placed at arrivedAt - (clientSentAt - capturedAt), so every
  // millisecond spent before this read (auth, the rate limit, the body) would
  // land the capture that much later than the real count, where a pick of the
  // item reads as before the count.
  const arrivedAt = Date.now();
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id, lineId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(lineId)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // Per-user rate limit. The mobile client batches scans locally and
  // replays them when it reconnects — a burst of 200 lines from a
  // single bag-loose-trigger scanner is realistic, but 30/sec sustained
  // is not. 120/min covers normal-paced shelf walking (~2/sec) and
  // hard-limits a malicious or buggy client.
  const rl = await checkRateLimit(`cycle-count-record:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'validation_error' },
      { status: 400 },
    );
  }

  // The device's two clock readings, skew-corrected onto the server clock
  // (only the elapsed time between them is trusted), against the clock at
  // arrival. The database clamps the result to [count started, now].
  const capturedAt = resolveCapturedAt({
    capturedAt: parsed.data.capturedAt,
    clientSentAt: parsed.data.clientSentAt,
    serverNow: arrivedAt,
  });

  try {
    const svc = new CycleCountsService(ctx);
    await svc.recordCount({
      cycleCountId: id,
      lineId,
      countedQuantity: parsed.data.countedQuantity,
      reason: parsed.data.reason ?? null,
      notes: parsed.data.notes ?? null,
      // Passed through UNCHANGED: omitted stays undefined, so a manual or
      // offline recount keeps the line's AI-scan link (recordCount writes
      // ai_scan_id only when it is given). `?? null` used to wipe it.
      aiScanId: parsed.data.aiScanId,
      ...(capturedAt ? { capturedAt } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      // A record that waited too long behind an in-flight post of the same
      // item (0369 FOR SHARE, lock_timeout 8 s) is RETRYABLE: 503, never a
      // 4xx, which the phone's drain would treat as a final refusal.
      if (e.code === 'internal_error' && e.details?.retryable === true) {
        return NextResponse.json(
          { error: e.code, message: e.message },
          { status: 503, headers: { 'Retry-After': '5' } },
        );
      }
      const status =
        e.code === 'forbidden'
          ? 403
          : e.code === 'not_found'
            ? 404
            : e.code === 'conflict' || e.code === 'validation_error'
              ? 409
              : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
