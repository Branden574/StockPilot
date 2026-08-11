import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';
import { getPublicDriverLocation } from '@/server/services/delivery-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_HOUR_MS = 60 * 60 * 1000;
// The customer tracker polls this every 12s (~300/hr per open tab). Cap per-IP
// well above that (~6 concurrent trackers behind one NAT) so legitimate polling
// never trips, while a scripted hammer (no 12s wait) still hits the wall fast.
const LOCATION_POLL_PER_IP_PER_HOUR = 1800;

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

  // Throttle per IP (closed mode — unauthenticated). On a limiter outage we
  // deny; the tracker treats a non-200 as "keep last position, retry next
  // poll", so a brief blip degrades gracefully rather than leaking budget.
  const ip = clientIpFromRequest(req);
  const limit = await checkRateLimit(
    `public-order-location:ip:${ip}`,
    LOCATION_POLL_PER_IP_PER_HOUR,
    ONE_HOUR_MS,
    'closed',
  );
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { available: false, error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const admin = createAdminClient();
  const { data: header } = await admin
    .from('order_requests')
    .select('id, organization_id, requester_email, public_track_token')
    .eq('id', id)
    .maybeSingle();
  const h = header as {
    organization_id: string;
    requester_email: string | null;
    public_track_token: string | null;
  } | null;
  if (!h || (h.requester_email ?? '').trim().toLowerCase() !== email) {
    return NextResponse.json({ available: false });
  }
  const orgId = h.organization_id;

  // Same three accepted credentials as the status read (mig 0330): the
  // request's own track token, or a live org/link catalog token compared
  // as sha256(token) against the hashed at-rest columns.
  const tokenHash = sha256Hex(token);
  let authorized = h.public_track_token !== null && token === h.public_track_token;
  if (!authorized) {
    const { data: orgMatch } = await admin
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .eq('public_request_token_hash', tokenHash)
      .maybeSingle();
    authorized = orgMatch != null;
  }
  if (!authorized) {
    const { data: linkMatch } = await admin
      .from('public_request_links')
      .select('id')
      .eq('organization_id', orgId)
      .eq('token_hash', tokenHash)
      .maybeSingle();
    authorized = linkMatch != null;
  }
  if (!authorized) {
    return NextResponse.json({ available: false });
  }

  const result = await getPublicDriverLocation({ orgId, orderId: id });
  return NextResponse.json(result);
}
