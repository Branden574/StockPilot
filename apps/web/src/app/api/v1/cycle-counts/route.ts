import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile create-count endpoint. The mobile app has no server actions, so
 * starting a cycle count (whole-warehouse or hand-picked selection) goes
 * through here with the standard Bearer-token auth. Mirrors
 * startCycleCountAction on the web.
 */
const bodySchema = z
  .object({
    scope: z.enum(['warehouse', 'selection']).default('selection'),
    warehouseId: z.string().uuid().nullable().optional(),
    itemIds: z.array(z.string().uuid()).max(1000).optional(),
    notes: z.string().max(2000).optional().nullable(),
    assignedTo: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.scope !== 'selection' || (v.itemIds?.length ?? 0) > 0, {
    message: 'Pick at least one item to count.',
    path: ['itemIds'],
  });

export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }

    const svc = new CycleCountsService(ctx);
    const result = await svc.start({
      scope: parsed.data.scope,
      warehouseId: parsed.data.warehouseId ?? null,
      itemIds: parsed.data.itemIds,
      notes: parsed.data.notes ?? null,
      assignedTo: parsed.data.assignedTo ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'not_found'
          ? 404
          : e.code === 'validation_error'
            ? 400
            : e.code === 'forbidden' || e.code === 'module_disabled'
              ? 403
              : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.cycle_counts.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
