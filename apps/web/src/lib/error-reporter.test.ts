import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { json, realSupabaseClient } from '@/test/postgrest-answers';

import { isNextControlFlowError, reportError } from './error-reporter';

describe('reportError webhook formatting', () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ERROR_WEBHOOK_URL;
  });

  it('does not POST when no webhook is configured', async () => {
    await reportError(new Error('boom'), { tag: 't' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends Slack-shaped {text} to a Slack incoming webhook', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    await reportError(new Error('db exploded'), { tag: 'orders.load', level: 'error' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Slack rejects unknown top-level fields — text only.
    expect(Object.keys(body)).toEqual(['text']);
    expect(body.text).toContain('orders.load');
    expect(body.text).toContain('db exploded');
  });

  it('sends the full structured payload to a generic endpoint', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    await reportError(new Error('boom'), { tag: 'x', organizationId: 'org-1' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.app).toBe('stockpilot-web');
    expect(body.tag).toBe('x');
    expect(body.message).toBe('boom');
    expect((body.extra as Record<string, unknown>).organizationId).toBe('org-1');
  });

  it('never posts or console.errors Next control-flow throws (redirect/notFound)', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const redirectErr = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/signin;307;',
    });
    const notFoundErr = Object.assign(new Error('NEXT_NOT_FOUND'), {
      digest: 'NEXT_NOT_FOUND',
    });
    await reportError(redirectErr, { tag: 'inventory.export-csv' });
    await reportError(notFoundErr, { tag: 'audit.write_failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    // still traceable via a quiet log line
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('still reports ordinary errors that merely mention NEXT_REDIRECT in the message', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    await reportError(new Error('proxy returned NEXT_REDIRECT text'), { tag: 'x' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * A failed supabase-js call hands back its `error` as a plain object, not an
 * Error, and about twenty report sites pass it in as it is (docket C21). The
 * report used to read "[object Object]", with a stack starting "Error:
 * [object Object]": the database's reason and code were gone.
 */
describe('reportError with a value that is not an Error', () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const REFUSAL = {
    message: 'permission denied for function confirm_order_signature',
    code: '42501',
    details: null,
    hint: null,
  };
  const REFUSAL_TEXT = 'permission denied for function confirm_order_signature (code 42501)';

  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ERROR_WEBHOOK_URL;
  });

  const postedBody = () => {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return String(init.body);
  };

  it("a generic webhook gets the database's message and code, in the message and the stack", async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    await reportError(REFUSAL, { tag: 'orders.sign.rpc' });
    const raw = postedBody();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.message).toBe(REFUSAL_TEXT);
    expect(String(body.stack)).toMatch(new RegExp(`^Error: ${escapeRegExp(REFUSAL_TEXT)}`));
    expect(raw).not.toContain('[object Object]');
  });

  it("a Slack webhook's text carries it", async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    await reportError(REFUSAL, { tag: 'orders.sign.rpc' });
    const body = JSON.parse(postedBody()) as { text: string };
    expect(body.text).toContain(REFUSAL_TEXT);
    expect(body.text).not.toContain('[object Object]');
  });

  it('the log line carries it when no webhook is set', async () => {
    await reportError(REFUSAL, { tag: 'orders.sign.rpc' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [line, message] = vi.mocked(console.error).mock.calls[0]!;
    expect(line).toBe('[error] orders.sign.rpc');
    expect(message).toBe(REFUSAL_TEXT);
  });

  it("a refusal from the real client: the report carries the database's message and code", async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    const client = realSupabaseClient(() => json(REFUSAL, 403));
    const { error } = await client.rpc('confirm_order_signature', {});
    expect(error).not.toBeInstanceOf(Error);
    await reportError(error, { tag: 'orders.sign.rpc' });
    expect((JSON.parse(postedBody()) as { message: string }).message).toBe(REFUSAL_TEXT);
  });

  it('a request that got no answer, from the real client: the report carries the cause line and not its stack', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    const client = realSupabaseClient(() => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND supabase.example.test'), {
          code: 'ENOTFOUND',
        }),
      });
    });
    // rpc is a POST, which postgrest-js never retries, so no retry waits.
    const { error } = await client.rpc('confirm_order_signature', {});
    await reportError(error, { tag: 'orders.sign.rpc' });
    const body = JSON.parse(postedBody()) as { message: string; stack: string };
    expect(body.message).toBe(
      'TypeError: fetch failed (cause: Error: getaddrinfo ENOTFOUND supabase.example.test (ENOTFOUND))',
    );
    expect(body.message).not.toContain('    at ');
  });

  it('an object whose String() throws is still reported, and the report never throws', async () => {
    await expect(reportError(Object.create(null), { tag: 't' })).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls[0]![1]).toBe('Non-Error object with no message');
  });

  // A ServiceError('internal_error') keeps the database's text in
  // internalDetail ("for logging", S13) and says only a fixed sentence: the
  // report carries the text, and the stack keeps the throw site.
  it("an internal error reports its internal detail, and its stack keeps the throw site's sentence", async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    const internal = Object.assign(new Error('An internal error occurred. Please try again.'), {
      name: 'ServiceError',
      internalDetail: 'canceling statement due to statement timeout',
    });
    await reportError(internal, { tag: 'verification.location' });
    const body = JSON.parse(postedBody()) as { message: string; stack: string };
    expect(body.message).toBe('canceling statement due to statement timeout');
    expect(body.stack).toContain('An internal error occurred');
  });
});

/**
 * The server log line follows the report's level. The hosting log viewer files
 * a console.error line as an error, so only error-level reports use it: a
 * warning goes to console.warn, an info report to console.info, and anything
 * else to console.error, each with its own level as the prefix. The message,
 * stack and extra that follow it, and the webhook body, stay the same.
 */
describe('reportError log line by level', () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  let spies: Record<'error' | 'warn' | 'info', MockInstance<typeof console.error>>;

  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    spies = {
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ERROR_WEBHOOK_URL;
  });

  // 'fatal' is not in ErrorContext's level type; an untyped caller could still
  // pass it, and it stays an error line under its own name.
  it.each([
    [undefined, 'error', '[error]'],
    ['error', 'error', '[error]'],
    ['fatal', 'error', '[fatal]'],
    ['warning', 'warn', '[warning]'],
    ['info', 'info', '[info]'],
  ] as const)(
    'level %s logs through console.%s with the %s prefix',
    async (level, method, prefix) => {
      const context = {
        tag: 'shelf.recount',
        extra: { shelf: 'B-7' },
        ...(level ? { level: level as 'error' | 'warning' | 'info' } : {}),
      };
      await reportError(new Error('count did not save'), context);

      expect(spies[method]).toHaveBeenCalledTimes(1);
      const [line, message, stack, extra] = spies[method].mock.calls[0]!;
      expect(line).toBe(`${prefix} shelf.recount`);
      expect(message).toBe('count did not save');
      expect(String(stack)).toMatch(/^Error: count did not save/);
      expect(extra).toEqual({ organizationId: null, userIdHash: null, shelf: 'B-7' });
      for (const other of ['error', 'warn', 'info'] as const) {
        if (other !== method) expect(spies[other]).not.toHaveBeenCalled();
      }
    },
  );

  it('a warning still reaches the webhook, and its Slack header names the level', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    await reportError(new Error('count did not save'), { tag: 'shelf.recount', level: 'warning' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(body.text.split('\n')[0]).toMatch(/^\*WARNING — shelf\.recount\* \(\w+\)$/);
    expect(body.text).toContain('count did not save');
  });

  it('an info report sends the same structured payload to a generic endpoint', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    await reportError(new Error('count did not save'), { tag: 'shelf.recount', level: 'info' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.level).toBe('info');
    expect(body.tag).toBe('shelf.recount');
    expect(body.message).toBe('count did not save');
  });

  it('a webhook post that fails is still logged through console.error', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    await reportError(new Error('count did not save'), { tag: 'shelf.recount', level: 'warning' });
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.error.mock.calls[0]![0]).toBe('[error-reporter] webhook post failed');
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('isNextControlFlowError', () => {
  it.each([
    ['NEXT_REDIRECT;push;/signin;307;Error: NEXT_REDIRECT', true],
    ['NEXT_NOT_FOUND', true],
    ['NEXT_HTTP_ERROR_FALLBACK;404', true],
    ['BAILOUT_TO_CLIENT_SIDE_RENDERING', true],
    ['1234567890', false],
  ])('digest %s → %s', (digest, expected) => {
    expect(isNextControlFlowError(Object.assign(new Error('e'), { digest }))).toBe(expected);
  });

  it('handles non-error values and missing digests', () => {
    expect(isNextControlFlowError(null)).toBe(false);
    expect(isNextControlFlowError('string error')).toBe(false);
    expect(isNextControlFlowError(new Error('plain'))).toBe(false);
  });
});
