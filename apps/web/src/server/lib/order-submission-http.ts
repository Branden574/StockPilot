import 'server-only';

import { NextResponse } from 'next/server';

import { ORDER_FAULT_COPY, ORDER_SIGN_IN_COPY } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/**
 * The answers of the three order submission routes (phone ordering PO-2):
 * POST /api/v1/orders, GET /api/v1/orders/submissions/{key} and POST
 * /api/v1/orders/submissions/{key}/withdraw.
 *
 * Every answer is `Cache-Control: private, no-store` (a submission's answer
 * is one person's, and never worth reusing) and names the organization it
 * was answered for, so the phone drops an answer for a workspace it has left.
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
      message: 'Too many requests. Wait a moment, then try again.',
      details: { reason: 'rate_limited' },
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
  return submissionJson({ organizationId, error, message, details }, status);
}

/** What the service threw, as the answer: a refusal with its details, or a
 *  fault (reported under `tag`). */
export function submissionError(e: unknown, organizationId: string, tag: string) {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return submissionJson(
      { organizationId, error: e.code, message: e.message, details: e.details ?? {} },
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
      details: { reason: 'failed' },
    },
    500,
  );
}
