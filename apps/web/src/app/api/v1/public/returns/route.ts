import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { returnTokenBucketKey } from '@/lib/returns/public-limits';
import { createAdminClient } from '@/lib/supabase/admin';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { createRequesterReturn } from '@/server/services/returns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public requester-initiated return submit (returns RX-1 on the Phase B
 * route). PUBLIC + UNAUTHENTICATED, called from `/returns/request/<token>`.
 * The per-order return token (order_request_secrets since 0392) is the only
 * authorization; it opens exactly one order, resolved server-side. The
 * create itself is ONE database transaction
 * (create_requester_return_request, service role only): every line is
 * re-checked against that order (belonging, the durable budget less pending
 * demand, the cap trigger), the item is stamped from the source line, the
 * disposition is always restock, and the requester's name and email come
 * from the order. zod strips everything else a client might send
 * (disposition, status, warehouse, organization, location, item).
 *
 * Defenses on this surface:
 *   • HONEYPOT: a non-empty `hp` answers a fake success and writes nothing.
 *   • 10,000 units per request, at most 100 lines.
 *   • RATE LIMIT, fail-CLOSED: per IP (10 an hour) and per token (30 an
 *     hour). The token bucket is keyed by sha256(token), so the raw token
 *     never lands in the rate-limit table.
 *   • IDEMPOTENT: `idempotencyKey` (minted when the form opens) replays the
 *     same RMA on a resend; a body without one gets a fresh key.
 *   • ONE ANSWER for every closed door: an unknown token, an order that is
 *     not returnable, and the module switched off all answer the same 404.
 *
 * On success the return waits in the staff approval queue; nothing moves
 * until staff approve, receive and process it.
 */

const lineSchema = z.object({
  orderRequestLineId: z.string().uuid(),
  quantity: z.number().int().positive().max(10_000),
});

const bodySchema = z.object({
  token: z.string().uuid(),
  reasonCode: z.enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other']).optional(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(lineSchema).min(1).max(100),
  idempotencyKey: z.string().uuid().optional(),
  hp: z.string().max(500).optional(),
});

type Body = z.infer<typeof bodySchema>;

const RATE_LIMIT_PER_IP_PER_HOUR = 10;
const RATE_LIMIT_PER_TOKEN_PER_HOUR = 30;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_TOTAL_QTY = 10_000;

const CLOSED_DOOR = {
  error: 'not_found',
  message: 'This return link is invalid or has expired.',
};

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json', message: 'Check the form and try again.' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Check the items and quantities, then try again.' },
      { status: 400 },
    );
  }
  const body: Body = parsed.data;

  if (typeof body.hp === 'string' && body.hp.trim().length > 0) {
    return NextResponse.json({ id: 'ok' });
  }

  const totalQty = body.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
  if (totalQty > MAX_TOTAL_QTY) {
    return NextResponse.json(
      { error: 'too_many_units', message: `Total quantity exceeds ${MAX_TOTAL_QTY.toLocaleString()} units per request.` },
      { status: 400 },
    );
  }

  // Only trust x-forwarded-for on Vercel (elsewhere a client could rotate it).
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? req.headers.get('x-forwarded-for') : null;
  const ip = xff?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(`public-return-request:${ip}`, RATE_LIMIT_PER_IP_PER_HOUR, ONE_HOUR_MS, 'closed'),
    checkRateLimit(returnTokenBucketKey(body.token), RATE_LIMIT_PER_TOKEN_PER_HOUR, ONE_HOUR_MS, 'closed'),
  ]);
  const denied = !ipLimit.allowed ? ipLimit : !tokenLimit.allowed ? tokenLimit : null;
  if (denied) {
    const retryAfter = Math.max(1, Math.ceil((denied.resetAt - Date.now()) / 1000));
    const trippedBucket = !ipLimit.allowed ? 'ip' : 'token';
    void reportError(new Error(`public return-request rate limit hit (${trippedBucket})`), {
      tag: 'public.returns.rate-limited',
      level: 'warning',
      extra: { bucket: trippedBucket, count: denied.count, retryAfterSeconds: retryAfter },
    });
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: "You've hit the request limit. Please wait an hour and try again, or contact the warehouse directly.",
      },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'internal_error', message: 'Something went wrong. Try again.' }, { status: 500 });
  }

  try {
    const result = await createRequesterReturn(
      admin,
      body.token,
      {
        reasonCode: body.reasonCode,
        notes: body.notes ?? undefined,
        lines: body.lines.map((l) => ({ orderRequestLineId: l.orderRequestLineId, quantity: l.quantity })),
      },
      { idempotencyKey: body.idempotencyKey ?? null },
    );
    return NextResponse.json(
      { id: result.id, returnNumber: result.returnNumber, replay: result.replay },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      if (e.code === 'not_found' || e.code === 'module_disabled' || e.code === 'forbidden') {
        return NextResponse.json(CLOSED_DOOR, { status: 404 });
      }
      if (e.code === 'internal_error') {
        await reportError(e, { tag: 'public.returns.create' });
        return NextResponse.json({ error: 'internal_error', message: 'Something went wrong. Try again.' }, { status: 500 });
      }
      const reason = typeof e.details?.reason === 'string' ? e.details.reason : undefined;
      return NextResponse.json(
        { error: e.code, message: e.message, ...(reason ? { details: { reason } } : {}) },
        { status: serviceErrorStatus(e.code) },
      );
    }
    await reportError(e, { tag: 'public.returns.create.unknown' });
    return NextResponse.json({ error: 'internal_error', message: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
