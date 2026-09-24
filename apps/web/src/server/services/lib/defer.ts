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
 * `after` imported only here and at the reviewed direct call sites.
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
