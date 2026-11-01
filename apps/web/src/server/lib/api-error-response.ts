import 'server-only';

import { NextResponse } from 'next/server';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY } from '@stockpilot/core';

import { ForbiddenError } from '@/lib/auth/warehouse';
import { rethrowControlFlow } from '@/lib/control-flow';
import { reportError, type ErrorContext } from '@/lib/error-reporter';

/**
 * The sentence an API route answers for a failure it did not expect: the one
 * exceptions/error-response.ts, the rentals route, email-change-api.ts and the
 * server actions already answer.
 */
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/** A request body the route could not read (cut short, not JSON, not a form). */
export const UNREADABLE_REQUEST_MESSAGE = 'The request could not be read.';

/** A photo the vision model did not read, whatever its vendor said. */
export const VISION_FAILED_MESSAGE = 'The photo could not be read. Try again.';

export interface InternalErrorResponseOptions {
  /** The organization the request acted in, for the report. */
  organizationId?: string | null;
  /** The caller, for the report, where the route reported it before. */
  userIdHash?: string | null;
  /** Default 500. 502 for a vendor or Storage failure; 200 where the route answers a soft failure. */
  status?: number;
  /** The `error` code. Default 'internal_error'. */
  code?: string;
  /** The sentence: a constant the app wrote, never text taken from the error. */
  message?: string;
  headers?: HeadersInit;
  /** Other fields the route already answers. They never replace `error` or `message`. */
  body?: Record<string, unknown>;
  level?: ErrorContext['level'];
  extra?: ErrorContext['extra'];
}

/**
 * The answer to a failure an API route did not expect (S16).
 *
 * Routes used to answer `e instanceof Error ? e.message : ...` here, so the
 * caller read whatever the error said: a TypeError naming the server's
 * property paths, Postgres text naming tables, columns and row-level security
 * policies, a Storage error naming the bucket, an AI vendor's quota or billing
 * text, a failed request's URL with its token (error-reporter-core.ts redacts
 * tokens in what it logs, but an answer was never redacted). Several of those
 * branches reported nothing, so the answer was the only copy of the error.
 *
 * Now the error goes to reportError with the route's tag, and the caller gets
 * a fixed sentence with the route's status and code. No web or phone caller
 * parses `message`: they show it (the phone's api.ts shows `message`, else
 * `error`), and the phone's outbox decides by status alone.
 *
 * Next.js control flow (redirect(), notFound()) is thrown again first, for
 * Next to answer (lib/control-flow.ts), never answered or reported here.
 *
 * The guard app/api/no-raw-error-text.guard.test.ts fails an API route that
 * answers an error's own text again.
 */
export function internalErrorResponse(
  e: unknown,
  tag: string,
  opts: InternalErrorResponseOptions = {},
): NextResponse {
  rethrowControlFlow(e);
  void reportError(asError(e), reportContext(tag, opts));
  return NextResponse.json(
    {
      ...opts.body,
      error: opts.code ?? 'internal_error',
      message: opts.message ?? UNEXPECTED_ERROR_MESSAGE,
    },
    { status: opts.status ?? 500, ...(opts.headers ? { headers: opts.headers } : {}) },
  );
}

/**
 * internalErrorResponse, except for assertWarehouseAccess's refusal
 * (ForbiddenError, lib/auth/warehouse.ts), which is not a ServiceError. The
 * phone's count routes meet it through CycleCountsService.assertSessionAccess:
 *
 *   - outside the caller's warehouses: 403 with its own words (app text), as
 *     v1/cycle-counts/route.ts and v1/items/route.ts answer it. The phone's
 *     outbox treats a 403 as final (drain-failure.ts), where the 500 this
 *     used to be was sent again for ever;
 *   - the caller's own access could not be read (accessUnreadable): 503 with
 *     Retry-After and core's sentence, which claims no scope. Another try may
 *     work, and the outbox sends it again. Reported as a warning: the failed
 *     read itself is only logged (getWarehouseAccess).
 */
export function forbiddenOrInternalResponse(
  e: unknown,
  tag: string,
  opts: InternalErrorResponseOptions = {},
): NextResponse {
  if (e instanceof ForbiddenError) {
    if (e.accessUnreadable) {
      void reportError(e, reportContext(tag, { ...opts, level: 'warning' }));
      return NextResponse.json(
        { error: 'check_failed', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
    return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
  }
  return internalErrorResponse(e, tag, opts);
}

/**
 * A request body the route could not read: 400, the route's code and a fixed
 * sentence, never the parser's text (a SyntaxError quotes what it parsed).
 * Not reported: the body is the caller's, and anyone can send a broken one.
 */
export function unreadableRequestResponse(code = 'invalid_body'): NextResponse {
  return NextResponse.json({ error: code, message: UNREADABLE_REQUEST_MESSAGE }, { status: 400 });
}

/**
 * The thrown value as an Error for the report, with its text. A supabase-js
 * read returns its `error` as a plain object, and code that throws that
 * object as it is (`if (advErr) throw advErr;`) throws something whose
 * String() is "[object Object]".
 */
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return new Error(typeof message === 'string' ? message : String(e));
}

function reportContext(tag: string, opts: InternalErrorResponseOptions): ErrorContext {
  return {
    tag,
    ...(opts.organizationId !== undefined ? { organizationId: opts.organizationId } : {}),
    ...(opts.userIdHash !== undefined ? { userIdHash: opts.userIdHash } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.extra ? { extra: opts.extra } : {}),
  };
}
