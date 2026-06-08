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
    .range(offset, offset + limit - 1);
  // Strip LIKE/PostgREST metacharacters (%, _, \, comma, parens, star) so the
  // search can only narrow, never widen, the result set.
  if (search) query = query.ilike('name', `%${search.replace(/[%,_\\()*]/g, '')}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  return NextResponse.json({ data: data ?? [], limit, offset });
}
