import 'server-only';

import { NextResponse } from 'next/server';

import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { bearerTokenFrom } from '@/lib/auth/cross-site-request';
import type { ServiceContext } from '@/server/services/context';

/**
 * withApiContext for an /api/v1 GET handler: a member who must set up an
 * authenticator first reads no organization data, and is told so.
 *
 * WHO. The organization's policy requires an authenticator of the member's
 * role and the account has no verified one (core authenticatorSetUpOwed; a
 * policy that could not be read is held to the strictest). withApiContext
 * applies that rule once, in mfaFromPolicy (lib/auth/api-context.ts), and the
 * context carries the answer as its labels: required, not satisfied, not
 * enrolled. Nothing else gives that set of labels (owesAuthenticatorSetUp).
 *
 * THE ANSWER. For a GET or HEAD: 403 with `{ error: 'forbidden', message,
 * details: { reason: 'mfa_required' } }`, not stored, before the route reads
 * anything or spends a rate-limit slot. The message is core's
 * AUTHENTICATOR_SET_UP_OWED_COPY, the sentence the phone's set-up screen
 * shares. The phone and the web decide by status and `details.reason`, never
 * by the message: it is the shape the service gate (mfaGateError) already
 * gives a member who must set one up.
 *
 * EVERYONE ELSE. `{ ctx }` with exactly what withApiContext gave (the same
 * object, or null for the route's own 401), so the route answers as it does
 * with withApiContext alone; withApiContext is called as every route calls
 * it, with the request alone. A throw from it is thrown again unchanged, so a
 * context that could not be built keeps each route's own answer, and a
 * session that still owes its code keeps the 401 withApiContext gives it. A
 * write is never held by this rule: the service gates answer it.
 *
 * Shape as apiContextGate (server/lib/api-context-gate.ts): `{ response }` to
 * answer at once, or `{ ctx }`. Registered in GATE_MODULES
 * (test/route-write-handlers.ts), so the step-up and cross-site guards read
 * its routes as reaching withApiContext with their own request, and
 * src/test/authenticator-read.guard.test.ts holds every /api/v1 GET handler to
 * it (or to the returns routes' two shared gates, which give the same answer
 * through refuseSetUpOwedRead).
 */
export async function apiReadContext(
  req: Request,
): Promise<{ ctx: ServiceContext | null } | { response: NextResponse }> {
  const ctx = await withApiContext(req);
  const refused = ctx ? refuseSetUpOwedRead(req, ctx) : null;
  if (refused) return { response: refused };
  return { ctx };
}

/**
 * The answer to a read by a member who must set up an authenticator first,
 * or null for anything else (a write, or a member who owes nothing). For a
 * caller that has just built the context with withApiContext: apiReadContext
 * above and the returns routes' shared gates. One info line when it answers.
 */
export function refuseSetUpOwedRead(req: Request, ctx: ServiceContext): NextResponse | null {
  if (!isReadMethod(req.method) || !owesAuthenticatorSetUp(ctx)) return null;
  logSetUpOwedRead(req);
  return NextResponse.json(setUpOwedReadBody(), {
    status: 403,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

/** The body of that answer. A new object every call. */
export function setUpOwedReadBody() {
  return {
    error: 'forbidden',
    message: AUTHENTICATOR_SET_UP_OWED_COPY,
    details: { reason: 'mfa_required' },
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

/** GET and HEAD read; every other method can write, and the service gates answer it. */
export function isReadMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * One info line per read held for set-up, so a real person's held phone or
 * tab shows in the runtime logs. Info, not a report: a phone that is not
 * updated yet makes a few of these a minute, and that is the rule working.
 * The method, the path and which way the session came: never the query
 * string, a token, a cookie or an address.
 */
function logSetUpOwedRead(req: Request): void {
  let path = '(unreadable)';
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Keep the placeholder.
  }
  console.info(
    '[api-read-context] held a read for a member who must set up an authenticator first',
    {
      method: req.method,
      path,
      via: bearerTokenFrom(req) ? 'bearer' : 'cookie',
    },
  );
}
