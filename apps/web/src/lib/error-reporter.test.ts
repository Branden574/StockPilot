import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from './error-reporter';

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
});
