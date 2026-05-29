import { createHash, randomBytes } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { reportError } from '@/lib/error-reporter';
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
  // I14: integer-only quantities here too. Mirrors the internal create
  // schema so the public surface can't slip a fractional order past
  // the internal validators.
  quantity: z.coerce.number().int().positive().max(10_000),
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
  // Rolling-deploy safety: default to 'pickup' when an old-bundle
  // client posts without the field. The DB column also defaults to
  // 'delivery' (migration 0109), so worst case a legacy submission
  // lands as 'pickup' here and gets recorded faithfully — no 400 on
  // tabs left open across the deploy boundary.
  fulfillmentType: z.enum(['pickup', 'delivery']).default('pickup'),
  requesterPhone: z.string().trim().max(40).nullish(),
  deliveryCharterId: z.string().uuid().nullish(),
  pickupLocationNotes: z.string().trim().max(2000).nullish(),
  // I13: hidden honeypot field. Real submitters never fill it in
  // (it's not visible to humans); naive form-fillers fill every
  // visible+invisible field. Reject when it's non-empty so we can
  // drop the most casual bot traffic before it even hits validation.
  // The field is intentionally permissive on the schema (`optional`,
  // any string) so blocks happen at the explicit check below, not
  // via schema-rejection that would leak its purpose in error text.
  hp: z.string().max(500).optional(),
});

type Body = z.infer<typeof bodySchema>;

const RATE_LIMIT_PER_HOUR = 10;
/**
 * Per-email cap to stop Resend-spam-via-public-form. Five confirmation
 * emails per hour to a single address is plenty for any legitimate
 * submitter (resubmit-after-typo, multi-warehouse split) and small
 * enough that an attacker fanning attacker-controlled `requesterEmail`
 * out of a single domain can't burn our Resend allotment to send abuse
 * to third parties.
 */
const RATE_LIMIT_PER_EMAIL_PER_HOUR = 5;
/**
 * Per-org-token cap. Caps the total submission volume against a single
 * org so a single leaked or guessed token can't be used to flood that
 * org's manager inbox or DB write surface. 60/hr is well above
 * legitimate large-school use (a teacher placing rolling orders) but
 * keeps a runaway client from generating thousands of pending_approval
 * rows that a manager would then have to sweep.
 */
const RATE_LIMIT_PER_TOKEN_PER_HOUR = 60;
/**
 * F1 soft-flag threshold. When a single requester email + org token
 * is seen from more than this many distinct IPs in one hour, log a
 * console.warn (does NOT block). Useful breadcrumb for spam-pattern
 * investigation; legitimate cross-device use (mobile + desktop + home
 * wifi) plausibly hits 2-3 IPs in a session.
 */
const IP_FANOUT_FLAG = 3;
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

  if (body.fulfillmentType === 'delivery' && !body.deliveryCharterId) {
    return NextResponse.json(
      { error: 'delivery_charter_required', message: 'Delivery orders need a site.' },
      { status: 400 },
    );
  }

  // I13: honeypot trip — silently 200 so bots can't distinguish
  // success from failure and tune around it. (We don't actually
  // persist anything; the request just looks accepted from outside.)
  if (typeof body.hp === 'string' && body.hp.trim().length > 0) {
    return NextResponse.json({ id: 'ok' });
  }

  // 1b. Dedupe lines by itemId BEFORE the total-qty check so a
  // submitter can't trip the cap with duplicate rows that we'd
  // collapse anyway. (I5: dedup-before-total ordering swap.)
  // Then enforce the total-quantity cap. Mirrors `MAX_TOTAL_QTY`
  // in `server/actions/order-requests.ts`.
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
  const totalQty = dedupedLines.reduce(
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

  // 2. Rate limit per IP. We only trust `x-forwarded-for` when running
  // on Vercel — outside of Vercel the platform may not strip client-
  // supplied XFF, so a submitter could rotate the header to bypass
  // the per-IP cap. Local dev / self-hosted falls back to the socket
  // address via `x-real-ip`, or the unknown bucket. (C7)
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? req.headers.get('x-forwarded-for') : null;
  const ip =
    xff?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  // `mode: 'closed'` — this is an unauthenticated endpoint, so a DB
  // outage that makes the rate-limiter fall back to fail-open would
  // grant unlimited submissions. Prefer to 429 during the outage.
  //
  // H1: three independent buckets — per-IP (existing), per-email,
  // per-token. Per-email caps Resend-spam fan-out where an attacker
  // rotates IPs but reuses an attacker-supplied `requesterEmail`.
  // Per-token caps the total volume against a single org so a leaked
  // link can't be used to flood one tenant. All three use the same
  // window and closed mode. Email is keyed on the lowercased value
  // so case rotation can't create a new bucket per submission.
  const emailKey = body.requesterEmail.trim().toLowerCase();
  const tokenKey = body.token;
  const [ipLimit, emailLimit, tokenLimit] = await Promise.all([
    checkRateLimit(
      `public-order-request:${ip}`,
      RATE_LIMIT_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    ),
    checkRateLimit(
      `public-order-request:email:${emailKey}`,
      RATE_LIMIT_PER_EMAIL_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    ),
    checkRateLimit(
      `public-order-request:token:${tokenKey}`,
      RATE_LIMIT_PER_TOKEN_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    ),
  ]);
  const denied = !ipLimit.allowed
    ? ipLimit
    : !emailLimit.allowed
      ? emailLimit
      : !tokenLimit.allowed
        ? tokenLimit
        : null;
  if (denied) {
    const retryAfter = Math.max(1, Math.ceil((denied.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: 'rate_limited',
        message:
          "You've hit the request limit. Please wait an hour and try again, or email us directly.",
      },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  // F1 soft-flag: track distinct IPs per (email, token) over the same
  // hour window. We DO NOT block here — co-workers on a shared inbox
  // switching mobile → desktop → home wifi can easily trip 2-3 IPs in a
  // single session. Past IP_FANOUT_FLAG we just console.warn so the
  // pattern surfaces in logs for manual review.
  //
  // Implementation: a high-limit 'open' bucket per (email|token|ip)
  // tuple. First touch in the hour increments to 1, telling us "this IP
  // is new for this (email, token) this hour"; we then bump a separate
  // (email|token) counter and check it against the threshold. Open
  // mode + try/catch ensures a DB blip here NEVER fails the submission.
  try {
    const fanoutTuple = await checkRateLimit(
      `public-order-request:fanout:${emailKey}|${tokenKey}|${ip}`,
      9999,
      ONE_HOUR_MS,
      'open',
    );
    if (fanoutTuple.count === 1) {
      const distinctIps = await checkRateLimit(
        `public-order-request:fanout-distinct:${emailKey}|${tokenKey}`,
        9999,
        ONE_HOUR_MS,
        'open',
      );
      if (distinctIps.count > IP_FANOUT_FLAG) {
        console.warn(
          '[public order-requests] suspected IP fanout',
          JSON.stringify({
            email: emailKey,
            tokenPrefix: tokenKey.slice(0, 8),
            distinctIpsThisHour: distinctIps.count,
            ip,
          }),
        );
      }
    }
  } catch {
    // Non-fatal — logging-only path; do not bubble.
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

  // Module gate — public order requests are an optional module. The
  // service layer's assertModuleEnabled can't run here (no
  // ServiceContext on this anonymous path), so check enablement
  // directly against organization_modules. A 404 (not 403) so we
  // don't leak that the org exists but has the feature off — same
  // posture as the unknown-token branch above. `public_requests` is
  // optional (not core), so an explicit enabled row is required.
  const { data: modRow, error: modErr } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', organizationId)
    .eq('module_id', 'public_requests')
    .eq('enabled', true)
    .maybeSingle();
  if (modErr) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!modRow) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

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

  // 4b. For delivery orders, verify the picked charter is one this
  // warehouse actually services. The FK + CHECK constraint enforce this
  // at the DB level, but a friendlier 400 here saves a generic 23-error.
  if (body.fulfillmentType === 'delivery' && body.deliveryCharterId) {
    const { data: pair } = await admin
      .from('warehouse_charters')
      .select('charter_id')
      .eq('organization_id', organizationId)
      .eq('warehouse_id', body.warehouseId)
      .eq('charter_id', body.deliveryCharterId)
      .maybeSingle();
    if (!pair) {
      return NextResponse.json(
        { error: 'invalid_charter', message: 'That site is not serviced by the chosen warehouse.' },
        { status: 400 },
      );
    }
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

  // C8: normalize the requester email to lowercase on insert so the
  // public track route's case-insensitive match (`lower(stored) ===
  // lower(query)`) never has to coerce stored values at read time.
  // Also collapses "Alice@Foo.com" vs "alice@foo.com" duplicates
  // into a single canonical address for downstream dedupe / lookup.
  const requesterEmail = body.requesterEmail.toLowerCase();

  // Anti-spam double opt-in: every public submit lands as
  // `pending_confirmation` and only becomes visible to the manager
  // queue once the requester clicks the link in the confirmation
  // email. This converts our threat model from "anyone with the org
  // token can spam Resend / the manager inbox" to "anyone with the org
  // token can prompt the listed email with one click-to-confirm
  // message" — much narrower. The token below is 256 bits of randomness;
  // we store ONLY its sha256 hash and email the plaintext.
  const plaintextToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Cheap reaper — clear stale unconfirmed rows so the table doesn't
  // accumulate junk over time. Best-effort; never fail the submit on
  // it. Supabase's RPC builder is a PromiseLike (no .catch), so we
  // await it inside a try/catch and swallow any error.
  try {
    await admin.rpc('cleanup_expired_unconfirmed_order_requests');
  } catch {
    /* non-fatal */
  }

  // 6. Insert header. Use the rollback-on-line-error pattern from
  // OrderRequestsService.create — if line insert fails, delete the
  // header so we don't leave orphans behind.
  const { data: headerRow, error: headerErr } = await admin
    .from('order_requests')
    .insert({
      organization_id: organizationId,
      warehouse_id: body.warehouseId,
      status: 'pending_confirmation',
      source: 'public_link',
      requester_user_id: null,
      requester_email: requesterEmail,
      requester_name: body.requesterName,
      requester_org_label: body.requesterOrgLabel ?? null,
      notes: body.notes ?? null,
      fulfillment_type: body.fulfillmentType,
      requester_phone: body.requesterPhone ?? null,
      delivery_charter_id: body.deliveryCharterId ?? null,
      pickup_location_notes: body.pickupLocationNotes ?? null,
      confirmation_token_hash: tokenHash,
      confirmation_token_expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (headerErr || !headerRow) {
    if (headerErr) {
      await reportError(headerErr, { tag: 'public.order-requests.header-insert' });
    }
    return NextResponse.json(
      { error: 'internal_error', message: 'Order could not be submitted. Please try again.' },
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
    await reportError(lineErr, {
      tag: 'public.order-requests.line-insert',
      extra: { headerId: header.id },
    });
    return NextResponse.json(
      { error: 'internal_error', message: 'Order could not be submitted. Please try again.' },
      { status: 500 },
    );
  }

  // 7. Send the confirm-click email. The row is sitting at
  // `pending_confirmation`; until the recipient clicks the link the
  // manager queue does not see it (the notify trigger skips the
  // INSERT broadcast for that status; see migration 0108). Send is
  // best-effort but a hard failure here means the row CAN'T be
  // confirmed — log and let the user reach out by other means.
  try {
    await sendOrderRequestEmail({
      kind: 'confirm_request',
      request: header,
      recipientEmail: requesterEmail,
      recipientName: body.requesterName,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
      // Plaintext token goes ONLY in the email. The DB stores the
      // sha256 hash so a DB leak alone doesn't grant confirm
      // power.
      confirmationToken: plaintextToken,
      // publicRequestToken is unused for confirm_request (the
      // CTA points at /r/confirm, not /r/track) but pass it for
      // future flexibility.
      publicRequestToken: body.token,
    });
  } catch (e) {
    console.warn('[public order-requests] confirm-email send failed', e);
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
      `&email=${encodeURIComponent(requesterEmail)}` +
      `&t=${encodeURIComponent(body.token)}`,
  });
}
