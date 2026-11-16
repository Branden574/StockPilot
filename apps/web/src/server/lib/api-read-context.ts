import 'server-only';

import { NextResponse } from 'next/server';

import {
  AUTHENTICATOR_SET_UP_OWED_COPY,
  CONTEXT_UNAVAILABLE_COPY,
  CONTEXT_UNAVAILABLE_REASON,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { bearerTokenFrom } from '@/lib/auth/cross-site-request';
import { mfaPolicyWasUnread } from '@/lib/auth/mfa-policy';
import type { ServiceContext } from '@/server/services/context';

/**
 * withApiContext for an API read: a member who must set up an authenticator
 * first reads no organization data, and is told so.
 *
 * WHO. The organization's policy requires an authenticator of the member's
 * role and the account has no verified one (core authenticatorSetUpOwed).
 * withApiContext applies that rule once, in mfaFromPolicy
 * (lib/auth/api-context.ts), and the context carries the answer as its
 * labels: required, not satisfied, not enrolled. Nothing else gives that set
 * of labels (owesAuthenticatorSetUp).
 *
 * WHAT IS A READ. A GET or a HEAD, whatever the route; and any method when
 * the caller says so (`kind` 'read'): a POST that only looks something up
 * (the returns routes' shared gates hand their own `kind` on, and
 * orders/signature-lookup asks for 'read').
 *
 * THE ANSWER, before the route reads anything or spends a rate-limit slot:
 *   - 403 `{ error: 'forbidden', message, details: { reason: 'mfa_required' } }`,
 *     not stored. The message is core's AUTHENTICATOR_SET_UP_OWED_COPY, the
 *     sentence the phone's set-up screen shares. The phone and the web decide
 *     by status and `details.reason`, never by the message: it is the shape
 *     the service gate (mfaGateError) already gives such a member.
 *   - When the organization's policy could not be read (withApiContext held it
 *     to the strictest one and marked the context: lib/auth/mfa-policy.ts),
 *     the labels look the same, but the sentence may be untrue. That member is
 *     told their access could not be checked: 503 `check_failed`, core's
 *     CONTEXT_UNAVAILABLE_COPY, `details: { reason: 'context_unavailable',
 *     retryable: true }`, Retry-After 5, not stored. It carries no "nothing
 *     was written" flag: the API context gate (server/lib/api-context-gate.ts)
 *     is the one place that answers with that marker, and a read needs none.
 *
 * EVERYONE ELSE. `{ ctx }` with exactly what withApiContext gave (the same
 * object, or null for the route's own 401), so the route answers as it does
 * with withApiContext alone; withApiContext is called as every route calls
 * it, with the request alone. A throw from it is thrown again unchanged, so a
 * context that could not be built keeps each route's own answer, and a
 * session that still owes its code keeps the 401 withApiContext gives it. A
 * write is never held by this rule: the service gates answer it.
 *
 * Shape as apiContextGate: `{ response }` to answer at once, or `{ ctx }`.
 * Registered in GATE_MODULES (test/route-write-handlers.ts), so the step-up
 * and cross-site guards read its routes as reaching withApiContext with their
 * own request, and src/test/authenticator-read.guard.test.ts holds every API
 * read to it (or to the returns routes' two shared gates, which give the same
 * answers through refuseSetUpOwedRead), as the handler's first awaited call.
 */
export async function apiReadContext(
  req: Request,
  kind?: 'read',
): Promise<{ ctx: ServiceContext | null } | { response: NextResponse }> {
  const ctx = await withApiContext(req);
  const refused = ctx ? refuseSetUpOwedRead(req, ctx, kind) : null;
  if (refused) return { response: refused };
  return { ctx };
}

/**
 * The answer to a read by a member who must set up an authenticator first,
 * or null for anything else (a write, or a member who owes nothing). For a
 * caller that has just built the context with withApiContext: apiReadContext
 * above and the returns routes' shared gates, which hand on their own `kind`.
 * One log line when it answers.
 */
export function refuseSetUpOwedRead(
  req: Request,
  ctx: ServiceContext,
  kind?: 'read' | 'write',
): NextResponse | null {
  if (!(isReadMethod(req.method) || kind === 'read') || !owesAuthenticatorSetUp(ctx)) return null;
  if (mfaPolicyWasUnread(ctx)) {
    logHeldRead(req, 'the authenticator policy could not be read');
    return NextResponse.json(policyUnreadBody(), {
      status: 503,
      headers: { 'Retry-After': '5', 'Cache-Control': 'private, no-store' },
    });
  }
  logHeldRead(req, 'a member who must set up an authenticator first');
  return NextResponse.json(setUpOwedReadBody(), {
    status: 403,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

/** The body of the set-up answer. A new object every call. */
export function setUpOwedReadBody() {
  return {
    error: 'forbidden',
    message: AUTHENTICATOR_SET_UP_OWED_COPY,
    details: { reason: 'mfa_required' },
  } as const;
}

/** The body of the could-not-check answer. A new object every call. */
export function policyUnreadBody() {
  return {
    error: 'check_failed',
    message: CONTEXT_UNAVAILABLE_COPY,
    details: { reason: CONTEXT_UNAVAILABLE_REASON, retryable: true },
  } as const;
}

/**
 * Does this context owe authenticator set-up? Required and not satisfied, on
 * an account with no verified authenticator. A context that does not say
 * whether the account has one counts as having none, as mfaGateError
 * (server/services/context.ts) reads it.
 */
export function owesAuthenticatorSetUp(
  ctx: Pick<ServiceContext, 'mfaRequired' | 'mfaSatisfied' | 'mfaEnrolled'>,
): boolean {
  return ctx.mfaRequired === true && ctx.mfaSatisfied !== true && ctx.mfaEnrolled !== true;
}

/** GET and HEAD read; every other method can write, unless its caller says it reads. */
export function isReadMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * One info line per held read, so a real person's held phone or tab shows in
 * the runtime logs. Info, not a report: a phone that is not updated yet makes
 * a few of these a minute, and that is the rule working. The method and which
 * way the session came: never the path (it can carry an order id, an item id
 * or a submission key), the query string, a token, a cookie or an address.
 */
function logHeldRead(req: Request, why: string): void {
  console.info(`[api-read-context] held a read: ${why}`, {
    method: req.method,
    via: bearerTokenFrom(req) ? 'bearer' : 'cookie',
  });
}
