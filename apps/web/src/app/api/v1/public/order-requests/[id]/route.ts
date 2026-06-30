import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Public order-request status read.
 *
 * Three independent checks must all pass before we return a payload:
 *   1. The request id exists.
 *   2. The org's `public_request_token` matches the `?token=` query.
 *   3. The stored `requester_email` matches `?email=` (case-insensitive).
 *
 * Any failure returns a single generic 404 — we never leak which check
 * failed, because that would let an attacker enumerate valid IDs.
 *
 * The shape is deliberately redacted: no internal_notes, no unit costs,
 * no requester_user_id. Only what a requester needs to track progress.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const url = new URL(req.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const token = (url.searchParams.get('token') ?? '').trim();
  if (!email || !token) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Rate-limit BEFORE the DB lookups so a brute-forcer guessing the
  // token+id+email triad can't hammer this for free. Closed mode (deny on a
  // limiter outage) since this is unauthenticated. Limits are generous for real
  // humans — incl. a shared office/NAT IP — but a scripted loop trips fast.
  const ip = clientIpFromRequest(req);
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(`public-order-read:ip:${ip}`, 120, ONE_HOUR_MS, 'closed'),
    checkRateLimit(`public-order-read:token:${token}`, 600, ONE_HOUR_MS, 'closed'),
  ]);
  const denied = !ipLimit.allowed ? ipLimit : !tokenLimit.allowed ? tokenLimit : null;
  if (denied) {
    const retryAfter = Math.max(1, Math.ceil((denied.resetAt - Date.now()) / 1000));
    void reportError(new Error('public order-read rate limit hit'), {
      tag: 'public.order-read.rate-limited',
      level: 'warning',
      extra: {
        bucket: !ipLimit.allowed ? 'ip' : 'token',
        count: denied.count,
        tokenPrefix: token.slice(0, 8),
      },
    });
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const admin = createAdminClient();

  const { data: org } = await admin
    .from('organizations')
    .select('id')
    .eq('public_request_token', token)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const orgId = (org as { id: string }).id;

  const { data: header } = await admin
    .from('order_requests')
    .select(
      `id, status, requester_email, requester_name, notes, denied_reason,
       created_at, approved_at, packing_slip_generated_at, staged_at,
       in_transit_at, signed_at, completed_at, cancelled_at,
       organization_id, warehouse_id, fulfillment_type`,
    )
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!header) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const h = header as {
    id: string;
    status: string;
    requester_email: string | null;
    requester_name: string | null;
    notes: string | null;
    denied_reason: string | null;
    created_at: string;
    approved_at: string | null;
    packing_slip_generated_at: string | null;
    staged_at: string | null;
    in_transit_at: string | null;
    signed_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    organization_id: string;
    warehouse_id: string;
    fulfillment_type: 'pickup' | 'delivery';
  };
  if (!h.requester_email || h.requester_email.toLowerCase() !== email) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const [linesRes, whRes] = await Promise.all([
    admin
      .from('order_request_lines')
      .select(
        `id, quantity_requested, quantity_fulfilled,
         item:inventory_items!item_id (name)`,
      )
      .eq('order_request_id', id),
    admin
      .from('warehouses')
      .select('name')
      .eq('id', h.warehouse_id)
      .maybeSingle(),
  ]);

  type LineRow = {
    id: string;
    quantity_requested: number | string;
    quantity_fulfilled: number | string;
    item:
      | { name?: string }
      | { name?: string }[]
      | null;
  };
  const lines = ((linesRes.data ?? []) as LineRow[]).map((row) => {
    const itemField = row.item;
    const item = Array.isArray(itemField) ? itemField[0] ?? null : itemField;
    return {
      itemName: item?.name ?? 'Item',
      quantityRequested: Number(row.quantity_requested) || 0,
      quantityFulfilled: Number(row.quantity_fulfilled) || 0,
    };
  });

  const warehouseName =
    (whRes.data as { name?: string } | null)?.name ?? null;

  // I9: don't leak the manager-typed `denied_reason` to the public
  // requester. The reason often contains internal-only context
  // ("we're saving these for Lincoln Elementary", "this teacher
  // hasn't returned their last batch", etc.) and the public-facing
  // page is the wrong audience for it. Replace with a stock string
  // that gives the requester closure without exposing the rationale.
  // Future enhancement: per-request `share_denied_reason_with_requester`
  // opt-in flag on the manager actions panel — until then, default
  // private.
  const sanitizedDeniedReason =
    h.status === 'denied' ? 'Your request was not approved.' : null;

  // Same reasoning as denied_reason: the `notes` field is a
  // requester-typed message at submission time, but staff may
  // overwrite it from the manager panel with internal context
  // ("backorder this week", "swap with cheaper SKU"). The public
  // tracker is the wrong audience for that — return null until/unless
  // we add a dedicated "shareable to requester" notes field.
  // Their original requester-typed notes still live in the DB and the
  // confirmation email they got at submit time.
  return NextResponse.json({
    id: h.id,
    status: h.status,
    requesterName: h.requester_name,
    warehouseName,
    fulfillmentType: h.fulfillment_type,
    lines,
    createdAt: h.created_at,
    approvedAt: h.approved_at,
    packingSlipGeneratedAt: h.packing_slip_generated_at,
    stagedAt: h.staged_at,
    inTransitAt: h.in_transit_at,
    signedAt: h.signed_at,
    completedAt: h.completed_at,
    cancelledAt: h.cancelled_at,
    deniedReason: sanitizedDeniedReason,
    notes: null,
  });
}
