import 'server-only';

import { defer } from './defer';

/**
 * Why an exception sync was asked for. Travels into the error report so a
 * failing trigger can be told apart from the others.
 */
export type ExceptionSyncReason = 'cron' | 'cycle_count.post' | 'cycle_count.cancel' | 'check_now';

/**
 * Schedule an Exception Center sync for one org, to run after the response
 * (defer → after()), and return at once. FORCED by default: a posted or
 * cancelled count must be re-checked even if a sync ran seconds earlier.
 * "Check now" passes `force: false`, so a sync that landed between the click
 * and this task (the cron, a posted count) makes it a no-op.
 *
 * ═══ THE CALLER NEVER WAITS ═══
 *
 * Owner decision (F1 Q9): freshness must not slow a page or the system down.
 * So nothing a person does waits for a sync: posting or cancelling a count
 * schedules one here, the request returns, and the sync runs in the
 * invocation's after() window (or, outside a request — a script, a test — as
 * plain fire-and-forget; see defer.ts). A sync failure is reported by
 * syncOrg itself and never reaches the caller.
 *
 * ═══ WHY A DYNAMIC IMPORT ═══
 *
 * CycleCountsService calls this, and exception-occurrences.ts (which holds
 * syncOrg) calls it too for "Check now". A static import here would make the
 * two service modules import each other; loading syncOrg only when the
 * deferred task runs keeps the graph acyclic and keeps the evaluator and the
 * admin client out of every module that merely schedules.
 *
 * Tests: src/test/setup.ts replaces this module with a no-op vi.fn (like the
 * audit and list-cache tails), so a service test that posts a count does not
 * start a real background sync. exception-sync-schedule.test.ts tests the
 * real one.
 */
export function scheduleExceptionSync(
  orgId: string,
  reason: ExceptionSyncReason,
  opts: { force?: boolean } = {},
): void {
  const force = opts.force ?? true;
  defer(async () => {
    const { ExceptionOccurrencesService } = await import('../exception-occurrences');
    await ExceptionOccurrencesService.syncOrg(orgId, { force, reason });
  });
}
