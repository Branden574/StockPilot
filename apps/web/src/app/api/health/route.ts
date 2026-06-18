import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { env } from '@/lib/env';

import type { Database } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness/health endpoint for external uptime monitors (UptimeRobot,
 * Checkly, etc). Unauthenticated by design — it must be pingable without a
 * session.
 *
 * It does ONE cheap DB round-trip: a `head: true, count: 'exact'` against
 * `organizations` with `limit(0)`, so Postgres returns the row count in a
 * header and zero row data. The anon key is used (no service role required),
 * and RLS may scope the count to nothing for an unauthenticated caller —
 * that's fine: we only care that the query *executes without error*, not what
 * it returns. No tenant data is ever exposed.
 *
 * Response is intentionally minimal: ok/down booleans + a timestamp. Returns
 * HTTP 200 when the DB is reachable, 503 when the query errors.
 */
export async function GET() {
  const time = new Date().toISOString();

  let dbOk = false;
  try {
    const supabase = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await supabase
      .from('organizations')
      .select('id', { head: true, count: 'exact' })
      .limit(0);
    dbOk = !error;
  } catch {
    dbOk = false;
  }

  return NextResponse.json(
    { status: dbOk ? 'ok' : 'down', db: dbOk, time },
    {
      status: dbOk ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    },
  );
}
