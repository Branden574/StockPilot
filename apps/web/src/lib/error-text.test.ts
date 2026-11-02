import { describe, expect, it } from 'vitest';

import { ServiceError } from '@/server/services/context';
import { realSupabaseClient } from '@/test/postgrest-answers';

import { asReportableError, NO_MESSAGE_TEXT, nonErrorText, reportedMessage } from './error-text';

/**
 * The text an error report carries for a value that is not an Error (docket
 * C21). supabase-js hands back a failed call's `error` as a plain object, and
 * the reporter used to write it as String(value): "[object Object]", with the
 * database's message and code gone. The rule keeps the message, a code, a hint
 * and, for a request that got no answer, the first "Caused by:" line; never a
 * server error's `details`, which can quote row values.
 *
 * Shapes marked "real" are built by supabase-js's own postgrest-js from a
 * local answer, so they are the library's, not a guess.
 */

/** What the real client hands back when its request gets no HTTP answer. */
async function noAnswer(thrown: unknown): Promise<unknown> {
  const client = realSupabaseClient(() => {
    throw thrown;
  });
  // rpc is a POST, which postgrest-js never retries, so no retry waits.
  const { error } = await client.rpc('confirm_order_signature', {});
  return error;
}

const fetchFailed = (cause: Error) => new TypeError('fetch failed', { cause });

describe('nonErrorText: a database refusal keeps its message and code', () => {
  it.each([
    [
      'a refusal with a code and no hint',
      {
        message: 'permission denied for function confirm_order_signature',
        code: '42501',
        details: null,
        hint: null,
      },
      'permission denied for function confirm_order_signature (code 42501)',
    ],
    [
      'a raised refusal with a token hint',
      { message: 'order_item_hidden', code: 'P0001', details: null, hint: 'order_item_hidden' },
      'order_item_hidden (code P0001; hint: order_item_hidden)',
    ],
    [
      "PostgREST's missing-function answer with its sentence hint",
      {
        code: 'PGRST202',
        details:
          'Searched for the function public.place_order with parameter p_lines, but no matches were found in the schema cache.',
        hint: 'Perhaps you meant to call the function public.place_order_v2',
        message: 'Could not find the function public.place_order(p_lines) in the schema cache',
      },
      'Could not find the function public.place_order(p_lines) in the schema cache (code PGRST202; hint: Perhaps you meant to call the function public.place_order_v2)',
    ],
    [
      'a refusal whose details name the failing value: details are left out',
      {
        message: 'canceling statement due to statement timeout',
        code: '57014',
        details: 'while locking tuple (0,1) in relation "inventory_items"',
        hint: null,
      },
      'canceling statement due to statement timeout (code 57014)',
    ],
    ['an empty body (a gateway 502)', { message: '' }, '(empty error message)'],
    ['a message with spaces around it', { message: '  timeout  ' }, 'timeout'],
    ['a code that is not a code', { message: 'm', code: 'not a code!' }, 'm'],
    ['a code that is not a string', { message: 'm', code: 500 }, 'm'],
    ['a hint of only spaces', { message: 'm', hint: '   ' }, 'm'],
  ])('%s', (_label, value, expected) => {
    expect(nonErrorText(value)).toBe(expected);
  });

  it('cuts a long message to 500 characters and keeps the code after it', () => {
    expect(nonErrorText({ message: 'x'.repeat(10_000) })).toBe(`${'x'.repeat(500)}…`);
    expect(nonErrorText({ message: 'x'.repeat(10_000), code: '57014' })).toBe(
      `${'x'.repeat(500)}… (code 57014)`,
    );
  });

  it('cuts a long hint to 200 characters', () => {
    expect(nonErrorText({ message: 'm', code: 'P0001', hint: 'h'.repeat(1_000) })).toBe(
      `m (code P0001; hint: ${'h'.repeat(200)}…)`,
    );
  });
});

describe('nonErrorText: a request that got no answer (real postgrest-js shapes)', () => {
  it('a host lookup that failed keeps the cause line', async () => {
    const error = await noAnswer(
      fetchFailed(
        Object.assign(new Error('getaddrinfo ENOTFOUND supabase.example.test'), {
          code: 'ENOTFOUND',
        }),
      ),
    );
    expect(error).not.toBeInstanceOf(Error);
    expect(nonErrorText(error)).toBe(
      'TypeError: fetch failed (cause: Error: getaddrinfo ENOTFOUND supabase.example.test (ENOTFOUND))',
    );
  });

  it('a reset connection keeps the cause line, and never the cause stack', async () => {
    const error = await noAnswer(
      fetchFailed(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
    );
    // The library put the cause's stack into details, under the cause line.
    expect((error as { details: string }).details).toMatch(/\n {4}at /);
    const text = nonErrorText(error);
    expect(text).toBe('TypeError: fetch failed (cause: Error: read ECONNRESET (ECONNRESET))');
    expect(text).not.toContain('    at ');
  });

  it("an answer whose headers were too large keeps the library's hint and the cause", async () => {
    const error = await noAnswer(
      fetchFailed(
        Object.assign(new Error('Headers Overflow Error'), {
          name: 'HeadersOverflowError',
          code: 'UND_ERR_HEADERS_OVERFLOW',
        }),
      ),
    );
    expect(nonErrorText(error)).toBe(
      'TypeError: fetch failed (hint: HTTP headers exceeded server limits (typically 16KB); cause: HeadersOverflowError: Headers Overflow Error (UND_ERR_HEADERS_OVERFLOW))',
    );
  });

  it("an aborted request keeps the library's hint and has no cause", async () => {
    const error = await noAnswer(new DOMException('This operation was aborted', 'AbortError'));
    expect(nonErrorText(error)).toBe(
      'AbortError: This operation was aborted (hint: Request was aborted (timeout or manual cancellation))',
    );
  });
});

describe('nonErrorText: other values', () => {
  it('an object with no message names its keys, at most ten', () => {
    expect(nonErrorText({ status: 500 })).toBe(`${NO_MESSAGE_TEXT} (keys: status)`);
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    expect(nonErrorText(many)).toBe(
      `${NO_MESSAGE_TEXT} (keys: k0, k1, k2, k3, k4, k5, k6, k7, k8, k9)`,
    );
    expect(nonErrorText({})).toBe(NO_MESSAGE_TEXT);
  });

  it('an object with no prototype, whose String() throws, still gets a text', () => {
    expect(() => String(Object.create(null))).toThrow(TypeError);
    expect(nonErrorText(Object.create(null))).toBe(NO_MESSAGE_TEXT);
    expect(nonErrorText(Object.assign(Object.create(null), { status: 500 }))).toBe(
      `${NO_MESSAGE_TEXT} (keys: status)`,
    );
  });

  it('an object that throws when its message is read still gets a text', () => {
    const hostile = {
      get message(): string {
        throw new Error('no reading');
      },
    };
    expect(nonErrorText(hostile)).toBe(NO_MESSAGE_TEXT);
  });

  it('an object with its own text keeps it', () => {
    expect(nonErrorText({ toString: () => 'lock not available' })).toBe('lock not available');
  });

  it.each([
    ['a string', 'boom', 'boom'],
    ['an empty string', '', ''],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a number', 42, '42'],
  ])('%s gives its String()', (_label, value, expected) => {
    expect(nonErrorText(value)).toBe(expected);
  });
});

describe('asReportableError', () => {
  it('returns an Error as it is', () => {
    const err = new RangeError('out of range');
    expect(asReportableError(err)).toBe(err);
  });

  it("builds an Error from anything else, with the rule's text", () => {
    const made = asReportableError({ message: 'deadlock detected', code: '40P01' });
    expect(made).toBeInstanceOf(Error);
    expect(made.message).toBe('deadlock detected (code 40P01)');
    expect(made.stack).toMatch(/^Error: deadlock detected \(code 40P01\)/);
  });
});

/**
 * A ServiceError('internal_error') says only "An internal error occurred.
 * Please try again." to its caller and keeps the database's text in
 * `internalDetail`, for the server's logs (S13). Reported as it is, the alert
 * said only that sentence.
 */
describe('reportedMessage', () => {
  it('an internal error reports its internal detail, any other error its message', () => {
    const internal = new ServiceError(
      'internal_error',
      'canceling statement due to statement timeout',
    );
    expect(internal.message).toBe('An internal error occurred. Please try again.');
    expect(reportedMessage(internal)).toBe('canceling statement due to statement timeout');
    expect(reportedMessage(new ServiceError('forbidden', 'No access.'))).toBe('No access.');
    expect(reportedMessage(new Error('plain'))).toBe('plain');
    // An internal error built with no text of its own keeps the sentence.
    expect(reportedMessage(new ServiceError('internal_error', ''))).toBe(
      'An internal error occurred. Please try again.',
    );
  });

  it('cuts a long internal detail to 500 characters', () => {
    expect(reportedMessage(new ServiceError('internal_error', 'd'.repeat(2_000)))).toBe(
      `${'d'.repeat(500)}…`,
    );
  });

  it('a credential in the internal detail is redacted before the cut', () => {
    const token = 'a3f9c1d20b7e4856f10c9d2e3b4a5f6708192a3b4c5d6e7f8091a2b3c4d5e6f7';
    const lead = `${'x'.repeat(478)} /orders/sign/`;
    const text = reportedMessage(new ServiceError('internal_error', `${lead}${token} failed`));
    expect(text).not.toContain(token.slice(0, 8));
  });
});
