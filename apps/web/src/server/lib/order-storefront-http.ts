import 'server-only';

import { NextResponse } from 'next/server';

import {
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/**
 * The answers of the phone storefront's three read routes (phone ordering
 * PO-3): GET /api/v1/orders/storefront, /catalog and /catalog/photos.
 *
 * Every answer is `Cache-Control: private, no-store` (one person's view of one
 * organization) and names the organization it was answered for, at the top
 * level and inside a refusal's `details` (the phone's ApiError forwards
 * details only), so the phone drops an answer for a workspace it has left.
 * Refusals are `{ organizationId, error, message, details: { reason, ... } }`
 * in core's words. A fault is core's read-failed sentence with
 * `details.reason: 'failed'` in the route's own body (the phone's ApiError
 * does not forward details for internal_error otherwise), reported under the
 * route's tag with the database error text only: never a name, an email
 * address or a note.
 *
 * The kill switch (ORDERS_PHONE_STOREFRONT=off) answers 503 with
 * `details.reason: 'turned_off'` and core's "turned off" sentence on the
 * catalog and photo routes; the storefront route answers `enabled: false`.
 */

export const STOREFRONT_NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export function storefrontJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...STOREFRONT_NO_STORE, ...extra } });
}

export function storefrontUnauthenticated() {
  return storefrontJson(
    {
      error: 'unauthenticated',
      message: ORDER_STOREFRONT_SIGN_IN_COPY,
      details: { reason: 'unauthenticated' },
    },
    401,
  );
}

export function storefrontRateLimited(resetAt: number, organizationId: string) {
  return storefrontJson(
    {
      organizationId,
      error: 'rate_limited',
      message: ORDER_STOREFRONT_RATE_LIMITED_COPY,
      details: { reason: 'rate_limited', organizationId },
    },
    429,
    { 'retry-after': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) },
  );
}

/** What the service threw, as the answer: a refusal with its details, the
 *  switch's 503, or a fault (reported under `tag`). */
export function storefrontError(e: unknown, organizationId: string, tag: string) {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    const turnedOff = e.details?.reason === 'turned_off';
    return storefrontJson(
      {
        organizationId,
        error: turnedOff ? 'unavailable' : e.code,
        message: e.message,
        details: { ...(e.details ?? {}), organizationId },
      },
      turnedOff ? 503 : serviceErrorStatus(e.code),
    );
  }
  void reportError(
    e instanceof ServiceError && e.internalDetail ? new Error(e.internalDetail) : e,
    { tag, organizationId },
  );
  return storefrontJson(
    {
      organizationId,
      error: 'internal_error',
      message: ORDER_STOREFRONT_LOAD_FAILED_COPY,
      details: { reason: 'failed', organizationId },
    },
    500,
  );
}
