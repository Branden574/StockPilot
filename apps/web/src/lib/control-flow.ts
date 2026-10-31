import { unstable_rethrow } from 'next/navigation';

/**
 * NEXT.JS CONTROL FLOW IS A THROWN ERROR, NOT A FAILURE.
 *
 * redirect(), permanentRedirect(), notFound(), forbidden() and unauthorized()
 * end the work by THROWING an error that carries a `digest`. The signed-out
 * path depends on it: withContext() -> requireOrgContext() answers a missing
 * session with a redirect to sign-in, a disabled account with a redirect to
 * /account-disabled and a member with no organization with a redirect to
 * /onboarding. A catch that turns that error into an ActionResult hands the
 * browser "Something went wrong" (or the bare text "NEXT_REDIRECT"), and the
 * person stays on a page that can no longer save anything.
 *
 * SERVER: call rethrowControlFlow(e) as the FIRST statement of every catch
 * whose try block can reach one of those calls, before anything is logged,
 * reported or mapped. A shared mapper (an action module's toResult) may do it
 * for its callers by making it its own first statement. The guard in
 * server/actions/action-catch.guard.test.ts fails a Server Action catch that
 * does neither.
 *
 * CLIENT: when a Server Action redirects, Next.js rejects the action's promise
 * with a redirect error it has ALREADY acted on (the router is navigating).
 * Test isControlFlow(e) first and stop, so no toast or error message is shown
 * on the way to sign-in. The toaster lives in the root layout, so a toast
 * raised there would still be on screen on the sign-in page.
 *
 * Both are Next's own unstable_rethrow (next/navigation), so which errors count
 * is Next's list, including one wrapped as another error's `cause`. Its browser
 * build checks the redirect and not-found family; its server build also the
 * render-time signals that never reach an action.
 */
export function rethrowControlFlow(error: unknown): void {
  unstable_rethrow(error);
}

/** True when `error` is Next.js control flow (see rethrowControlFlow). */
export function isControlFlow(error: unknown): boolean {
  try {
    unstable_rethrow(error);
  } catch (thrown) {
    // unstable_rethrow throws the control flow it found: `error` itself, or
    // one in its `cause` chain. Only that is an answer about `error`. Anything
    // else it throws (it was not callable, say, under a test's module mock)
    // says nothing, and `error` then counts as an ordinary failure and is
    // shown as one, never dropped in silence.
    return inCauseChain(error, thrown);
  }
  return false;
}

function inCauseChain(error: unknown, thrown: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = error; e !== null && e !== undefined && !seen.has(e);) {
    if (e === thrown) return true;
    seen.add(e);
    e = e instanceof Error ? e.cause : undefined;
  }
  return false;
}
