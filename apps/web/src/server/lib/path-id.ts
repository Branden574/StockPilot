import 'server-only';

import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';

import { isUuid } from '@stockpilot/core';

/**
 * The record id in a page's or route's path, checked before anything is read
 * with it (B63).
 *
 * A link whose id was mistyped or cut short names no record, but the services
 * filter a uuid column with it, and PostgREST answers a value that is not a
 * uuid with an error (22P02), not with an empty result. The service turned
 * that into an internal_error: the page showed "Something broke loading this
 * page" (with a crash report) and the route answered 500. Only the path is
 * checked here: a service still reports a malformed id our own code sends it.
 *
 * Every page and route keyed by a record id checks it as its first use of the
 * id (app/path-ids.guard.test.ts enforces it).
 */

/** A page's check: Page not found for an id that is not a uuid. Pages only:
 *  notFound() inside a route's try/catch becomes a 500 (recurring bug
 *  pattern 23), so routes use invalidPathIdResponse. */
export function notFoundUnlessUuid(id: string): void {
  if (!isUuid(id)) notFound();
}

/**
 * A route's check: the 400 to answer for an id that is not a uuid, or null for
 * one that is. `{ error: 'validation_error', message }`, the answer most routes
 * that check their id already give (as invalidReturnId does). It never throws.
 * `message` names the record, as in "That order id is not valid."
 */
export function invalidPathIdResponse(
  id: string,
  message: string,
  headers?: HeadersInit,
): NextResponse | null {
  if (isUuid(id)) return null;
  return NextResponse.json({ error: 'validation_error', message }, { status: 400, headers });
}
