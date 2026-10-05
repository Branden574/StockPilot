import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { maybeSendReturnPrompt } from './return-prompt';

/**
 * Tests for the shared one-time return-prompt email (returns-access Unit A).
 * Load-bearing invariants:
 *
 *   • the 0278 `return_prompt_sent_at` marker is claimed via a GUARDED update
 *     (`.is('return_prompt_sent_at', null)`) BEFORE the send — only the
 *     winner sends, so sign-then-complete (or any replay) yields ONE email;
 *   • a zero-fulfilled completion never emails (nothing to return);
 *   • every skip guard (status, requester_email, module, marker) is silent;
 *   • best-effort: a failing send or a throwing DB read RESOLVES (never
 *     rejects), so the caller's completion transition can never fail on it —
 *     and the marker stays set after a failed send (at-most-once posture);
 *   • SP-076: a public (account-less) requester who used the RFC 8058
 *     one-click unsubscribe THIS email advertises is suppressed — and the
 *     0278 marker is not burned on that skip. The lookup fails CLOSED;
 *   • a failed guard read (order, module, lines) stops with reason 'error'
 *     before any token is minted, instead of reading as a skip;
 *   • migration 0389: the token comes from ONE call to
 *     order_return_token_ensure (service role, atomic, never rotates: it
 *     keeps a side-table token, else moves the legacy column token, else
 *     mints). The raw token is never written to the order row; a failed
 *     ensure stops with reason 'error'.
 */

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email/resend', () => ({
  sendEmail: sendEmailMock,
}));

const reportErrorMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: reportErrorMock,
}));

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = 'org-test';
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_URL = 'https://app.example.com';

const COMPLETED_ORDER = {
  id: ORDER_ID,
  organization_id: ORG_ID,
  status: 'completed',
  requester_email: 'requester@example.com',
  requester_name: 'Reggie Requester',
  return_token: TOKEN,
  return_prompt_sent_at: null,
};

const MODULE_ON = { data: [{ module_id: 'returns' }], error: null };
const FULFILLED_LINES = {
  data: [{ quantity_fulfilled: 3 }, { quantity_fulfilled: 0 }],
  error: null,
};

/** Stub wired for the happy path; override per test. */
function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_requests.select': { data: [COMPLETED_ORDER], error: null },
    'organization_modules.select': MODULE_ON,
    'order_request_lines.select': FULFILLED_LINES,
    // The guarded marker claim succeeds.
    'order_requests.update': { data: [{ id: ORDER_ID }], error: null },
    // order_return_token_ensure (0389) answers the order's token.
    'rpc:order_return_token_ensure': { data: TOKEN, error: null },
    ...overrides,
  });
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true });
  reportErrorMock.mockClear();
});

describe('maybeSendReturnPrompt', () => {
  it('sends ONE prompt with the return-portal link and claims the marker first', async () => {
    const stub = makeStub();
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });

    expect(res).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(args.to).toBe('requester@example.com');
    expect(args.subject).toBe('Need to return anything from your order?');
    expect(args.text).toContain(`${APP_URL}/returns/request/${TOKEN}`);
    expect(args.html).toContain(`/returns/request/${TOKEN}`);

    // The marker update is GUARDED — `.is('return_prompt_sent_at', null)` —
    // so only one concurrent caller can win it.
    const updateChain = stub.chains.get('order_requests.update');
    expect(updateChain).toContain('is');
    const isArgs = stub.chainArgs
      .get('order_requests.update')!
      .filter((a) => a[0] === 'return_prompt_sent_at');
    expect(isArgs).toEqual([['return_prompt_sent_at', null]]);
  });

  it('renders through the es return-prompt template (Unit E5 — rendering swap only)', async () => {
    const stub = makeStub();
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: true });

    const args = sendEmailMock.mock.calls[0]![0] as {
      subject: string;
      html: string;
      text: string;
      from: string;
      headers: Record<string, string>;
    };
    // Registry-verbatim subject and sender (the `rec:` refined subject is
    // deliberately NOT implemented — comment only).
    expect(args.subject).toBe('Need to return anything from your order?');
    expect(args.from).toBe('StockPilot <orders@stockpilotusa.com>');
    // Preference-controlled: unsubscribe header + pref footer links.
    expect(args.headers['List-Unsubscribe']).toBeDefined();
    expect(args.html).toContain('>Manage email preferences</a>');
    expect(args.html).toContain('>Unsubscribe</a>');
    // Reverse-route motion + the es headline + CTA.
    expect(args.html).toContain('https://stockpilotusa.com/email/motion/reverse@2x.gif');
    expect(args.html).toContain('Need to return anything?');
    expect(args.html).toContain('Start a return');
    // Display handle: no order_number on the row → #<id-prefix> fallback.
    expect(args.html).toContain('#11111111');
  });

  it('dedupes: a second call (marker already stamped) no-ops', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, return_prompt_sent_at: '2026-07-20T00:00:00Z' }],
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sign-then-complete = exactly one send across two sequential calls', async () => {
    // First call sees a NULL marker and wins; the second (replayed
    // completion path) reads the row the first call stamped.
    let calls = 0;
    const stub = makeStub({
      'order_requests.select': () => {
        calls += 1;
        return calls === 1
          ? { data: [COMPLETED_ORDER], error: null }
          : {
              data: [{ ...COMPLETED_ORDER, return_prompt_sent_at: '2026-07-20T00:00:00Z' }],
              error: null,
            };
      },
    });
    const first = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    const second = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent race: losing the guarded marker update means NO send', async () => {
    // Pre-check saw NULL, but the guarded update matched no row (another
    // path claimed it in between) — the loser must not send.
    const stub = makeStub({
      'order_requests.update': { data: [], error: null },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'lost_race' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('zero fulfilled quantity: no email, marker never claimed', async () => {
    const stub = makeStub({
      'order_request_lines.select': {
        data: [{ quantity_fulfilled: 0 }, { quantity_fulfilled: null }],
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'zero_fulfilled' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No update chain at all — the guards run before any write.
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
  });

  it('skips a non-completed (backordered) order', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, status: 'backordered' }],
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'not_completed' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips when no requester email is on file', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, requester_email: null }],
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'no_requester_email' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // A3: a requester who deleted their account (0388 requester_deleted_at) is
  // never emailed again, even though the order keeps their address (O-A3-6);
  // the marker is not burned, and nothing about the person is read.
  it('skips a requester who deleted their account, with the address still on the order', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, requester_user_id: null, requester_deleted_at: '2026-10-04T12:00:00.000Z' }],
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'requester_deleted' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stub.chainArgsAll.get('order_requests.update') ?? []).toHaveLength(0);
    // The order's select asks for the marker.
    const selected = String(stub.chainArgsAll.get('order_requests.select')?.[0]?.[0]?.[0] ?? '');
    expect(selected).toContain('requester_deleted_at');
  });

  it('email-less order still MINTS a token (dashboard link) — no email, marker untouched', async () => {
    // Staff-created internal orders have requester_email NULL by construction,
    // but their requester is still entitled to the "Request a return" link on
    // /dashboard/orders/[id], which requires a minted return token. The mint is
    // structural (status + module + fulfilled); only the EMAIL needs an address.
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, requester_email: null }],
        error: null,
      },
      'rpc:order_return_token_ensure': {
        data: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });

    expect(res).toEqual({ sent: false, reason: 'no_requester_email' });
    expect(sendEmailMock).not.toHaveBeenCalled();

    // The token was ensured exactly once, for this order, through the RPC
    // (0389), and NO order update ran: no token is written to the member-
    // readable row, and the 0278 marker stays NULL (marker = email sent).
    expect(stub.rpcCalls).toEqual([
      { name: 'order_return_token_ensure', args: { p_order_id: ORDER_ID } },
    ]);
    expect(stub.chainArgsAll.get('order_requests.update') ?? []).toHaveLength(0);
  });

  it('SUPPRESSED: a public requester who used one-click unsubscribe gets no prompt, and the marker is NOT burned', async () => {
    // SP-076: this email advertises RFC 8058 one-click unsubscribe to
    // public (account-less) requesters, so a recorded opt-out in
    // public_email_unsubscribes must actually stop it.
    const stub = makeStub({
      'public_email_unsubscribes.select.maybeSingle': {
        data: { email: 'requester@example.com' },
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });

    expect(res).toEqual({ sent: false, reason: 'suppressed' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // The 0278 marker must stay NULL: suppression is a property of the
    // ADDRESS, not of the order, so a later un-suppression (or a corrected
    // address) can still prompt exactly once.
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
    // Looked the address up in its canonical (lowercased) spelling.
    expect(stub.chainArgs.get('public_email_unsubscribes.select')).toContainEqual([
      'email',
      'requester@example.com',
    ]);
  });

  it('SUPPRESSION is case-insensitive (canonical lowercased lookup)', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, requester_email: '  Requester@Example.COM ' }],
        error: null,
      },
      'public_email_unsubscribes.select.maybeSingle': {
        data: { email: 'requester@example.com' },
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'suppressed' });
    expect(stub.chainArgs.get('public_email_unsubscribes.select')).toContainEqual([
      'email',
      'requester@example.com',
    ]);
  });

  it('the public suppression list does NOT govern account holders (their prefs do)', async () => {
    // Mirrors the order-request choke point: signed-in requesters get the
    // in-app settings link (no one-click header), so a stray public row for
    // their address must not silently mute their transactional mail.
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, requester_user_id: 'user-1' }],
        error: null,
      },
      'public_email_unsubscribes.select.maybeSingle': {
        data: { email: 'requester@example.com' },
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // Account holders never get the one-click header pair.
    const headers = (sendEmailMock.mock.calls[0]![0] as { headers: Record<string, string> })
      .headers;
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('SUPPRESSION fails CLOSED: a lookup error sends nothing, reports, and leaves the marker unclaimed', async () => {
    // An unreadable opt-out list counts as opted out: mailing an address that
    // used the one-click unsubscribe this email advertises is a complaint
    // signal, while a skipped prompt is recoverable (tracking page, order
    // detail, and a later completion path can still prompt once).
    const stub = makeStub({
      'public_email_unsubscribes.select.maybeSingle': {
        data: null,
        error: { message: 'connection reset' },
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'suppressed' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'orders.return-prompt.unsubscribe_read' }),
    );
  });

  it.each([
    ['order_requests', 'order_requests.select.maybeSingle', 'orders.return-prompt.order_read'],
    [
      'organization_modules',
      'organization_modules.select.maybeSingle',
      'orders.return-prompt.module_read',
    ],
    ['order_request_lines', 'order_request_lines.select', 'orders.return-prompt.lines_read'],
  ])(
    'a failed %s read stops with reason error, reports, and mints no token',
    async (_table, key, tag) => {
      // Reaching the mint would show up as an order_return_token_ensure call.
      const stub = makeStub({
        [key]: { data: null, error: { message: 'connection reset' } },
      });
      const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'error' });
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.chains.get('order_requests.update')).toBeUndefined();
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tag }),
      );
    },
  );

  it('skips when the returns module is disabled for the org', async () => {
    const stub = makeStub({
      'organization_modules.select': { data: [], error: null },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'module_disabled' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('mints the return token through order_return_token_ensure, and links the token it answers', async () => {
    const minted = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const stub = makeStub({
      'rpc:order_return_token_ensure': { data: minted, error: null },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0] as { text: string };
    expect(args.text).toContain(`${APP_URL}/returns/request/${minted}`);
    // One ensure call; the only order update is the marker claim, which
    // writes no token.
    expect(stub.rpcCalls).toEqual([
      { name: 'order_return_token_ensure', args: { p_order_id: ORDER_ID } },
    ]);
    const updates = stub.chainArgsAll.get('order_requests.update') ?? [];
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0])).not.toContain('return_token');
    // The order read no longer asks for the token column at all.
    const select = (stub.chainArgsAll.get('order_requests.select') ?? [])[0]?.[0]?.[0] as string;
    expect(select).not.toContain('return_token');
  });

  it('a failed ensure stops with reason error, reports, and sends nothing', async () => {
    const stub = makeStub({
      'rpc:order_return_token_ensure': { data: null, error: { message: 'connection reset' } },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'error' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stub.chains.get('order_requests.update')).toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'orders.return-prompt.token_ensure' }),
    );
  });

  it('an ensure that answers no token stops with no_token and sends nothing', async () => {
    const stub = makeStub({ 'rpc:order_return_token_ensure': { data: null, error: null } });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'no_token' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('BEST-EFFORT: resolves (no throw) when the email send fails; marker stays set', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('resend down'));
    const stub = makeStub();
    // Must NOT reject — the caller's completion transition depends on it.
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'send_failed' });
    expect(reportErrorMock).toHaveBeenCalled();
    // At-most-once: no compensating update clearing the marker (exactly the
    // two writes at most: none here beyond the claim).
    const updates = stub.chainArgsAll.get('order_requests.update') ?? [];
    expect(updates.length).toBe(1);
  });

  it('BEST-EFFORT: resolves (no throw) when the DB read itself explodes', async () => {
    const client = {
      from: () => {
        throw new Error('db down');
      },
    };
    const res = await maybeSendReturnPrompt(
      client as never,
      ORDER_ID,
      { appUrl: APP_URL },
    );
    expect(res).toEqual({ sent: false, reason: 'error' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
