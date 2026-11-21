import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit, explicit. The loop starts no call after RUN_BUDGET_MS
 * (45 s); the call in flight then waits at most 2 s for its turn (the
 * function's lock_timeout) and removes at most 5,000 rows and clears at most
 * 5,000 hashes, so a run ends well inside 120 s.
 */
export const maxDuration = 120;

// Route files export only what Next reads (route.test.ts pins these values).

/** What one purge_security_events() call handles of each kind, at most. */
const PURGE_BATCH = 5000;
/** Calls in one run, at most (a busy turn counts as a call). */
const MAX_CALLS = 40;
/** No call starts after this long into the run. */
const RUN_BUDGET_MS = 45_000;
/** The wait after a call that found the table busy (55P03). */
const BUSY_RETRY_MS = 500;
/** Busy calls in a row that end the run, reported. */
const BUSY_STOP_AFTER = 3;

const TAG = 'cron.security-events-retention';

type StopReason = 'call_limit' | 'time_limit' | 'busy';

/** A count from the function's answer: a whole number from 0 up, or null. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SECURITY EVENTS RETENTION, four times a day at half past the hour, every
 * sixth hour UTC (vercel.json): calls purge_security_events() (migration
 * security_events), which deletes rows older than 90 days and clears the
 * source hash from rows older than 24 hours, at most 5,000 of each per call,
 * until both counts come back under 5,000: at most MAX_CALLS calls and
 * RUN_BUDGET_MS a run, whichever comes first. What a run leaves, the next one
 * takes. With nothing to do, a run is one cheap call.
 *
 * Four runs a day clear up to 800,000 hashes, more than the writer admits
 * with no organization in a day (200 rows a minute). A run that stops on
 * MAX_CALLS or RUN_BUDGET_MS still had work left, which means the purge is
 * being outrun; that stop is reported (warning), once per run.
 *
 * The function runs one call at a time with the recorder (an advisory lock);
 * a call that waits 2 s for its turn ends with 55P03. One such call is tried
 * again on the next turn of the loop, BUSY_RETRY_MS later; BUSY_STOP_AFTER in
 * a row end the run, and that stop is reported the same way. Any other error
 * is reported and answered 500.
 *
 * The answer: the summed counts, the number of calls, and whether the run
 * stopped before the work was done, and why. Never a row.
 *
 * Auth: Bearer ${CRON_SECRET}, compared in constant time, FAIL-CLOSED when
 * CRON_SECRET is unset (as purge-ai-chat-history): an unauthenticated GET must
 * never reach the service-role client.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  let deleted = 0;
  let hashesCleared = 0;
  let calls = 0;
  let busyInARow = 0;
  let stop: StopReason | null = null;

  try {
    const admin = createAdminClient();
    for (;;) {
      if (calls >= MAX_CALLS) {
        stop = 'call_limit';
        break;
      }
      if (Date.now() - started >= RUN_BUDGET_MS) {
        stop = 'time_limit';
        break;
      }
      calls += 1;
      const { data, error } = await admin.rpc('purge_security_events');
      if (error) {
        if ((error as { code?: unknown }).code === '55P03') {
          busyInARow += 1;
          if (busyInARow >= BUSY_STOP_AFTER) {
            stop = 'busy';
            break;
          }
          await pause(BUSY_RETRY_MS);
          continue;
        }
        const code = String((error as { code?: unknown }).code ?? 'no code');
        throw new Error(`purge_security_events failed (${code})`);
      }
      busyInARow = 0;
      const answer = (data ?? {}) as { deleted?: unknown; hashes_cleared?: unknown };
      const removed = countOf(answer.deleted);
      const cleared = countOf(answer.hashes_cleared);
      if (removed === null || cleared === null) {
        throw new Error('purge_security_events answered without its two counts');
      }
      deleted += removed;
      hashesCleared += cleared;
      if (removed < PURGE_BATCH && cleared < PURGE_BATCH) break;
    }
  } catch (err) {
    // Awaited: an answer sent first could leave the report's POST in flight
    // on a suspended instance. reportError never throws.
    await reportError(err, { tag: TAG, extra: { calls, deleted, hashesCleared } });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  if (stop !== null) {
    // The run ended with work left: the table stayed busy, or there was more
    // to purge than one run takes (a sustained flood can write faster than
    // this job removes). Said once per run, with counts only, so a purge
    // that is being outrun is seen before the 24-hour rule stops holding.
    const why =
      stop === 'busy'
        ? 'the table stayed busy'
        : stop === 'call_limit'
          ? 'more was left than one run takes'
          : 'the run reached its time limit';
    await reportError(new Error(`Security events retention stopped: ${why}`), {
      tag: TAG,
      level: 'warning',
      extra: { calls, deleted, hashesCleared, stop },
    });
  }

  const result = { ok: true, deleted, hashesCleared, calls, stoppedEarly: stop !== null, stop };
  console.info(`[${TAG}]`, JSON.stringify(result));
  return NextResponse.json(result);
}
