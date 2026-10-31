import 'server-only';

import { keepAlive } from '@/server/services/lib/defer';

import { reportError as sendReport, type ErrorContext } from './error-reporter-core';

export { isNextControlFlowError, type ErrorContext } from './error-reporter-core';

/**
 * Reports an error from server code: console.error always, and a POST to
 * ERROR_WEBHOOK_URL when one is set (error-reporter-core.ts). Never throws.
 *
 * KEPT ALIVE PAST THE RESPONSE. Most callers do not wait (`void
 * reportError(...)` at 387 call sites on 2026-10-24), usually just before a
 * route or action answers. The POST starts here, as it always did, and is
 * handed to after() (lib/defer.ts keepAlive), so the platform keeps the
 * invocation running until it has answered (at most its 2 s timeout). Without
 * that, Vercel could suspend the instance as soon as the response was sent,
 * with the POST in flight: the alert was lost, or failed with a TimeoutError
 * when a later request resumed the instance (the same failure #352 fixed for
 * audit rows and their loss reports). The response is not delayed, and the
 * returned promise is the same report, so a caller that awaits sees no
 * change. Outside a request (a script, vitest) keepAlive does nothing and the
 * report runs as before.
 *
 * Server-only. A module a browser bundle reaches imports
 * `@/lib/error-reporter-core` instead (see its header).
 */
export function reportError(err: unknown, context: ErrorContext): Promise<void> {
  const report = sendReport(err, context);
  keepAlive(report);
  return report;
}
