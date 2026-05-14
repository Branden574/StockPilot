import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  countedQuantity: z.coerce.number().min(0).max(1_000_000_000),
  reason: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
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

  try {
    const svc = new CycleCountsService(ctx);
    await svc.recordCount({
      cycleCountId: id,
      lineId,
      countedQuantity: parsed.data.countedQuantity,
      reason: parsed.data.reason ?? null,
      notes: parsed.data.notes ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
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
