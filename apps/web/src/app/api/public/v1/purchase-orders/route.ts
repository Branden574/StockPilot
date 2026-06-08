import { NextResponse } from 'next/server';

import { authorizePublicApi, parsePageParams } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public API — list purchase orders. Auth: Bearer API key with
 * `purchase_orders:read`. Org-scoped. GET /api/public/v1/purchase-orders
 */
export async function GET(req: Request) {
  const auth = await authorizePublicApi(req, 'purchase_orders:read');
  if ('res' in auth) return auth.res;
  const { ctx } = auth;

  const url = new URL(req.url);
  const { limit, offset } = parsePageParams(url);
  const status = (url.searchParams.get('status') ?? '').trim();

  const admin = createAdminClient();
  let query = admin
    .from('purchase_orders')
    .select(
      'id, po_number, status, supplier_id, total, expected_at, ordered_at, received_at, created_at',
    )
    .eq('organization_id', ctx.organizationId) // tenant isolation — required
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  return NextResponse.json({ data: data ?? [], limit, offset });
}
