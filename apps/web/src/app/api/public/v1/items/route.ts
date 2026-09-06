import { NextResponse } from 'next/server';

import { authorizePublicApi, parsePageParams } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public API — list inventory items. Auth: `Authorization: Bearer sk_live_…`
 * with the `inventory:read` scope. Org-scoped (the key resolves to one org).
 *
 * GET /api/public/v1/items?limit=&offset=&search=
 *
 * Pagination caveat: the `(updated_at desc, id asc)` sort below is a TOTAL
 * order, so a consumer paging a quiet dataset now sees every row exactly once.
 * It is still OFFSET pagination over a MUTABLE sort key — a row updated
 * mid-sync jumps to the front and shifts everything after it, so a consumer
 * paging while writes land can still miss a row. The durable fix is a keyset
 * cursor (`where (updated_at, id) < (:last_updated_at, :last_id)`); build that
 * endpoint if an integration ever reports drift on a live org.
 */
export async function GET(req: Request) {
  const auth = await authorizePublicApi(req, 'inventory:read');
  if ('res' in auth) return auth.res;
  const { ctx } = auth;

  const url = new URL(req.url);
  const { limit, offset } = parsePageParams(url);
  const search = (url.searchParams.get('search') ?? '').trim();

  const admin = createAdminClient();
  let query = admin
    .from('inventory_items')
    .select(
      'id, sku, name, barcode, model_number, status, item_type, quantity_on_hand, reorder_point, unit_cost, retail_price, created_at, updated_at',
    )
    // Tenant isolation — no RLS on the service-role client, so the org filter is
    // the boundary. Never remove this.
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    // SP-131 tiebreak. `updated_at` alone is NOT a total order: adjust_stock
    // stamps `updated_at = now()`, and now() is the TRANSACTION timestamp, so
    // every line of one PO receipt (or bulk import) shares an identical value.
    // There is no index on inventory_items(updated_at), so the plan is a
    // bounded top-N heapsort whose tie order is not preserved across different
    // LIMIT+OFFSET bounds — page 2 and page 3 could slice the same
    // equal-timestamp group differently with zero writes in between, so a
    // consumer's mirror silently lost rows and duplicated others behind a 200.
    // `id` makes the sort deterministic. Same rule as
    // server/services/lib/paginate.ts ("the stable .order('id') is REQUIRED").
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  // Strip LIKE/PostgREST metacharacters (%, _, \, comma, parens, star) so the
  // search can only narrow, never widen, the result set.
  if (search) query = query.ilike('name', `%${search.replace(/[%,_\\()*]/g, '')}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  return NextResponse.json({ data: data ?? [], limit, offset });
}
