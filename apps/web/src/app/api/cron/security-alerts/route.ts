import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { runSecurityAlerts, SECURITY_ALERTS_TAG } from '@/server/security/alerts-job';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit, explicit. The run starts no claim after its own 50 s
 * deadline less the finish's reserve (server/security/alerts-job.ts,
 * SECURITY_ALERTS_RUN_DEADLINE_MS), cuts every call at that deadline, and
 * then waits for its reports 4 s at most (SECURITY_ALERTS_REPORTS_MAX_MS), so
 * it ends inside 60 s.
 */
export const maxDuration = 60;

// Route files export only what Next reads (route.test.ts pins these values).

/**
 * THE SECURITY ALERT JOB, every 10 minutes (vercel.json): one run of
 * runSecurityAlerts (server/security/alerts-job.ts says what it does, in the
 * contract's order). Release 4a is RECORD ONLY: every alert is claimed and
 * recorded, and nothing is sent to anyone.
 *
 * The answer, and the one log line of the run, hold counts and fixed words
 * only. Failures are counted by the job's heartbeat and reported by it; the
 * answer is 200 either way (a cron's answer nobody reads).
 *
 * Auth: Bearer ${CRON_SECRET}, compared in constant time, FAIL-CLOSED when
 * CRON_SECRET is unset (as security-events-retention): an unauthenticated GET
 * must never reach the service-role client.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const summary = await runSecurityAlerts();
  console.info(`[${SECURITY_ALERTS_TAG}]`, JSON.stringify(summary));
  return NextResponse.json(summary);
}
