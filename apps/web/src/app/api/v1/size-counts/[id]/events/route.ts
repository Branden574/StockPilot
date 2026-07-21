import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { SizeCountsService } from '@/server/services/size-counts';
import { sizeCountError } from '../../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const eventSchema = z.object({
  idempotencyKey: z.string().uuid(),
  size: z.string().min(1).max(16),
  quantityDelta: z.coerce.number().int().min(-1000).max(1000).optional(),
  confidence: z.coerce.number().min(0).max(1).nullable().optional(),
  recognitionMethod: z
    .enum(['rapid_pass_gate', 'box_overview', 'manual', 'ai_review', 'barcode'])
    .optional(),
  ephemeralTrackId: z.string().max(120).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  modelVersion: z.string().max(100).nullable().optional(),
  countedAt: z.string().datetime().nullable().optional(),
});

// The mobile outbox drains batches; cap the batch so one request stays bounded.
const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(500),
});

/** Idempotently append a batch of size-count events from the mobile outbox. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // Continuous counting replays batches; 240/min covers a brisk gate cadence
  // and hard-caps a runaway client.
  const rl = await checkRateLimit(`size-count-events:${ctx.userId}`, 240, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
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
    const svc = new SizeCountsService(ctx);
    const result = await svc.appendEvents(id, parsed.data.events);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return sizeCountError(e);
  }
}
