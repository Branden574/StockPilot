import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
