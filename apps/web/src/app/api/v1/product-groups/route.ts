import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { ProductGroupsService } from '@/server/services/product-groups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Product groups for the MOBILE pickers — starting a size count against a real
 * group, and scoping a cycle count to one.
 *
 * The phone had no way to name a group at all, which is why
 * `size_count_sessions.style_key` was never populated: mobile posted
 * `{ mode, boxId }` and nothing else. Web reaches groups through server
 * components, so this Bearer seam is the parity fix.
 *
 * Each row carries its DERIVED roll-up (variant count + total). Derived, at
 * read time, from `product_group_rollups` — a group owns no quantity and this
 * endpoint must never look like it does.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const search = url.searchParams.get('q')?.trim() ?? '';
  const rawLimit = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;

  try {
    const svc = new ProductGroupsService(ctx);
    const groups = await svc.list({ search: search || undefined, limit });
    const rollups = await svc.rollups(groups.map((g) => g.id));
    return NextResponse.json({
      ok: true,
      groups: groups.map((g) => {
        const roll = rollups.get(g.id);
        return {
          id: g.id,
          name: g.name,
          brand: g.brand,
          model: g.model,
          styleNumber: g.style_number,
          team: g.team,
          countingUnit: g.default_counting_unit,
          variantCount: roll?.variantCount ?? 0,
          totalQuantity: roll?.totalQuantity ?? 0,
        };
      }),
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
