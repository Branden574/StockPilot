import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { createRequesterReturn } from '@/server/services/returns';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public requester-initiated return submit endpoint (Returns Phase B, B4).
 *
 * PUBLIC + UNAUTHENTICATED. Called from `/returns/request/<token>`. The only
 * authorization the requester carries is the per-order `return_token`
 * (order_requests.return_token, 0156). The token scopes to EXACTLY ONE order;
 * everything else in the body is treated as hostile and re-validated
 * server-side inside `createRequesterReturn` against the order the token
 * resolves to (durable returned_quantity budget, line belonging, item identity
 * stamped from the source line, requester identity copied from the order — see
 * that function's contract). This route adds the public-surface defenses:
 *
 *   • HONEYPOT — an off-screen field real users never fill; a non-empty value
 *     silently returns a fake-success 200 so bots can't tune around it.
 *   • RATE LIMIT — two Supabase-backed buckets (0048) in fail-CLOSED mode:
 *     per-IP (10/hr) and per-token (30/hr). Closed mode means a DB outage
 *     denies rather than unlocking unlimited submissions on an anon endpoint.
 *
 * On success the return lands in the staff approval queue (status='requested',
 * source='requester'); no inventory moves until staff approve + receive + close.
 */

const lineSchema = z.object({
  orderRequestLineId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(10_000),
});

const bodySchema = z.object({
  // The return_token is a uuid (0156). Validate the shape here; the service
  // re-resolves it against the DB (a syntactically-valid but unknown token
  // becomes a 404 there, not here).
  token: z.string().uuid(),
  reasonCode: z.enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other']).optional(),
  notes: z.string().max(2000).nullish(),
  lines: z.array(lineSchema).min(1).max(100),
  // Honeypot — intentionally permissive on the schema so a tripped bot isn't
  // told why; the explicit check below silently fake-succeeds.
  hp: z.string().max(500).optional(),
});

type Body = z.infer<typeof bodySchema>;

const RATE_LIMIT_PER_IP_PER_HOUR = 10;
/**
 * Per-token cap. A single returnable order should not generate many return
 * requests; 30/hr is well above any legitimate retry-after-typo pattern but
 * stops a leaked/guessed token from flooding the staff approval queue.
 */
const RATE_LIMIT_PER_TOKEN_PER_HOUR = 30;
const ONE_HOUR_MS = 60 * 60 * 1000;
/** Mirror the public order-request cap so a requester can't file an
 *  oversized return. */
const MAX_TOTAL_QTY = 10_000;

export async function POST(req: NextRequest) {
  // 1. Parse + validate BEFORE touching the admin client.
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

  // 2. Honeypot — silently 200 with a fake id so a bot can't distinguish
  //    success from failure. Nothing is persisted.
  if (typeof body.hp === 'string' && body.hp.trim().length > 0) {
    return NextResponse.json({ id: 'ok' });
  }

  // 3. Total-qty cap (matches the public order-request route).
  const totalQty = body.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
  if (totalQty > MAX_TOTAL_QTY) {
    return NextResponse.json(
      {
        error: 'too_many_units',
        message: `Total quantity exceeds ${MAX_TOTAL_QTY.toLocaleString()} units per request.`,
      },
      { status: 400 },
    );
  }

  // 4. Rate limit. Only trust x-forwarded-for on Vercel (elsewhere a client
  //    could rotate the header to dodge the per-IP cap). Both buckets are
  //    fail-CLOSED on this anonymous surface.
  const onVercel = process.env.VERCEL === '1';
  const xff = onVercel ? req.headers.get('x-forwarded-for') : null;
  const ip = xff?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(`public-return-request:${ip}`, RATE_LIMIT_PER_IP_PER_HOUR, ONE_HOUR_MS, 'closed'),
    checkRateLimit(
      `public-return-request:token:${body.token}`,
      RATE_LIMIT_PER_TOKEN_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    ),
  ]);
  const denied = !ipLimit.allowed ? ipLimit : !tokenLimit.allowed ? tokenLimit : null;
  if (denied) {
    const retryAfter = Math.max(1, Math.ceil((denied.resetAt - Date.now()) / 1000));
    const trippedBucket = !ipLimit.allowed ? 'ip' : 'token';
    void reportError(new Error(`public return-request rate limit hit (${trippedBucket})`), {
      tag: 'public.returns.rate-limited',
      level: 'warning',
      extra: {
        bucket: trippedBucket,
        count: denied.count,
        retryAfterSeconds: retryAfter,
        tokenPrefix: body.token.slice(0, 8),
      },
    });
    return NextResponse.json(
      {
        error: 'rate_limited',
        message:
          "You've hit the request limit. Please wait an hour and try again, or contact the warehouse directly.",
      },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  // 5. Hand off to the service path, which re-validates the token + budget +
  //    line belonging server-side and creates the source='requester' return.
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  try {
    const result = await createRequesterReturn(admin, body.token, {
      reasonCode: body.reasonCode,
      notes: body.notes ?? undefined,
      lines: body.lines.map((l) => ({
        orderRequestLineId: l.orderRequestLineId,
        quantity: l.quantity,
      })),
    });
    return NextResponse.json({ id: result.id, returnNumber: result.returnNumber });
  } catch (e) {
    if (e instanceof ServiceError) {
      // Map service errors to status codes. not_found (bad/expired token) and
      // validation_error (over-return, bad line) surface a friendly message;
      // internal_error is logged.
      if (e.code === 'internal_error') {
        await reportError(e, { tag: 'public.returns.create' });
      }
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    await reportError(e, { tag: 'public.returns.create.unknown' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
