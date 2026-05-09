import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily cleanup for ai_chat_sessions older than 30 days. Wired to Vercel
 * Cron via vercel.json (0 4 * * * UTC). Uses the service-role client
 * because the SQL function is granted to service_role only — no user
 * RLS context here.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. We
 * reject anything else with 401 so the route can't be hit by random
 * traffic.
 */
export async function GET(req: Request) {
  // Fail-closed: an empty/unset CRON_SECRET in the env must NOT skip
  // the auth check. The previous `if (env.CRON_SECRET) { ... }` made
  // misconfigured staging/dev deployments serve this route to any
  // unauthenticated GET, which is an admin-client surface (drops chat
  // history org-wide). Reject hard whenever the secret is absent.
  if (!env.CRON_SECRET) {
    return NextResponse.json(
      { error: 'cron_secret_not_configured' },
      { status: 503 },
    );
  }
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('purge_ai_chat_history');
    if (error) throw new Error(error.message);
    const deleted = (data as number | null) ?? 0;
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    void reportError(err, { tag: 'cron.purge-ai-chat-history' });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Purge failed' },
      { status: 500 },
    );
  }
}
