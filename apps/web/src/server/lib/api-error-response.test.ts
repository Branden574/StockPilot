import { notFound, redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY } from '@stockpilot/core';

import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';

import {
  forbiddenOrInternalResponse,
  internalErrorResponse,
  UNEXPECTED_ERROR_MESSAGE,
  UNREADABLE_REQUEST_MESSAGE,
  unreadableRequestResponse,
  VISION_FAILED_MESSAGE,
} from './api-error-response';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

/**
 * The answer an API route gives for a failure it did not expect (S16).
 *
 * The routes' last catch used to answer `e instanceof Error ? e.message : ...`,
 * so the caller read whatever the error said: a TypeError naming the server's
 * property paths, a library's or an AI vendor's text, a Storage error with the
 * bucket's name, Postgres text with table and policy names. Several of those
 * branches reported nothing, so that answer was the only copy of the error.
 * Now the caller gets one fixed sentence and the error itself goes to
 * reportError with the route's tag.
 */

/** What a call that ends the work by throwing actually throws. */
function thrownBy(fn: () => never): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

describe('internalErrorResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers the fixed sentence, never the error's text", async () => {
    const res = internalErrorResponse(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      'api.test.route',
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    expect(text).not.toContain('Cannot read');
    expect(UNEXPECTED_ERROR_MESSAGE).toBe('Something went wrong. Please try again.');
  });

  it("reports the raw error with the route's tag and organization", () => {
    const err = new Error('relation "cycle_count_lines" does not exist');
    internalErrorResponse(err, 'api.v1.cycle_counts.clear', { organizationId: 'org-1' });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.cycle_counts.clear',
      organizationId: 'org-1',
    });
  });

  it('passes the level, the extra fields and the user to the report, and only those', () => {
    const err = new Error('quota exceeded for model x');
    internalErrorResponse(err, 'api.test.vision', {
      organizationId: null,
      userIdHash: 'u-1',
      level: 'warning',
      extra: { code: '42501', step: 'sign' },
      status: 502,
      code: 'vision_failed',
      message: VISION_FAILED_MESSAGE,
    });
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.test.vision',
      organizationId: null,
      userIdHash: 'u-1',
      level: 'warning',
      extra: { code: '42501', step: 'sign' },
    });
  });

  it('keeps the status, code, message constant and headers the route asks for', async () => {
    const res = internalErrorResponse(
      new Error(
        '[GoogleGenerativeAI Error]: Error fetching from https://vendor.example.test/v1/models/m: [429 Too Many Requests] quota',
      ),
      'api.test.vision',
      {
        status: 502,
        code: 'vision_failed',
        message: VISION_FAILED_MESSAGE,
        headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
      },
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'vision_failed', message: VISION_FAILED_MESSAGE });
    expect(text).not.toMatch(/vendor|quota|429/);
    expect(VISION_FAILED_MESSAGE).toBe('The photo could not be read. Try again.');
  });

  it('keeps the extra fields a route already answers, and they cannot replace the code or the sentence', async () => {
    const res = internalErrorResponse(new Error('socket hang up'), 'api.test.lookup', {
      status: 200,
      code: 'lookup_failed',
      body: {
        isbn: '9780000000002',
        metadata: null,
        error: 'socket hang up',
        message: 'socket hang up',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      isbn: '9780000000002',
      metadata: null,
      error: 'lookup_failed',
      message: UNEXPECTED_ERROR_MESSAGE,
    });
  });

  // A supabase-js read returns its `error` as the parsed JSON object, not an
  // Error, and a helper that rethrows it as it is (recurring-pos.ts advErr)
  // throws that object: its message is what the report needs, not
  // "[object Object]".
  it.each([
    [
      'a thrown string',
      'permission denied for table inventory_items',
      'permission denied for table inventory_items',
    ],
    [
      'a thrown PostgREST error object',
      { message: 'new row violates row-level security policy for table "x"', code: '42501' },
      'new row violates row-level security policy for table "x"',
    ],
    ['a thrown null', null, 'null'],
  ])(
    '%s gets the same answer, and is reported as an Error with its text',
    async (_label, thrown, reportedText) => {
      const res = internalErrorResponse(thrown, 'api.test.route', { organizationId: 'org-1' });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'internal_error',
        message: UNEXPECTED_ERROR_MESSAGE,
      });
      expect(text).not.toMatch(/permission denied|row-level/);
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toBe(reportedText);
      expect(context).toEqual({ tag: 'api.test.route', organizationId: 'org-1' });
    },
  );

  it.each([
    ['redirect() to sign-in', thrownBy(() => redirect('/signin'))],
    ['notFound()', thrownBy(() => notFound())],
  ])('Next control flow (%s) is rethrown, not answered or reported', (_label, flow) => {
    let thrown: unknown = null;
    try {
      internalErrorResponse(flow, 'api.test.route');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(flow);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('forbiddenOrInternalResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a warehouse refusal is 403 with its own words, which the phone's outbox treats as final", async () => {
    const res = forbiddenOrInternalResponse(
      new ForbiddenError('You cannot modify a count that includes items with no warehouse.'),
      'api.test.route',
      { organizationId: 'org-1' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: 'You cannot modify a count that includes items with no warehouse.',
    });
    // An expected refusal, answered in full: nothing to report.
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an access check that could not be read is a 503 with Retry-After (sent again), claims no scope, and is reported', async () => {
    const err = new ForbiddenError('User does not have write access to warehouse w-1.', {
      accessUnreadable: true,
    });
    const res = forbiddenOrInternalResponse(err, 'api.test.route', { organizationId: 'org-1' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'check_failed',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
    });
    expect(text).not.toContain('w-1');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.test.route',
      organizationId: 'org-1',
      level: 'warning',
    });
  });

  it('anything else is the internal error answer', async () => {
    const err = new TypeError("Cannot read properties of null (reading 'warehouse_id')");
    const res = forbiddenOrInternalResponse(err, 'api.test.route', { organizationId: 'org-1' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.test.route',
      organizationId: 'org-1',
    });
  });

  it('Next control flow is rethrown here too', () => {
    const flow = thrownBy(() => redirect('/signin'));
    expect(() => forbiddenOrInternalResponse(flow, 'api.test.route')).toThrow();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('unreadableRequestResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 400 with the fixed sentence and the code asked for, and reports nothing', async () => {
    const res = unreadableRequestResponse();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_body',
      message: UNREADABLE_REQUEST_MESSAGE,
    });
    const named = unreadableRequestResponse('invalid_form');
    expect(await named.json()).toEqual({
      error: 'invalid_form',
      message: UNREADABLE_REQUEST_MESSAGE,
    });
    expect(UNREADABLE_REQUEST_MESSAGE).toBe('The request could not be read.');
    // A body the caller sent wrong is the caller's to fix, not ours to page on.
    expect(reportError).not.toHaveBeenCalled();
  });
});
