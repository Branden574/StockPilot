import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const registerSchema = z.object({
  token: z.string().min(20).max(500),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().max(200).optional(),
});

/**
 * Register an Expo push token for the signed-in user. Idempotent on
 * `token` (push_tokens.token has a unique constraint), so the mobile
 * app can call this on every app open without piling up rows.
 *
 * WHY THIS GOES THROUGH AN RPC AND NOT A DIRECT UPSERT (SP-073, mig 0348).
 * This used to be `ctx.supabase.from('push_tokens').upsert(..., { onConflict:
 * 'token' })` on the USER-authed client. push_tokens carries exactly one
 * policy — push_tokens_self (0003_rls.sql) `using (user_id = auth.uid())` —
 * and Postgres evaluates ON CONFLICT DO UPDATE against the EXISTING row's
 * USING expression. On a SHARED warehouse device the existing row still
 * belongs to the person who signed out (nothing deletes it), so user B's
 * registration hit 42501 "new row violates row-level security policy (USING
 * expression)" — reproduced on local Postgres 2026-09-05 — this route
 * answered 500, and the Expo token stayed bound to user A for up to 120 days
 * (the dispatch window in 0028/0313). A's order approvals and low-stock
 * alerts kept landing on the device B was holding, and B got none.
 *
 * `register_push_token` (0348) is SECURITY DEFINER: it authorizes itself on
 * auth.uid(), drops any binding of that token to a DIFFERENT user, then
 * writes the caller's own row. RLS on push_tokens is unchanged.
 *
 * Body: { token, platform, deviceId? }
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'validation_error' },
      { status: 400 },
    );
  }

  const { token, platform, deviceId } = parsed.data;

  const { error } = await ctx.supabase.rpc('register_push_token', {
    p_token: token,
    p_platform: platform,
    p_device_id: deviceId ?? null,
  });
  if (error) {
    void reportError(new Error(error.message), {
      tag: 'push.register',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/**
 * Lets the mobile app deregister on sign-out. Removes only the
 * caller's own token. RLS already restricts to user_id = auth.uid().
 */
export async function DELETE(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }
  const { error } = await ctx.supabase
    .from('push_tokens')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('token', token);
  if (error) {
    void reportError(new Error(error.message), {
      tag: 'push.deregister',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
