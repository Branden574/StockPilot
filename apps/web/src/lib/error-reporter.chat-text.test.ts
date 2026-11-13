import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  incompleteRunAlert,
  runReport,
  unlinkedRequestsAlert,
  type UnlinkedEscalationRequest,
} from '@/server/services/escalation-orphans';

import { reportError } from './error-reporter';

/**
 * The operator's error channel shows a report's words as text (docket S56).
 * When ERROR_WEBHOOK_URL is a Slack or Teams incoming webhook, the report is
 * posted as chat text. That text is escaped for its channel
 * (lib/chat-text.ts): the message keeps its line breaks and its length, and
 * the digest and the stack are code their own text cannot end. A generic
 * endpoint still gets the structured payload as it is.
 */

const SLACK = 'https://hooks.slack.com/services/T/B/x';
const TEAMS = 'https://example.webhook.office.com/webhookb2/a/IncomingWebhook/b/c';
const FENCE = '```';

describe('reportError: the chat text is escaped for its channel', () => {
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

  /** The chat text of the one report posted. */
  const postedText = () => {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['text']);
    return String(body.text);
  };

  it('Slack: the message, and the same words on the stack’s first line, carry entities', async () => {
    process.env.ERROR_WEBHOOK_URL = SLACK;
    await reportError(new Error('Size <10> & <https://example.com|Open>'), {
      tag: 'client.render',
    });
    const text = postedText();
    expect(text).toContain('\nSize &lt;10&gt; &amp; &lt;https://example.com|Open&gt;');
    // The header and the template have no angle bracket of their own, so none
    // is left anywhere: not in the message, not inside the fence.
    expect(text).not.toMatch(/[<>]/);
    expect(text.split(FENCE)[1]).toContain(
      'Error: Size &lt;10&gt; &amp; &lt;https://example.com|Open&gt;',
    );
  });

  it('a message with a code fence of its own leaves exactly the two that wrap the stack', async () => {
    process.env.ERROR_WEBHOOK_URL = SLACK;
    await reportError(new Error(`before ${FENCE} after`), { tag: 't' });
    const text = postedText();
    expect(text.split(FENCE)).toHaveLength(3);
    expect(text.split(FENCE)[0]).toContain('\nbefore \u02CB\u02CB\u02CB after\n');
    expect(text.split(FENCE)[1]).toContain('Error: before \u02CB\u02CB\u02CB after');
    expect(text.endsWith(FENCE)).toBe(true);
  });

  it('a backtick in the message cannot pair with the digest’s code span', async () => {
    process.env.ERROR_WEBHOOK_URL = TEAMS;
    const err = Object.assign(new Error('a ` b'), { digest: '12345' });
    err.stack = '';
    await reportError(err, { tag: 't' });
    const text = postedText();
    expect(text.match(/`/g)).toHaveLength(2);
    expect(text.endsWith('digest: `12345`')).toBe(true);
  });

  it('a digest cannot end its code span', async () => {
    process.env.ERROR_WEBHOOK_URL = SLACK;
    const err = Object.assign(new Error('x'), { digest: 'ab`cd' });
    err.stack = '';
    await reportError(err, { tag: 't' });
    expect(postedText()).toContain('digest: `ab\u02CBcd`');
  });

  it('the tag sits on the header’s one line', async () => {
    process.env.ERROR_WEBHOOK_URL = SLACK;
    await reportError(runReport('m'), { tag: 'a.<b>\nc', level: 'warning' });
    expect(postedText().split('\n')[0]).toMatch(/^\*WARNING — a\.&lt;b&gt; c\* \(/);
  });

  it('Teams: brackets in the message get a backslash; inside the fence nothing is added', async () => {
    process.env.ERROR_WEBHOOK_URL = TEAMS;
    const err = new Error('see [x](https://example.com) & <y>');
    err.stack = 'Error: see\n    at run (node_modules/.pnpm/x_y/[redacted]/index.js:1:1)';
    await reportError(err, { tag: 't' });
    const text = postedText();
    const [before, fence] = text.split(FENCE);
    expect(before).toContain('see \\[x\\](https://example.com) &amp; &lt;y&gt;');
    expect(fence).toBe('Error: see\n    at run (node_modules/.pnpm/x_y/[redacted]/index.js:1:1)');
    expect(fence).not.toContain('\\');
  });

  it('a generic endpoint gets the structured payload, its message as it is', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://errors.internal.example/ingest';
    await reportError(new Error('Size <10> & [x]'), { tag: 't' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { message: string }).message).toBe('Size <10> & [x]');
  });

  describe('a long alert of many lines reaches the channel whole', () => {
    const requests: UnlinkedEscalationRequest[] = Array.from({ length: 30 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      organizationId: `10000000-0000-4000-8000-${String(i % 5).padStart(12, '0')}`,
      reference: `MR-2026-${String(i + 1).padStart(6, '0')}`,
      exceptionReference: `EX-${String(i + 1).padStart(6, '0')}`,
      createdAt: `2026-06-0${(i % 9) + 1}T10:00:00.000Z`,
    }));

    it.each([SLACK, TEAMS])('the unlinked requests alert, to %s', async (url) => {
      process.env.ERROR_WEBHOOK_URL = url;
      const alert = unlinkedRequestsAlert(requests);
      expect(alert).not.toBeNull();
      const message = alert!.message;
      expect(message).not.toMatch(/[&<>[\]\\]/);
      expect(message.split('\n').length).toBeGreaterThan(26);
      expect(message.length).toBeGreaterThan(2000);

      await reportError(runReport(message), { tag: 'cron.maintenance-orphan-escalations' });
      const text = postedText();
      // Verbatim: every line, each line break, the leading spaces, the length.
      expect(text.endsWith(`\n${message}`)).toBe(true);
      expect(text.split('\n').length).toBe(message.split('\n').length + 1);
    });

    it.each([SLACK, TEAMS])('the incomplete run alert, to %s', async (url) => {
      process.env.ERROR_WEBHOOK_URL = url;
      const message = incompleteRunAlert({
        capped: Array.from({ length: 4 }, (_, i) => ({
          organizationId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          candidates: 500,
          stoppedAt: '2026-06-01T10:00:00.000Z',
        })),
        notRead: ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'],
      });
      expect(message).not.toBeNull();
      expect(message!).not.toMatch(/[&<>[\]\\]/);
      await reportError(runReport(message!), { tag: 'cron.maintenance-orphan-escalations' });
      expect(postedText().endsWith(`\n${message!}`)).toBe(true);
    });
  });
});
