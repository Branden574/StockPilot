import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { getPublicDriverLocation } from '@/server/services/delivery-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Live driver location for a public tracker. Verified by the SAME token+id+email
// triad as the status read; any miss returns { available:false } (never leaks).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const token = (url.searchParams.get('token') ?? '').trim();
  if (!UUID_RE.test(id) || !email || !token) {
    return NextResponse.json({ available: false });
  }

  const admin = createAdminClient();
  const { data: org } = await admin
    .from('organizations')
    .select('id')
    .eq('public_request_token', token)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ available: false });
  }
  const orgId = (org as { id: string }).id;

  const { data: header } = await admin
    .from('order_requests')
    .select('id, requester_email')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  const h = header as { requester_email: string | null } | null;
  if (!h || (h.requester_email ?? '').trim().toLowerCase() !== email) {
    return NextResponse.json({ available: false });
  }

  const result = await getPublicDriverLocation({ orgId, orderId: id });
  return NextResponse.json(result);
}
