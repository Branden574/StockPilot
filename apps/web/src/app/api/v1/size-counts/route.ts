import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { SizeCountsService } from '@/server/services/size-counts';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  mode: z.enum(['rapid_pass', 'box_overview']).optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  // styleKey is the pre-0302 display-only key, kept for orgs with no sports
  // module. productGroupId is the durable identity that replaces it — a rename
  // cannot detach the count from the product it counted.
  styleKey: z.string().max(200).nullable().optional(),
  productGroupId: z.string().uuid().nullable().optional(),
  boxId: z.string().max(200).nullable().optional(),
  expectedQuantity: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  deviceId: z.string().max(200).nullable().optional(),
  modelVersion: z.string().max(100).nullable().optional(),
  createdOffline: z.boolean().optional(),
});

/** Start an Instant Size Count session (mobile). */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`size-count-create:${ctx.userId}`, 60, 60_000);
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
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'validation_error' },
      { status: 400 },
    );
  }

  try {
    const svc = new SizeCountsService(ctx);
    const session = await svc.createSession(parsed.data);
    return NextResponse.json({ ok: true, session });
  } catch (e) {
    return sizeCountError(e);
  }
}

export function sizeCountError(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    const status =
      e.code === 'forbidden'
        ? 403
        : e.code === 'not_found'
          ? 404
          : e.code === 'conflict'
            ? 409
            : e.code === 'validation_error'
              ? 400
              : e.code === 'module_disabled'
                ? 403
                : 500;
    return NextResponse.json({ error: e.code, message: e.message }, { status });
  }
  return NextResponse.json(
    { error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' },
    { status: 500 },
  );
}
