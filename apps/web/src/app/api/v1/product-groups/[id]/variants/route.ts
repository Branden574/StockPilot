import { NextResponse, type NextRequest } from 'next/server';

import { variantLabel } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { ProductGroupsService } from '@/server/services/product-groups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The VARIANTS under one product group — the item rows a count is actually
 * made of.
 *
 * This is what "count by group" expands to. A group is identity and owns no
 * quantity, so there is nothing to count at group level: the pickers pull this
 * list and count each variant. Every row carries its own item id, because the
 * item id is what a `cycle_count_lines` row FKs.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user rate limit — mirrors GET /api/v1/bundles and the sibling group
  // list above: this is the size-count / cycle-count picker's variant fetch,
  // hit once per group tap while the caller debounces. 120/min covers
  // normal-paced use + burst, hard-limits a runaway client.
  const rl = await checkRateLimit(`v1-product-groups-variants:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    const svc = new ProductGroupsService(ctx);
    // get() first so a group in another org is a clean 404 rather than an
    // empty variant list that reads like "this group has nothing in it".
    const group = await svc.get(id);
    const variants = await svc.variants(id);
    return NextResponse.json({
      ok: true,
      group: {
        id: group.id,
        name: group.name,
        countingUnit: group.default_counting_unit,
      },
      variants: variants
        .filter((v) => v.status === 'active')
        .map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          quantityOnHand: v.quantity_on_hand,
          variantSize: v.variant_size,
          jerseyNumber: v.jersey_number,
          unitOfMeasure: v.unit_of_measure,
          // One shared label builder, so the phone, the web picker and the
          // printed count sheet all call the same variant the same thing.
          label: variantLabel({
            jerseyNumber: v.jersey_number,
            size: v.variant_size,
            width: v.variant_width,
            color: v.variant_color,
          }),
        })),
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
