import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';

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

  const { error } = await ctx.supabase
    .from('push_tokens')
    .upsert(
      {
        user_id: ctx.userId,
        token,
        platform,
        device_id: deviceId ?? null,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
