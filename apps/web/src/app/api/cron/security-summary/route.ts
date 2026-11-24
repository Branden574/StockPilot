import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { secretsEqual } from '@/server/services/lib/system-context';

import { readSecurityAlertBaseline } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit, explicit. The baseline's one call is cut at
 * BASELINE_TIMEOUT_MS (the function cancels itself at 20 s), one busy answer
 * is asked again once, and nothing starts after RUN_DEADLINE_MS: the run
 * ends inside 60 s.
 */
export const maxDuration = 60;

// Route files export only what Next reads (route.test.ts pins these values).

const TAG = 'cron.security-summary';
/** The baseline's call, this long at most (its statement timeout is 20 s, its lock 2 s). */
const BASELINE_TIMEOUT_MS = 25_000;
/** No call starts after this long into the run. */
const RUN_DEADLINE_MS = 50_000;
/** The wait before a busy call (55P03) is asked once more. */
const BUSY_RETRY_MS = 1_000;
/** A call is not started with less time than this left. */
const MIN_CALL_MS = 1_000;
/** The report's own limit: a reporter that hangs never holds the run. */
const REPORT_MAX_MS = 4_000;

const FN = 'platform_security_alert_baseline';

type Outcome =
  { kind: 'answer'; data: unknown } | { kind: 'failed'; code: string; timedOut: boolean };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A database error's code, as a short code only; never its text. */
function codeOf(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : 'no_code';
}

/** One report, bounded in time. Never throws. */
async function report(
  message: string,
  level: 'error' | 'warning',
  extra: Record<string, string | number>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(reportError(new Error(message), { tag: TAG, level, extra })).catch(
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REPORT_MAX_MS);
      }),
    ]);
  } catch {
    // The reporter itself failed: the log line below still says what happened.
  } finally {
    clearTimeout(timer);
  }
}

/** One call of the baseline, with its own time limit. Never throws. */
async function callBaseline(ms: number): Promise<Outcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('late');
    }, ms);
  });
  try {
    const work = Promise.resolve(
      createAdminClient().rpc('platform_security_alert_baseline').abortSignal(controller.signal),
    ).then((r) => r as { data: unknown; error: unknown });
    work.catch(() => undefined);
    const answer = await Promise.race([work, late]);
    if (answer === 'late') return { kind: 'failed', code: 'timeout', timedOut: true };
    if (answer.error) return { kind: 'failed', code: codeOf(answer.error), timedOut: false };
    return { kind: 'answer', data: answer.data };
  } catch (e) {
    return controller.signal.aborted
      ? { kind: 'failed', code: 'timeout', timedOut: true }
      : { kind: 'failed', code: codeOf(e), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE DAILY SECURITY SUMMARY'S JOB, at 15:00 UTC (vercel.json). In release 4a
 * (record only) it ONLY computes and stores the spike rule's baseline
 * through platform_security_alert_baseline() (migration 0480: the 99th
 * percentile of the last 7 days' 10-minute buckets, in events and distinct
 * sources; refused computed_recently under 6 hours after the last), and
 * writes its own line to the log. It SENDS NOTHING: no summary, no email, no
 * push (release 4b adds the summary itself).
 *
 * A baseline that could not be computed (the function missing, a timeout,
 * the database's own cancel, a refused state, a week too full to read, an
 * answer this build does not know) is reported once, as a warning (no_state,
 * a deployment problem, as an error), with its code or word only, and
 * answered 500; the alert job keeps the spike rule held while there is no
 * baseline. computed_recently is an answer, not a failure.
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

  const started = Date.now();
  const left = () => started + RUN_DEADLINE_MS - Date.now();
  let calls = 0;
  let outcome: Outcome = { kind: 'failed', code: 'not_called', timedOut: false };
  try {
    for (;;) {
      if (left() < MIN_CALL_MS) break;
      calls += 1;
      outcome = await callBaseline(Math.min(BASELINE_TIMEOUT_MS, left()));
      if (outcome.kind === 'failed' && outcome.code === '55P03' && calls === 1) {
        await pause(BUSY_RETRY_MS);
        continue;
      }
      break;
    }
  } catch (e) {
    outcome = { kind: 'failed', code: codeOf(e), timedOut: false };
  }

  let line: Record<string, string | number | boolean>;
  let ok = false;
  if (outcome.kind === 'failed') {
    line = { baseline: 'failed', code: outcome.code, calls };
    await report(
      `The security alerts' baseline could not be computed (${outcome.code})`,
      'warning',
      {
        code: outcome.code,
        calls,
      },
    );
  } else {
    const read = readSecurityAlertBaseline(outcome.data);
    if (!read.ok) {
      line = { baseline: 'unreadable', calls };
      await report(`${FN} answered a shape this build does not know (${read.where})`, 'warning', {
        where: read.where.slice(0, 80),
        calls,
      });
    } else if (read.refused === 'computed_recently') {
      ok = true;
      line = { baseline: 'computed_recently', calls };
    } else if (read.refused !== null) {
      line = { baseline: 'refused', refused: read.refused, calls };
      await report(
        `The security alerts' baseline was refused (${read.refused})`,
        read.refused === 'no_state' ? 'error' : 'warning',
        { refused: read.refused, calls },
      );
    } else {
      ok = true;
      line = {
        baseline: 'computed',
        eventHigh: read.value.eventHigh,
        sourceHigh: read.value.sourceHigh,
        buckets: read.value.buckets,
        shortened: read.value.shortened,
        calls,
      };
    }
  }
  // The job's own line: what it did, and that it sent nothing.
  console.info(`[${TAG}]`, JSON.stringify({ sent: 'nothing', ...line }));
  return ok
    ? NextResponse.json({ ok: true, sent: 'nothing', ...line })
    : NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
