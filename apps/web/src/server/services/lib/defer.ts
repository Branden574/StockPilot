import 'server-only';

import { after } from 'next/server';

/**
 * Run best-effort tail work (an email, a notification, a schedule sync) after
 * the response, so the serverless invocation actually STAYS ALIVE for it.
 *
 * WHAT WENT WRONG (SP-092): every notification tail in order-requests.ts was
 * spelled `void this.notifyEmail(...)` / `void this.autoScheduleFromOrder(...)`,
 * i.e. a promise still pending when the action returned and the response
 * flushed. On Vercel the runtime may freeze the instance at that moment, so
 * the approval email was never handed to Resend, the linked schedule_events
 * row was never inserted, and the schedule status sync never ran — silently,
 * with no error anywhere. Fluid compute usually keeps the instance warm, which
 * is why it mostly worked; at ~1 order/day there is frequently no other
 * in-flight request to keep it warm, which is exactly when it would not.
 * `after()` registers the work WITH the request, and the platform waits for it
 * (the same reason actions/auth.ts wraps its new-device alert).
 *
 * WHY THE try/catch: `after` throws synchronously — "`after` was called outside
 * a request scope" (next/dist/server/after/after.js) — whenever a service is
 * driven from a script, a cron worker or vitest. There is no response to
 * outlive in those contexts, so plain fire-and-forget is the correct fallback
 * rather than an exception that would fail the caller's mutation.
 *
 * WHY THE ERROR IS SWALLOWED: every caller is tail work that must never turn a
 * committed mutation into a failed request. The helpers passed in log or
 * report their own failures.
 *
 * ONE COPY, AND IT IS CALLED `defer`. order-requests.ts and rentals.ts each
 * used to carry their own copy (the rentals one named deferAfterResponse).
 * Besides the usual drift between copies (recurring pattern #26), the name
 * matters: inventory-list-invalidation.guard.test.ts finds stock writes inside
 * `after(...)` and `defer(...)` callbacks by callee name, so a wrapper under
 * any other name hides its callbacks from that check. defer.test.ts keeps
 * `after` imported only here and at the reviewed direct call sites. The
 * promise form below, keepAlive, lives here for the same reason.
 *
 * Not for work that must happen at least once: that needs a durable row a cron
 * drains (see dispatchEvent / integration-events.ts).
 */
export function defer(fn: () => Promise<unknown>): void {
  const run = () => fn().catch(() => {});
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Keep the invocation alive until `work` settles: for work that has ALREADY
 * STARTED inside the request and must not be cut off by the response.
 *
 * WHAT WENT WRONG (audit.write_failed, 2026-09-24..10-12): a `void
 * audit(...)` whose INSERT was still in flight when the route returned had
 * nothing holding the invocation, so Vercel could suspend the instance as soon
 * as the response was sent, and the next request to reach it resumed it with
 * the 5 s insert deadline long past: 33 rows that had committed were reported
 * lost (the reply was never read), and 2 Learn4Life item-create rows were
 * never sent at all.
 *
 * WHY NOT defer: defer(fn) starts `fn` only once the response has closed. An
 * audit row must be sent where the action happens (its created_at and its
 * order among the action's other rows stay as they were); only the wait is
 * moved out of the response. after() with a PROMISE, not a callback, does
 * exactly that: next/dist/server/after/after-context.js addThenable hands it
 * straight to the platform's waitUntil, which keeps the function running until
 * it settles. The response is not delayed. Inside an after() callback the
 * request's stores are still bound, so a write started there registers with
 * the same waitUntil while that callback is running.
 *
 * NEVER THROWS: after() throws outside a request scope (a script, vitest, a
 * service called outside a request) and where the host gives no waitUntil.
 * There is no response to outlive there, and the work is already running, so
 * it simply carries on as before.
 *
 * `work` should not reject (audit's writers never do). If it does, Next logs
 * "A promise passed to `after()` rejected"; outside a request the rejection
 * is the caller's, as it was before.
 *
 * Not for stock writes: a write that lands after the handler returned records
 * its cache tag too late for Next to send it (see inventory-list-cache.ts), and
 * inventory-list-invalidation.guard.test.ts treats `keepAlive(x())` as a
 * dropped promise. Not for work that must happen at least once (see defer).
 */
export function keepAlive(work: Promise<unknown>): void {
  try {
    after(work);
  } catch {
    // No request scope (or no waitUntil): nothing to outlive.
  }
}
