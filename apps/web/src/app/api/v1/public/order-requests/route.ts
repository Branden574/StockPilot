import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

import type { OrderRequestRow } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public order-request submit endpoint.
 *
 * Called from `/r/<token>` — anonymous external requesters. Authenticates
 * the *org*, not the user, via the persistent `public_request_token`
 * stored on `organizations`. Uses the service-role admin client because
 * the writer has no Supabase JWT; the input validation below is the
 * only thing standing between a stranger and our DB, so each step
 * runs BEFORE any write.
 *
 * Rate-limited to 10 requests per IP per hour (in-memory; v1.1 will
 * promote this to a Supabase-backed bucket — see `lib/rate-limit.ts`).
 */

const lineSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(10_000),
  notes: z.string().max(500).nullish(),
});

const bodySchema = z.object({
  token: z.string().min(16).max(128),
  warehouseId: z.string().uuid(),
  requesterName: z.string().trim().min(1).max(120),
  requesterEmail: z.string().trim().email().max(254),
  requesterOrgLabel: z.string().trim().max(160).nullish(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(lineSchema).min(1).max(100),
});

type Body = z.infer<typeof bodySchema>;

const RATE_LIMIT_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;
/**
 * Hard cap on total units per public submission. Mirrors `MAX_TOTAL_QTY`
 * in `server/actions/order-requests.ts` so a public submitter can't
 * file a request that's larger than what an authenticated team member
 * could file in-app.
 */
const MAX_TOTAL_QTY = 10_000;

export async function POST(req: NextRequest) {
  // 1. Parse + validate body BEFORE touching the admin client.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'validation_error' },
      { status: 400 },
    );
  }
  const body: Body = parsed.data;

  // 1b. Enforce a total-quantity cap and dedupe lines by itemId so a
  // submitter can't bypass the per-line max by sending 50 rows of
  // 10,000 each, and can't bloat the request with duplicate itemIds.
  // Mirrors `MAX_TOTAL_QTY` in `server/actions/order-requests.ts`.
  const totalQty = body.lines.reduce(
    (sum, l) => sum + (Number(l.quantity) || 0),
    0,
  );
  if (totalQty > MAX_TOTAL_QTY) {
    return NextResponse.json(
      {
        error: 'too_many_units',
        message: `Total quantity exceeds ${MAX_TOTAL_QTY.toLocaleString()} units per request.`,
      },
      { status: 400 },
    );
  }
  const byItem = new Map<string, { quantity: number; notes: string | null }>();
  for (const l of body.lines) {
    const prev = byItem.get(l.itemId);
    const qty = (prev?.quantity ?? 0) + (Number(l.quantity) || 0);
    // Keep the first non-null note we see for an itemId — collapses
    // duplicates without dropping line-level context the submitter
    // attached. Empty/null notes from a later dup don't overwrite.
    const notes = prev?.notes ?? l.notes ?? null;
    byItem.set(l.itemId, { quantity: qty, notes });
  }
  const dedupedLines = Array.from(byItem.entries()).map(([itemId, v]) => ({
    itemId,
    quantity: v.quantity,
    notes: v.notes,
  }));

  // 2. Rate limit per IP. We trust x-forwarded-for since Vercel sets it.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  // `mode: 'closed'` — this is an unauthenticated endpoint, so a DB
  // outage that makes the rate-limiter fall back to fail-open would
  // grant unlimited submissions. Prefer to 429 during the outage.
  const limit = await checkRateLimit(
    `public-order-request:${ip}`,
    RATE_LIMIT_PER_HOUR,
    ONE_HOUR_MS,
    'closed',
  );
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: 'rate_limited',
        message:
          "You've hit the request limit. Please wait an hour and try again, or email us directly.",
      },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const admin = createAdminClient();

  // 3. Resolve the org by token. If the token doesn't exist we return
  // 404 so we don't leak which orgs use the feature.
  const { data: org, error: orgErr } = await admin
    .from('organizations')
    .select('id')
    .eq('public_request_token', body.token)
    .maybeSingle();
  if (orgErr) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!org) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const organizationId = (org as { id: string }).id;

  // 4. Verify the warehouse is in the org and is publicly orderable.
  const { data: wh, error: whErr } = await admin
    .from('warehouses')
    .select('id, is_public_orderable, organization_id')
    .eq('id', body.warehouseId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (whErr) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!wh || !(wh as { is_public_orderable?: boolean }).is_public_orderable) {
    return NextResponse.json(
      { error: 'warehouse_not_orderable' },
      { status: 400 },
    );
  }

  // 5. Validate every line item: belongs to this org + warehouse,
  // item_type='book', not soft-deleted, status='active'. Snapshot
  // unit_cost from each item. Operates on `dedupedLines` so the
  // validation set matches what we'll actually insert.
  const itemIds = [...new Set(dedupedLines.map((l) => l.itemId))];
  const { data: items, error: itemsErr } = await admin
    .from('inventory_items')
    .select('id, warehouse_id, unit_cost, item_type, status, deleted_at')
    .eq('organization_id', organizationId)
    .in('id', itemIds);
  if (itemsErr) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  type ItemRow = {
    id: string;
    warehouse_id: string | null;
    unit_cost: number | string | null;
    item_type: string;
    status: string;
    deleted_at: string | null;
  };
  const itemMap = new Map<string, { unitCost: number }>();
  for (const row of (items ?? []) as ItemRow[]) {
    if (row.deleted_at) continue;
    if (row.status !== 'active') continue;
    if (row.item_type !== 'book') continue;
    if (row.warehouse_id !== body.warehouseId) continue;
    itemMap.set(row.id, { unitCost: Number(row.unit_cost) || 0 });
  }
  for (const line of dedupedLines) {
    if (!itemMap.has(line.itemId)) {
      return NextResponse.json(
        { error: 'invalid_line', message: 'One of the books is no longer available.' },
        { status: 400 },
      );
    }
  }

  // 6. Insert header. Use the rollback-on-line-error pattern from
  // OrderRequestsService.create — if line insert fails, delete the
  // header so we don't leave orphans behind.
  const { data: headerRow, error: headerErr } = await admin
    .from('order_requests')
    .insert({
      organization_id: organizationId,
      warehouse_id: body.warehouseId,
      status: 'pending_approval',
      source: 'public_link',
      requester_user_id: null,
      requester_email: body.requesterEmail,
      requester_name: body.requesterName,
      requester_org_label: body.requesterOrgLabel ?? null,
      notes: body.notes ?? null,
    })
    .select('*')
    .single();
  if (headerErr || !headerRow) {
    return NextResponse.json(
      { error: 'internal_error', message: headerErr?.message ?? 'header_insert_failed' },
      { status: 500 },
    );
  }
  const header = headerRow as OrderRequestRow;

  const linePayload = dedupedLines.map((l) => ({
    order_request_id: header.id,
    item_id: l.itemId,
    quantity_requested: l.quantity,
    unit_cost_at_request: itemMap.get(l.itemId)?.unitCost ?? 0,
    notes: l.notes ?? null,
  }));
  const { error: lineErr } = await admin
    .from('order_request_lines')
    .insert(linePayload);
  if (lineErr) {
    await admin.from('order_requests').delete().eq('id', header.id);
    return NextResponse.json(
      { error: 'internal_error', message: lineErr.message },
      { status: 500 },
    );
  }

  // 7. Send confirmation email. Background-style — failure to send
  // shouldn't 500 the whole submit, since the row is already persisted
  // and the manager bell+push trigger has fired DB-side.
  try {
    await sendOrderRequestEmail({
      kind: 'submitted',
      request: header,
      recipientEmail: body.requesterEmail,
      recipientName: body.requesterName,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
    });
  } catch (e) {
    console.warn('[public order-requests] email send failed', e);
  }

  return NextResponse.json({
    id: header.id,
    // Include `t=` so the URL is self-contained — the GET track route
    // requires the token to scope the lookup. The browser-side form
    // used to append it client-side; folding it in here means any API
    // consumer (and any server-rendered email template) can use the
    // returned URL verbatim.
    trackUrl:
      `/r/track?id=${header.id}` +
      `&email=${encodeURIComponent(body.requesterEmail)}` +
      `&t=${encodeURIComponent(body.token)}`,
  });
}
