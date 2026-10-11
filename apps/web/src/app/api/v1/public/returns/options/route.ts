import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { RETURNS_COPY } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  publicRequestIp,
  RETURN_OPTIONS_PER_IP_PER_HOUR,
  RETURN_OPTIONS_PER_TOKEN_PER_HOUR,
  returnOptionsIpBucketKey,
  returnOptionsTokenBucketKey,
} from '@/lib/returns/public-limits';
import { createAdminClient } from '@/lib/supabase/admin';
import { exchangeOptionsForToken } from '@/server/services/returns-requester';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The token page's exchange sizes (returns RX-3): PUBLIC, called from
 * `/returns/request/<token>` on the first "Exchange for another size".
 *
 *   POST { token }  ->  200 RequesterExchangeOptionsAnswer
 *                       { exchangesEnabled, lines: [{ orderRequestLineId,
 *                         options: [{ itemId, name, sizeLabel, availability,
 *                         photo }] }] }
 *
 * Defenses on this surface (brief 32; plan RX-3 API):
 *   • POST ONLY, the token in the body: never in a URL, a log line or a CDN
 *     key. `Cache-Control: no-store` on every answer.
 *   • NO INPUT BUT THE TOKEN: no item, group, warehouse or quantity is read
 *     from the body (anything else in it is ignored), so the answer is the
 *     token's own order's eligible sizes and nothing else; a token never
 *     opens the catalog.
 *   • ONE 404 for every closed door: an unknown or malformed token, an order
 *     that is not returnable, the returns module switched off.
 *   • RATE LIMITS, fail-CLOSED: 120 an hour per IP and 600 an hour per
 *     token, the token bucket keyed by sha256(token).
 *   • TWO-STATE AVAILABILITY: "Available" or "Not in stock right now"; the
 *     free count never leaves the server. Photos are signed only for these
 *     sizes; a failed sign is a missing photo, never an error.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const ONE_HOUR_MS = 60 * 60 * 1000;

const CLOSED_DOOR = {
  error: 'not_found',
  message: 'This return link is invalid or has expired.',
};

const bodySchema = z.object({ token: z.string().uuid() });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_json', message: 'Check the form and try again.' },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = bodySchema.safeParse(raw);
  // A missing or malformed token is an unknown token: the same 404.
  if (!parsed.success) return NextResponse.json(CLOSED_DOOR, { status: 404, headers: NO_STORE });
  const token = parsed.data.token;

  const ip = publicRequestIp(req.headers);
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(returnOptionsIpBucketKey(ip), RETURN_OPTIONS_PER_IP_PER_HOUR, ONE_HOUR_MS, 'closed'),
    checkRateLimit(returnOptionsTokenBucketKey(token), RETURN_OPTIONS_PER_TOKEN_PER_HOUR, ONE_HOUR_MS, 'closed'),
  ]);
  const denied = !ipLimit.allowed ? ipLimit : !tokenLimit.allowed ? tokenLimit : null;
  if (denied) {
    const retryAfter = Math.max(1, Math.ceil((denied.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests. Wait a while and try again.' },
      { status: 429, headers: { ...NO_STORE, 'retry-after': String(retryAfter) } },
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: 'internal_error', message: RETURNS_COPY.requesterOptionsUnavailable },
      { status: 500, headers: NO_STORE },
    );
  }

  try {
    const answer = await exchangeOptionsForToken(admin, token);
    if (!answer) return NextResponse.json(CLOSED_DOOR, { status: 404, headers: NO_STORE });
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (e) {
    // Never the token or the body in the report.
    await reportError(e, { tag: 'public.returns.options' });
    return NextResponse.json(
      { error: 'internal_error', message: RETURNS_COPY.requesterOptionsUnavailable },
      { status: 500, headers: NO_STORE },
    );
  }
}
