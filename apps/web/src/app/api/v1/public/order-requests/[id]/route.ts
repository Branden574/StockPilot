import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Public order-request status read.
 *
 * Three independent checks must all pass before we return a payload:
 *   1. The request id exists.
 *   2. The `?token=` query authorizes the read: it is either the request's
 *      OWN `public_track_token` (mig 0330 — what status emails embed), or a
 *      live org/link catalog token, verified by comparing sha256(token)
 *      against `organizations.public_request_token_hash` /
 *      `public_request_links.token_hash` (the plaintext is no longer at
 *      rest anywhere).
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
  // Bucket key is the token's sha256 — rate_limit_buckets rows persist the
  // key, and a raw token there is a credential at rest (mig 0330 posture).
  const tokenBucketKey = sha256Hex(token);
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(`public-order-read:ip:${ip}`, 120, ONE_HOUR_MS, 'closed'),
    checkRateLimit(`public-order-read:token:${tokenBucketKey}`, 600, ONE_HOUR_MS, 'closed'),
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
        // Prefix of the HASH, never of the presented credential.
        tokenPrefix: tokenBucketKey.slice(0, 8),
      },
    });
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const admin = createAdminClient();

  const { data: header } = await admin
    .from('order_requests')
    .select(
      `id, status, requester_email, requester_name, notes, denied_reason,
       created_at, approved_at, packing_slip_generated_at, staged_at,
       in_transit_at, signed_at, completed_at, cancelled_at,
       organization_id, warehouse_id, fulfillment_type, return_token,
       public_track_token`,
    )
    .eq('id', id)
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
    return_token: string | null;
    public_track_token: string | null;
  };
  const orgId = h.organization_id;

  // Token authorization (mig 0330) — three accepted credentials, all
  // scoped to the request's own org, all failing to the same generic 404:
  //   a) the request's per-request track token (what status emails embed) —
  //      NULL-guarded so a row without one can never match an empty/na
  //      probe (a null <> anything the schema allowed through);
  //   b) the org's catalog token, compared as sha256(token) against the
  //      hashed at-rest column;
  //   c) any of the org's public_request_links tokens, likewise by hash —
  //      the submit flow hands out link-token track URLs, so a link token
  //      must keep authorizing the read exactly like the legacy org token.
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
    // DELIBERATELY NOT filtered on active/expires_at, unlike catalog
    // resolution. A requester who submitted through a link that was later
    // disabled or expired must still be able to track the order they already
    // placed — revoking a link is meant to stop NEW submissions, not to
    // orphan in-flight orders. The blast radius stays one order: the caller
    // must also know the order id AND present the matching requester email
    // (checked immediately below), and the payload is the redacted
    // single-order shape. The legacy org token never had an active flag
    // either, so this preserves the pre-hash behavior rather than widening
    // it. If link revocation is ever required to kill tracking too, add
    // .eq('active', true) here AND state the product decision.
    const { data: linkMatch } = await admin
      .from('public_request_links')
      .select('id')
      .eq('organization_id', orgId)
      .eq('token_hash', tokenHash)
      .maybeSingle();
    authorized = linkMatch != null;
  }
  if (!authorized) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
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

  // Returns-access Unit A: surface the requester's own self-service return
  // link on the tracking page. Only when the order is terminal-fulfilled —
  // 'completed', or the legacy 'delivered' status every other returns surface
  // also treats as returnable — with at least one fulfilled unit, a
  // return_token was minted (0156 — happens on completion when the returns
  // module is on), AND the org still has the module enabled (the portal 404s
  // without it — never render a dead link). Safe to expose here: the caller
  // already proved the token+id+email triad, i.e. this is the requester's own
  // order, and the return_token is exactly the credential the
  // /returns/request/[token] portal hands that requester.
  let returnPath: string | null = null;
  if (
    (h.status === 'completed' || h.status === 'delivered') &&
    h.return_token &&
    lines.some((l) => l.quantityFulfilled > 0)
  ) {
    const { data: returnsMod } = await admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', orgId)
      .eq('module_id', 'returns')
      .eq('enabled', true)
      .maybeSingle();
    if (returnsMod) returnPath = `/returns/request/${h.return_token}`;
  }

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
    returnPath,
  });
}
