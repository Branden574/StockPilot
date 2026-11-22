import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { AUTH_LOGS_TAG, readAuthLogs } from '@/server/security/auth-logs';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit, explicit. The run cuts every call at its own 50 s deadline
 * (server/security/auth-logs.ts, AUTH_LOGS_RUN_DEADLINE_MS) and then waits
 * for its reports 4 s at most (AUTH_LOGS_REPORTS_MAX_MS), so it ends inside
 * 60 s.
 */
export const maxDuration = 60;

// Route files export only what Next reads (route.test.ts pins these values).

/**
 * REFUSED SIGN-INS FROM SUPABASE'S LOGS, at ten past every hour UTC
 * (vercel.json): counts the refused password sign-ins and authenticator code
 * checks that went straight to Supabase (the phone app, direct callers) in
 * the last six complete hours, and stores the counts in the security-events
 * record (readAuthLogs says how, and what it never reads or stores).
 *
 * No token set (SUPABASE_LOGS_READ_TOKEN: the lab, previews, production
 * until the setting is there): answers { skipped: 'no_token' } and does
 * nothing. A missing optional setting is not an error.
 *
 * The answer, and the one log line of the run, hold counts and codes only.
 * Failures are reported by the job; the answer is 200 either way (a cron's
 * answer nobody reads).
 *
 * Auth: Bearer ${CRON_SECRET}, compared in constant time, FAIL-CLOSED when
 * CRON_SECRET is unset (as security-events-retention): an unauthenticated GET
 * must never reach the logs token or the service-role client.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = env.SUPABASE_LOGS_READ_TOKEN;
  if (!token) {
    return NextResponse.json({ skipped: 'no_token' });
  }

  const result = await readAuthLogs({ token, supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL });
  console.info(`[${AUTH_LOGS_TAG}]`, JSON.stringify(result));
  return NextResponse.json(result);
}
