import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
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
 *
 * ACTIVE GROUPS ONLY. This is a PICKER's source — the phone is choosing a group
 * to count against — so it takes `ProductGroupsService.list()`'s default status
 * and deliberately does not expose a `status` parameter: an archived group is
 * not something to start a count on, and archived groups are read back only from
 * the web page that restores them.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user rate limit — mirrors GET /api/v1/bundles: this list is the
  // mobile picker's typeahead source, hit on every keystroke while debounced.
  // 120/min covers normal-paced typing + burst, hard-limits a runaway client.
  const rl = await checkRateLimit(`v1-product-groups-list:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAt: rl.resetAt },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
      },
    );
  }

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
