import 'server-only';

import { NextResponse } from 'next/server';

import { ORDER_ITEMS_INTERNAL_COPY, ORDER_ITEMS_LOAD_FAILED_COPY } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { ORDER_ITEMS_RATE_LIMITED_COPY } from '@/server/services/order-catalog-visibility';

/**
 * The answers of the Manage order items routes (ordering visibility, 0413;
 * design 4.3): GET and POST /api/v1/orders/catalog-visibility and GET
 * /api/v1/orders/catalog-visibility/family/[groupId].
 *
 * Every answer is `Cache-Control: private, no-store` (one person's view of one
 * organization) and names the organization at the top level and inside a
 * refusal's `details` (the phone's ApiError forwards details only), so a
 * client drops an answer for a workspace it has left. Refusals are
 * `{ organizationId, error, message, details: { reason, ... } }`:
 *   401 unauthenticated        reason 'unauthenticated'
 *   400 validation_error       reason 'invalid' (details.field)
 *   403 forbidden              reason 'forbidden' | 'feature_disabled' |
 *                              'mfa_required' | 'aal2_required'
 *   403 module_disabled        reason 'module_disabled'
 *   409 conflict               reason 'items_unavailable' (details.itemIds)
 *                              | 'busy' (retryable, details.operationId)
 *   429 rate_limited           reason 'rate_limited' (retry-after header and
 *                              details.retryAfterSeconds)
 *   500 internal_error         reason 'failed', core's words, reported under
 *                              the route's tag with the database text only
 */

export const MANAGE_NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export const ORDER_ITEMS_SIGN_IN_COPY = 'Sign in again to manage order items.';

export function manageJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...MANAGE_NO_STORE, ...extra } });
}

export function manageUnauthenticated() {
  return manageJson(
    {
      error: 'unauthenticated',
      message: ORDER_ITEMS_SIGN_IN_COPY,
      details: { reason: 'unauthenticated' },
    },
    401,
  );
}

function retryAfter(seconds: number): Record<string, string> {
  return { 'retry-after': String(Math.max(1, Math.ceil(seconds))) };
}

/** A route's own rate limit (reads), in the same shape as the service's. */
export function manageRateLimited(resetAt: number, organizationId: string) {
  const seconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return manageJson(
    {
      organizationId,
      error: 'rate_limited',
      message: ORDER_ITEMS_RATE_LIMITED_COPY,
      details: { reason: 'rate_limited', retryable: true, retryAfterSeconds: seconds, organizationId },
    },
    429,
    retryAfter(seconds),
  );
}

/** A body the route could not read as JSON. */
export function manageInvalidBody(organizationId: string, message: string) {
  return manageJson(
    {
      organizationId,
      error: 'validation_error',
      message,
      details: { reason: 'invalid', field: 'body', organizationId },
    },
    400,
  );
}

/** What the service threw, as the answer. `kind` picks the fault's words. */
export function manageError(
  e: unknown,
  organizationId: string,
  tag: string,
  kind: 'read' | 'write',
) {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    const details: Record<string, unknown> = { ...(e.details ?? {}), organizationId };
    if (details.reason === 'rate_limited') {
      const seconds = Number(details.retryAfterSeconds) || 60;
      return manageJson(
        { organizationId, error: 'rate_limited', message: e.message, details },
        429,
        retryAfter(seconds),
      );
    }
    return manageJson(
      { organizationId, error: e.code, message: e.message, details },
      serviceErrorStatus(e.code),
    );
  }
  void reportError(
    e instanceof ServiceError && e.internalDetail ? new Error(e.internalDetail) : e,
    { tag, organizationId },
  );
  return manageJson(
    {
      organizationId,
      error: 'internal_error',
      message: kind === 'read' ? ORDER_ITEMS_LOAD_FAILED_COPY : ORDER_ITEMS_INTERNAL_COPY,
      details: { reason: 'failed', organizationId },
    },
    500,
  );
}
