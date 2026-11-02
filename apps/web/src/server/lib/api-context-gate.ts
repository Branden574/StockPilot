import 'server-only';

import { NextResponse } from 'next/server';

import { contextUnavailableBody } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import type { ServiceContext } from '@/server/services/context';

/**
 * withApiContext for a route the phone may send again after a refusal that
 * came BEFORE ANY WRITE (docket S26).
 *
 * THE PROBLEM. When get_request_context() gives no usable answer,
 * withApiContext falls back to separate reads. When one of those cannot read
 * the caller's account status (AccountStatusUnavailableError, anyone) or a
 * non-owner's permission overrides (PermissionsUnavailableError, S19), it
 * refuses the request by throwing, before the route has done anything. That
 * throw escaped as the framework's bare 500, and the phone reads every 5xx on
 * these routes as "may or may not have been saved", because none of them takes
 * an idempotency key and a gateway 5xx can arrive after a commit: online it
 * said "Adjustment not confirmed" and labelled the on-hand for up to 90 s, and
 * a queued adjustment was parked in Unsent work and never sent again.
 *
 * THE ANSWER. Exactly those two refusals, matched by class, become a 503 with
 * core's contextUnavailableBody() (`check_failed`, details.reason
 * `context_unavailable`, retryable and nothingWritten), Retry-After 5 and no
 * caching. The phone reads it through core's isRefusedBeforeAnyWrite only: it
 * says nothing was saved, and a queued adjustment stays queued.
 *
 * WHY IT IS TRUE. withApiContext writes none of the request's work (its value
 * imports are pinned and read for writes, and it is run against a recording
 * client: lib/auth/api-context.read-only.guard.test.ts), and every route that
 * uses this gate calls it as its first statement (guarded in
 * api-context-gate.test.ts, which also keeps this the only place that builds
 * the body). The marker follows this step, not the error classes: the same
 * classes thrown later, by a service, may follow a write and stay that route's
 * 500.
 *
 * Anything else withApiContext throws is thrown again unchanged: an unknown
 * throw is a bug that must stay loud, and Next.js control flow stays Next's
 * (recurring pattern #23). Nothing is reported here: the loaders already
 * report both failures (`auth.permissions.read`, `auth.account-status.read`).
 *
 * Shape as returnsContext (app/api/v1/returns/http.ts): `{ response }` to
 * answer at once, or `{ ctx }`, where a null ctx is the route's own 401.
 * Registered in GATE_MODULES (test/route-write-handlers.ts), so the cookie
 * write guard reads it as a gate and checks it hands withApiContext its own
 * request.
 */
export async function apiContextGate(
  req: Request,
): Promise<{ ctx: ServiceContext | null } | { response: NextResponse }> {
  let ctx: ServiceContext | null;
  try {
    ctx = await withApiContext(req);
  } catch (e) {
    if (e instanceof PermissionsUnavailableError || e instanceof AccountStatusUnavailableError) {
      // The class only: the loader that refused has already reported the read.
      console.warn(
        '[api-context-gate] access could not be checked, refused before any work:',
        e.name,
      );
      return {
        response: NextResponse.json(contextUnavailableBody(), {
          status: 503,
          headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
        }),
      };
    }
    throw e;
  }
  return { ctx };
}
