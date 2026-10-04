import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_DEVICE_SAVE_FAILED_COPY,
  ORDER_ADD_WHILE_LOCKED_COPY,
  orderSubmissionLocked,
  type OrderCreateRequestInput,
  type OrderSubmissionState,
  type PendingOrderSubmission,
} from '@stockpilot/core';

import { api } from '../api';
import { createOrderStorefrontApi } from './api';
import { createSubmitEngine, showUnconfirmedPanel, type SubmitEngine } from './submit';

/**
 * PLACING ONCE FROM THE PHONE (plan 3.4), driven through the REAL api() (only
 * fetch, the session and the native modules are stubbed), so every refusal
 * the engine classifies is a real ApiError built from a real response, never
 * a hand-made shape (the Add items defect D1 shipped because its test fed a
 * string api() had stopped producing).
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
const session = vi.hoisted(() => ({ userId: 'u1' as string | null }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: session.userId ? { user: { id: session.userId }, access_token: 'token' } : null,
        },
      })),
    },
  },
}));
vi.mock('../account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('../request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const ORDER = '66666666-6666-4666-8666-666666666666';

const BODY: OrderCreateRequestInput = {
  idempotencyKey: KEY,
  placerUserId: USER,
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  onBehalfOf: null,
  notes: null,
  neededByLocal: null,
  lines: [{ itemId: ITEM, quantity: 2 }],
};

const SUMMARY = {
  id: ORDER,
  orderNumber: 123,
  orderLabel: 'SO-000123',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 2,
  createdAt: '2026-10-04T12:00:00.000Z',
  requestedFor: { self: true },
};

type Reply = { status: number; body: unknown } | { reject: unknown } | { hang: true };

const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
const events: string[] = [];
let replies: Reply[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push({
        method: init.method ?? 'GET',
        path,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      events.push(`fetch ${init.method ?? 'GET'} ${path.split('?')[0]}`);
      const reply = replies.shift() ?? { reject: new TypeError('Network request failed') };
      if ('hang' in reply) return new Promise(() => undefined);
      if ('reject' in reply) throw reply.reject;
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    }),
  );
}

function refusal(status: number, error: string, details: Record<string, unknown>): Reply {
  return { status, body: { organizationId: ORG, error, message: 'x', details: { organizationId: ORG, ...details } } };
}

const placedReply = (replay: boolean): Reply => ({
  status: replay ? 200 : 201,
  body: { organizationId: ORG, result: { replay, order: SUMMARY } },
});

let stored: (PendingOrderSubmission | null)[] = [];
let persistFails = false;

function engine(): SubmitEngine {
  const calls3 = createOrderStorefrontApi((path, opts) => api(path, opts));
  const scope = { orgId: ORG, userId: USER };
  return createSubmitEngine({
    organizationId: ORG,
    persist: async (next: OrderSubmissionState) => {
      events.push(`persist ${next.phase}`);
      if (persistFails) throw new Error('disk full');
      stored.push(
        next.phase === 'sending' || next.phase === 'withdrawing' || next.phase === 'unconfirmed' ? next.pending : null,
      );
    },
    place: (body, onSend) => calls3.place(scope, body, onSend),
    status: (key) => calls3.status(scope, key),
    withdraw: (key) => calls3.withdraw(scope, key),
    now: () => new Date('2026-10-04T12:00:00.000Z'),
  });
}

beforeEach(() => {
  calls.length = 0;
  events.length = 0;
  replies = [];
  stored = [];
  persistFails = false;
  session.userId = USER;
  stubFetch();
});

const phase = (e: SubmitEngine) => e.getSnapshot().state.phase;

describe('one send (plan 3.4: the answer to the ONLY send of a key)', () => {
  it('201: placed, and the record is written BEFORE the request leaves (write-ahead, already counting it)', async () => {
    const e = engine();
    replies = [placedReply(false)];
    await e.submit(BODY);
    expect(events).toEqual(['persist sending', 'fetch POST /api/v1/orders', 'persist placed']);
    expect(stored[0]).toMatchObject({ key: KEY, sends: 1, state: 'possibly_sent' });
    expect(stored[1]).toBeNull();
    expect(e.getSnapshot().state).toMatchObject({ phase: 'placed', replay: false, order: { orderLabel: 'SO-000123' } });
    expect(e.getSnapshot().sent).toBe(true);
  });

  it('the call names the cart’s organization and is sent only as its account (orgId, asUserId)', async () => {
    const e = engine();
    replies = [placedReply(false)];
    await e.submit(BODY);
    expect(calls[0]!.headers['X-Organization-Id']).toBe(ORG);
    expect(calls[0]!.headers.Authorization).toBe('Bearer token');
    expect(calls[0]!.body).toEqual(BODY);
  });

  it('another account signed in by the time it leaves: nothing is sent, and the key stays live (locked)', async () => {
    const e = engine();
    session.userId = 'someone-else';
    await e.submit(BODY);
    expect(calls).toHaveLength(0);
    expect(phase(e)).toBe('unconfirmed');
    expect(orderSubmissionLocked(e.getSnapshot().state)).toBe(true);
  });

  it('a write-ahead that fails sends NOTHING and says core’s sentence; the cart stays open', async () => {
    const e = engine();
    persistFails = true;
    await e.submit(BODY);
    expect(calls).toHaveLength(0);
    expect(phase(e)).toBe('open');
    expect(e.getSnapshot().deviceError).toBe(ORDER_DEVICE_SAVE_FAILED_COPY);
  });

  it('a second tap in the same frame sends once (the ref guard, not React state)', async () => {
    const e = engine();
    replies = [placedReply(false), placedReply(true)];
    await Promise.all([e.submit(BODY), e.submit(BODY), e.checkAndFinish()]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('settled refusal (recorded under the key): final, unlocked, the items named', async () => {
    const e = engine();
    replies = [refusal(400, 'validation_error', { reason: 'item_not_orderable', settled: true, items: { [ITEM]: 'archived' } })];
    await e.submit(BODY);
    expect(e.getSnapshot().state).toMatchObject({ phase: 'refused', reason: 'item_not_orderable', recorded: true });
    expect(orderSubmissionLocked(e.getSnapshot().state)).toBe(false);
    expect(stored.at(-1)).toBeNull();
  });

  it('409 submission_withdrawn: final, not sent', async () => {
    const e = engine();
    replies = [refusal(409, 'conflict', { reason: 'submission_withdrawn', settled: true })];
    await e.submit(BODY);
    expect(phase(e)).toBe('withdrawn');
  });

  it.each([
    ['400 shape refusal', refusal(400, 'validation_error', { reason: 'too_many_lines' })],
    ['403 permission (not recorded)', refusal(403, 'forbidden', { reason: 'permission' })],
    ['403 aal2_required', refusal(403, 'forbidden', { reason: 'aal2_required' })],
    ['401 unauthenticated', refusal(401, 'unauthenticated', { reason: 'unauthenticated' })],
  ])('any other 4xx to the only send is final (nothing was placed): %s', async (_l, reply) => {
    const e = engine();
    replies = [reply];
    await e.submit(BODY);
    expect(e.getSnapshot().state).toMatchObject({ phase: 'refused', recorded: false });
  });

  it('a 404 that is not our JSON on the only send: final, "isn’t available right now"', async () => {
    const e = engine();
    replies = [{ status: 404, body: '<html>Not found</html>' }];
    await e.submit(BODY);
    expect(e.getSnapshot().state).toMatchObject({ phase: 'refused', reason: 'unavailable' });
  });

  it.each([
    ['409 busy', refusal(409, 'conflict', { reason: 'busy', retryable: true }), 'busy'],
    ['409 idempotency_conflict', refusal(409, 'conflict', { reason: 'idempotency_conflict' }), 'conflict'],
    ['429', refusal(429, 'rate_limited', { reason: 'rate_limited' }), 'rate_limited'],
    ['500', refusal(500, 'internal_error', { reason: 'failed' }), 'server_fault'],
    ['no answer (network)', { reject: new TypeError('Network request failed') } as Reply, 'no_answer'],
    ['an unreadable 2xx', { status: 201, body: { organizationId: ORG, result: { replay: false } } } as Reply, 'unreadable'],
  ])('%s: NOT final, the cart stays locked with the key', async (_l, reply, why) => {
    const e = engine();
    replies = [reply];
    await e.submit(BODY);
    expect(e.getSnapshot().state).toMatchObject({ phase: 'unconfirmed', last: { why } });
    expect(orderSubmissionLocked(e.getSnapshot().state)).toBe(true);
    expect(stored.at(-1)).toMatchObject({ key: KEY, sends: 1 });
  });

  it('a placed answer for ANOTHER organization never settles this key', async () => {
    const e = engine();
    replies = [{ status: 201, body: { organizationId: OTHER_ORG, result: { replay: false, order: SUMMARY } } }];
    await e.submit(BODY);
    expect(phase(e)).toBe('unconfirmed');
  });

  it('a refusal named for another organization is an organization_changed refusal, never recorded here', async () => {
    const e = engine();
    replies = [
      { status: 403, body: { error: 'forbidden', message: 'x', details: { reason: 'permission', settled: true, organizationId: OTHER_ORG } } },
    ];
    await e.submit(BODY);
    expect(e.getSnapshot().state).toMatchObject({ phase: 'refused', reason: 'organization_changed', recorded: false });
  });
});

async function unconfirmed(): Promise<SubmitEngine> {
  const e = engine();
  replies = [{ reject: new TypeError('Network request failed') }];
  await e.submit(BODY);
  expect(phase(e)).toBe('unconfirmed');
  calls.length = 0;
  events.length = 0;
  return e;
}

describe('Check and finish (a resend of the same key and body)', () => {
  it('sends the SAME key and body, counting the send before it leaves', async () => {
    const e = await unconfirmed();
    replies = [placedReply(true)];
    await e.checkAndFinish();
    expect(events[0]).toBe('persist sending');
    expect(stored.find((p) => p && p.sends === 2)).toMatchObject({ key: KEY });
    expect(calls[0]!.body).toEqual(BODY);
    expect(e.getSnapshot().state).toMatchObject({ phase: 'placed', replay: true });
  });

  it.each([
    ['401', refusal(401, 'unauthenticated', { reason: 'unauthenticated' })],
    ['aal2_required', refusal(403, 'forbidden', { reason: 'aal2_required' })],
    ['mfa_required', refusal(403, 'forbidden', { reason: 'mfa_required' })],
    ['module_disabled (service)', refusal(403, 'module_disabled', { reason: 'module_disabled' })],
    ['permission (service)', refusal(403, 'forbidden', { reason: 'permission' })],
    ['placer_mismatch', refusal(403, 'forbidden', { reason: 'placer_mismatch' })],
    ['a shape refusal', refusal(400, 'validation_error', { reason: 'invalid', field: 'body' })],
    ['404 not ours', { status: 404, body: 'nope' } as Reply],
  ])('a refused RESEND (%s) never unlocks: the earlier send was never checked', async (_l, reply) => {
    const e = await unconfirmed();
    replies = [reply];
    await e.checkAndFinish();
    expect(phase(e)).toBe('unconfirmed');
    expect(orderSubmissionLocked(e.getSnapshot().state)).toBe(true);
  });

  it('a recorded refusal on a resend is final', async () => {
    const e = await unconfirmed();
    replies = [refusal(400, 'validation_error', { reason: 'needed_by_past', settled: true, replay: true })];
    await e.checkAndFinish();
    expect(e.getSnapshot().state).toMatchObject({ phase: 'refused', recorded: true });
  });

  it('a resend whose write-ahead fails sends nothing and stays unconfirmed', async () => {
    const e = await unconfirmed();
    persistFails = true;
    await e.checkAndFinish();
    expect(calls).toHaveLength(0);
    expect(phase(e)).toBe('unconfirmed');
    expect(e.getSnapshot().deviceError).toBe(ORDER_DEVICE_SAVE_FAILED_COPY);
  });
});

describe('"Don\'t send it" (the withdraw: its answer is final)', () => {
  it('withdrawn: unlocked; the call names the placer', async () => {
    const e = await unconfirmed();
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'withdrawn' } }];
    await e.dontSend();
    expect(calls[0]).toMatchObject({ method: 'POST', path: `/api/v1/orders/submissions/${KEY}/withdraw`, body: { placerUserId: USER } });
    expect(phase(e)).toBe('withdrawn');
    expect(stored.at(-1)).toBeNull();
  });

  it('it had already been placed: the success screen, viaWithdraw', async () => {
    const e = await unconfirmed();
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'placed', order: SUMMARY } }];
    await e.dontSend();
    expect(e.getSnapshot().state).toMatchObject({ phase: 'placed', viaWithdraw: true });
  });

  it('a withdraw with no answer stays locked', async () => {
    const e = await unconfirmed();
    replies = [{ reject: new TypeError('Network request failed') }];
    await e.dontSend();
    expect(phase(e)).toBe('unconfirmed');
  });

  it('only a tap withdraws: nothing else ever POSTs a withdraw', async () => {
    const e = await unconfirmed();
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'none' } }];
    await e.readStatus();
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('the automatic status read', () => {
  it.each([
    ['none', { organizationId: ORG, outcome: 'none' }, 'unconfirmed'],
    ['placed', { organizationId: ORG, outcome: 'placed', order: SUMMARY }, 'placed'],
    ['refused', { organizationId: ORG, outcome: 'refused', refusal: { reason: 'permission', detail: null } }, 'refused'],
    ['withdrawn', { organizationId: ORG, outcome: 'withdrawn' }, 'withdrawn'],
  ])('answers %s', async (_l, body, expected) => {
    const e = await unconfirmed();
    replies = [{ status: 200, body }];
    await e.readStatus();
    expect(phase(e)).toBe(expected);
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/v1/orders/submissions/${KEY}?placerUserId=${USER}` });
  });

  it('a status read for another organization never settles the key', async () => {
    const e = await unconfirmed();
    replies = [{ status: 200, body: { organizationId: OTHER_ORG, outcome: 'placed', order: SUMMARY } }];
    await e.readStatus();
    expect(phase(e)).toBe('unconfirmed');
  });

  it('runs only while unconfirmed (never with no key, never while a send is out)', async () => {
    const e = engine();
    await e.readStatus();
    expect(calls).toHaveLength(0);
  });
});

describe('a relaunch with a pending record', () => {
  const pending: PendingOrderSubmission = {
    key: KEY,
    body: BODY,
    state: 'possibly_sent',
    sends: 1,
    firstSentAt: '2026-10-04T12:00:00.000Z',
  };

  it('reads as unconfirmed, locked, and reads its status on its own: never resent', async () => {
    const e = engine();
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'none' } }];
    expect(e.restore(pending)).toBe(true);
    expect(phase(e)).toBe('unconfirmed');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('GET');
    expect(phase(e)).toBe('unconfirmed');
  });

  it('a body this build cannot read is never resent: Check and finish does nothing, Don’t send it settles it', async () => {
    const e = engine();
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'none' } }];
    e.restore({ ...pending, body: { idempotencyKey: KEY, placerUserId: USER, old: true }, bodyUnreadable: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await e.checkAndFinish();
    expect(calls).toHaveLength(1);
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'withdrawn' } }];
    await e.dontSend();
    expect(phase(e)).toBe('withdrawn');
  });
});

describe('a locked cart refuses an add (core refuseAddWhileLocked)', () => {
  it('while unconfirmed, and not once settled', async () => {
    const e = await unconfirmed();
    expect(e.refuseChange()).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    replies = [{ status: 200, body: { organizationId: ORG, outcome: 'withdrawn' } }];
    await e.dontSend();
    expect(e.refuseChange()).toBeNull();
  });

  it('while the first send is still out', async () => {
    const e = engine();
    replies = [{ hang: true }];
    void e.submit(BODY);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(phase(e)).toBe('sending');
    expect(e.refuseChange()).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
  });
});

describe('when the unconfirmed panel shows', () => {
  const pending: PendingOrderSubmission = { key: KEY, body: BODY, state: 'possibly_sent', sends: 1, firstSentAt: 'x' };
  const last = { final: false as const, why: 'no_answer' as const, reason: null, details: null };
  it('once a send is unanswered, or while a resend or a withdraw is out; never for the first send', () => {
    expect(showUnconfirmedPanel({ phase: 'open' })).toBe(false);
    expect(showUnconfirmedPanel({ phase: 'sending', pending })).toBe(false);
    expect(showUnconfirmedPanel({ phase: 'sending', pending: { ...pending, sends: 2 } })).toBe(true);
    expect(showUnconfirmedPanel({ phase: 'unconfirmed', pending, last })).toBe(true);
    expect(showUnconfirmedPanel({ phase: 'withdrawing', pending, last })).toBe(true);
    expect(showUnconfirmedPanel({ phase: 'withdrawn' })).toBe(false);
  });
});
