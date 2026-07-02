import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  quantity: z.coerce.number().positive().max(1_000_000),
  warehouseId: z.string().uuid(),
  scheduleEventId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  allowShortage: z.boolean().optional(),
});

/**
 * Mobile bundle distribute. Same flow as the web modal, exposed for the
 * mobile distribute screen. Requires bundles:distribute (staff+).
 *
 * Mobile is expected to:
 *   1. Hit BundlesService.preview() (via this endpoint shape too?
 *      actually preview is read-only — caller can compute it locally
 *      against the cached components, OR call /api/v1/bundles/[id]/preview
 *      if we add that. For now, distribute fails gracefully on shortage
 *      unless allowShortage=true was sent based on the user's confirm.)
 *   2. Call this with allowShortage matching what the user confirmed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
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
    const svc = new BundlesService(ctx);
    const out = await svc.distribute(id, {
      quantity: parsed.data.quantity,
      warehouseId: parsed.data.warehouseId,
      scheduleEventId: parsed.data.scheduleEventId ?? null,
      notes: parsed.data.notes ?? null,
      allowShortage: parsed.data.allowShortage ?? false,
    });
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'validation_error'
          ? 400
          : e.code === 'forbidden'
            ? 403
            : e.code === 'not_found'
              ? 404
              : e.code === 'conflict'
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
