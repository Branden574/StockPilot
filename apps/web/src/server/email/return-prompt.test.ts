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
 *     and the marker stays set after a failed send (at-most-once posture).
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
    // Guarded marker claim (and, when minting, the token update) succeed.
    'order_requests.update': { data: [{ id: ORDER_ID, return_token: TOKEN }], error: null },
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

  it('email-less order still MINTS a token (dashboard link) — no email, marker untouched', async () => {
    // Staff-created internal orders have requester_email NULL by construction,
    // but their requester is still entitled to the "Request a return" link on
    // /dashboard/orders/[id], which requires a minted return_token. The mint is
    // structural (status + module + fulfilled); only the EMAIL needs an address.
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, requester_email: null, return_token: null }],
        error: null,
      },
      'order_requests.update': {
        data: [{ id: ORDER_ID, return_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
        error: null,
      },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });

    expect(res).toEqual({ sent: false, reason: 'no_requester_email' });
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Exactly ONE update ran — the guarded token mint. The 0278 marker stays
    // NULL (marker = email sent), so a later completion path can still prompt
    // once if an email is ever added.
    const updates = stub.chainArgsAll.get('order_requests.update') ?? [];
    expect(updates).toHaveLength(1);
    const mintArgs = updates[0]!;
    expect(mintArgs).toContainEqual(['return_token', null]); // guarded mint
    expect(mintArgs).not.toContainEqual(['return_prompt_sent_at', null]); // no marker claim
  });

  it('skips when the returns module is disabled for the org', async () => {
    const stub = makeStub({
      'organization_modules.select': { data: [], error: null },
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'module_disabled' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('mints the return token (guarded on NULL) when the order has none', async () => {
    const stub = makeStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, return_token: null }],
        error: null,
      },
      // Both updates (mint + marker) succeed; the mint returns the new token.
      'order_requests.update': () => ({
        data: [{ id: ORDER_ID, return_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
        error: null,
      }),
    });
    const res = await maybeSendReturnPrompt(stub.client, ORDER_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // The mint is guarded on return_token IS NULL so a replay never rotates
    // an already-issued token.
    const allArgs = stub.chainArgsAll.get('order_requests.update') ?? [];
    const mintChainArgs = allArgs[0]!;
    expect(mintChainArgs).toContainEqual(['return_token', null]);
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
