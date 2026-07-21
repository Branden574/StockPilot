import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sendEmail transport contract. The es email system (E1) added optional
 * `from` / `replyTo` on top of the existing `headers` support — this
 * suite pins full back-compat for the 14 pre-existing call sites (which
 * pass none of the new options) plus the new plumb-through:
 *  - default from stays env.RESEND_FROM_EMAIL,
 *  - the default Reply-To header (deliverability signal) still appears
 *    when no replyTo/header is given, and still yields to a
 *    caller-supplied Reply-To header (support-tickets relied on the
 *    default; order emails pass List-Unsubscribe headers untouched),
 *  - explicit `replyTo` becomes Resend's reply_to field and suppresses
 *    the injected default header,
 *  - custom `from` addresses (the es registry senders) are forwarded and
 *    drive the Reply-To default.
 */

const envState = vi.hoisted(() => ({
  RESEND_API_KEY: 'test-key' as string | undefined,
  RESEND_FROM_EMAIL: 'StockPilot <hello@stockpilotusa.com>',
}));
vi.mock('@/lib/env', () => ({ env: envState }));

import { sendEmail } from './resend';

interface CapturedBody {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  reply_to?: string | string[];
  attachments?: { filename: string; content: string }[];
  headers?: Record<string, string>;
}

const fetchMock = vi.fn();

function lastBody(): CapturedBody {
  const call = fetchMock.mock.calls.at(-1)!;
  return JSON.parse((call[1] as { body: string }).body) as CapturedBody;
}

beforeEach(() => {
  envState.RESEND_API_KEY = 'test-key';
  fetchMock.mockReset();
  // Fresh Response per call — a shared one would throw "Body is
  // unusable" on the second json() read within a test.
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ id: 'email-id-1' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = { to: 'user@example.com', subject: 'Hi', html: '<p>hi</p>' };

describe('sendEmail — back-compat (legacy call shape)', () => {
  it('dry-runs without RESEND_API_KEY and never touches the network', async () => {
    envState.RESEND_API_KEY = undefined;
    const res = await sendEmail(BASE);
    expect(res).toEqual({ ok: true, id: 'dryrun' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends from RESEND_FROM_EMAIL with the default Reply-To header', async () => {
    const res = await sendEmail(BASE);
    expect(res).toEqual({ ok: true, id: 'email-id-1' });
    const body = lastBody();
    expect(body.from).toBe('StockPilot <hello@stockpilotusa.com>');
    expect(body.headers).toEqual({ 'Reply-To': 'hello@stockpilotusa.com' });
    expect(body.reply_to).toBeUndefined();
  });

  it('keeps caller headers (List-Unsubscribe) and yields the default to a caller Reply-To', async () => {
    await sendEmail({
      ...BASE,
      headers: {
        'List-Unsubscribe': '<https://app/unsub>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    expect(lastBody().headers).toEqual({
      'List-Unsubscribe': '<https://app/unsub>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Reply-To': 'hello@stockpilotusa.com',
    });

    await sendEmail({ ...BASE, headers: { 'Reply-To': 'custom@stockpilotusa.com' } });
    expect(lastBody().headers).toEqual({ 'Reply-To': 'custom@stockpilotusa.com' });
  });

  it('forwards attachments and array recipients unchanged', async () => {
    await sendEmail({
      ...BASE,
      to: ['a@x.com', 'b@x.com'],
      attachments: [{ filename: 'receipt.pdf', content: 'QUJD' }],
    });
    const body = lastBody();
    expect(body.to).toEqual(['a@x.com', 'b@x.com']);
    expect(body.attachments).toEqual([{ filename: 'receipt.pdf', content: 'QUJD' }]);
  });

  it('returns ok:false on a Resend error without throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 422 }));
    const res = await sendEmail(BASE);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('nope');
  });
});

describe('sendEmail — es extensions', () => {
  it('honors a custom from and derives the Reply-To default from it', async () => {
    await sendEmail({
      ...BASE,
      from: 'StockPilot Security <security@stockpilotusa.com>',
    });
    const body = lastBody();
    expect(body.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(body.headers).toEqual({ 'Reply-To': 'security@stockpilotusa.com' });
  });

  it('sends replyTo as reply_to and suppresses the injected default header', async () => {
    await sendEmail({
      ...BASE,
      from: 'StockPilot Support <tickets@stockpilotusa.com>',
      replyTo: 'customer@meridiansupply.example',
    });
    const body = lastBody();
    expect(body.reply_to).toBe('customer@meridiansupply.example');
    expect(body.headers).toBeUndefined();
  });

  it('replyTo coexists with caller headers untouched', async () => {
    await sendEmail({
      ...BASE,
      replyTo: ['ops@stockpilotusa.com'],
      headers: { 'List-Unsubscribe': '<https://app/unsub>' },
    });
    const body = lastBody();
    expect(body.reply_to).toEqual(['ops@stockpilotusa.com']);
    expect(body.headers).toEqual({ 'List-Unsubscribe': '<https://app/unsub>' });
  });
});
