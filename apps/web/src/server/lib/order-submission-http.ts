import 'server-only';

import { NextResponse } from 'next/server';

import { ORDER_FAULT_COPY, ORDER_RATE_LIMITED_COPY, ORDER_SIGN_IN_COPY } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/**
 * The answers of the three order submission routes (phone ordering PO-2):
 * POST /api/v1/orders, GET /api/v1/orders/submissions/{key} and POST
 * /api/v1/orders/submissions/{key}/withdraw.
 *
 * Every answer is `Cache-Control: private, no-store` (a submission's answer
 * is one person's, and never worth reusing) and names the organization it
 * was answered for, so the phone drops an answer for a workspace it has left:
 * at the top level, and inside a refusal's `details` too (the phone's
 * ApiError forwards details only; core orderCallResultForOrganization reads
 * it there, review round 1).
 * Refusals are `{ error, message, details: { reason, ... } }` with core's
 * words and the service's details; a fault is core's "couldn't be confirmed"
 * sentence with `details.reason: 'failed'` in the route's own body (the
 * phone's ApiError does not forward details for internal_error otherwise).
 * Reports carry the tag and the database error text only, never notes,
 * names or email addresses.
 */

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export function submissionJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export function submissionUnauthenticated() {
  return submissionJson(
    {
      error: 'unauthenticated',
      message: ORDER_SIGN_IN_COPY,
      details: { reason: 'unauthenticated' },
    },
    401,
  );
}

export function submissionRateLimited(resetAt: number, organizationId: string) {
  return submissionJson(
    {
      organizationId,
      error: 'rate_limited',
      // A 429 on a resend is an unknown outcome: Check and finish, never
      // "try again" (core's words).
      message: ORDER_RATE_LIMITED_COPY,
      details: { reason: 'rate_limited', organizationId },
    },
    429,
    { 'retry-after': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) },
  );
}

/** A refusal the route itself makes before the service (a body or key the
 *  route cannot read). */
export function submissionRefusal(
  organizationId: string,
  status: number,
  error: string,
  message: string,
  details: Record<string, unknown>,
) {
  return submissionJson({ organizationId, error, message, details: { ...details, organizationId } }, status);
}

/** What the service threw, as the answer: a refusal with its details, or a
 *  fault (reported under `tag`). */
export function submissionError(e: unknown, organizationId: string, tag: string) {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return submissionJson(
      {
        organizationId,
        error: e.code,
        message: e.message,
        details: { ...(e.details ?? {}), organizationId },
      },
      serviceErrorStatus(e.code),
    );
  }
  void reportError(
    e instanceof ServiceError && e.internalDetail ? new Error(e.internalDetail) : e,
    { tag, organizationId },
  );
  return submissionJson(
    {
      organizationId,
      error: 'internal_error',
      message: ORDER_FAULT_COPY,
      details: { reason: 'failed', organizationId },
    },
    500,
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account a status read or a withdraw is sent for (optional): the
 * pending record's placer. When named it must be the signed-in account, or
 * the service refuses placer_mismatch before the function runs (review round
 * 1). `{ ok: false }` when it is named but is not a uuid.
 */
export function readPlacerParam(
  raw: unknown,
): { ok: true; placerUserId: string | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, placerUserId: undefined };
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return { ok: false };
  return { ok: true, placerUserId: raw };
}
