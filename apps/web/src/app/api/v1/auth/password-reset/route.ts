import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendPasswordResetEmail } from '@/lib/auth/password-reset-email';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Public (unauthenticated) password-reset request for the MOBILE app.
 *
 * The web form uses the requestPasswordResetAction server action, which
 * React Native cannot call. Before this route existed, mobile's "Forgot?"
 * called supabase.auth.resetPasswordForEmail directly from the device —
 * the exact capped-mailer + fragment-bounce + scanner-consumable pipeline
 * the web flow was migrated off of (f812bb4a/81a78c35/18c1cdd6).
 *
 * Contract mirrors requestPasswordResetAction exactly:
 *  - anti-enumeration: ALWAYS 200 {ok:true} — unknown email, rate limit,
 *    mint failure, and send failure are indistinguishable to the caller
 *  - rate limit: same key family (3/15min/email, fail-closed) plus an IP
 *    gate so one host can't fan out across addresses
 */
const schema = z.object({ email: z.string().email().max(320) });

export async function POST(req: NextRequest) {
  const generic = NextResponse.json({ ok: true });

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Malformed input is the one caller error worth surfacing — it's a
    // client bug, not an enumeration probe.
    return NextResponse.json({ error: 'invalid email' }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';

  const ipRl = await checkRateLimit(`pwreset-ip:${ip}`, 10, 15 * 60_000, 'closed');
  if (!ipRl.allowed) return generic;
  const emailRl = await checkRateLimit(`pwreset-req:${email}`, 3, 15 * 60_000, 'closed');
  if (!emailRl.allowed) return generic;

  await sendPasswordResetEmail(email).catch(() => {
    /* anti-enumeration: swallow */
  });
  return generic;
}
