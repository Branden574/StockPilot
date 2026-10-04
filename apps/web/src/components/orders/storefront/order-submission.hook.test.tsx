import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createOrderRequestAction = vi.fn();
const getOrderSubmissionAction = vi.fn();
const withdrawOrderSubmissionAction = vi.fn();
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: (...args: unknown[]) => createOrderRequestAction(...args),
  getOrderSubmissionAction: (...args: unknown[]) => getOrderSubmissionAction(...args),
  withdrawOrderSubmissionAction: (...args: unknown[]) => withdrawOrderSubmissionAction(...args),
}));

import type { OrderCreateRequestInput } from '@stockpilot/core';

import { orderPendingKey, useOrderSubmission } from './order-submission';

/**
 * useOrderSubmission across tabs, workspaces and accounts (review round 1):
 *   - the pending slot is compare-and-set: a second tab never mints a key
 *     over a live one (it takes the live key and its panel instead), and a
 *     commit never overwrites or removes another key's record;
 *   - an answer for another organization, or a settle call answered for
 *     another account, never settles the key;
 *   - every call names the page's organization, and the settle calls the
 *     account that sent the key;
 *   - a page older than the server (its action gone after a deploy) keeps the
 *     key live and says to reload;
 *   - `ready` says the restore check has run.
 */

const ORG = '0a000000-0000-4000-8000-000000000001';
const OTHER_ORG = '0a000000-0000-4000-8000-000000000099';
const WH = '0a000000-0000-4000-8000-0000000000a1';
const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';
const ITEM = '0a000000-0000-4000-8000-0000000000e1';
const K1 = 'eeeeeeee-0000-4000-8000-000000000001';
const K2 = 'eeeeeeee-0000-4000-8000-000000000002';
const SLOT = orderPendingKey(USER, ORG, WH);

function body(key: string): OrderCreateRequestInput {
  return {
    idempotencyKey: key,
    placerUserId: USER,
    warehouseId: WH,
    fulfillmentType: 'pickup',
    deliveryCharterId: null,
    onBehalfOf: null,
    notes: null,
    neededByLocal: null,
    lines: [{ itemId: ITEM, quantity: 1 }],
  };
}

function record(key: string, sends = 1) {
  return { key, state: 'possibly_sent', sends, firstSentAt: '2026-10-04T10:00:00Z', body: body(key) };
}

const ORDER = {
  id: 'ffffffff-0000-4000-8000-000000000007',
  orderNumber: 7,
  orderLabel: 'SO-000007',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 1,
  createdAt: '2026-10-04T10:00:00+00:00',
  requestedFor: { self: true },
};
const placed = (organizationId = ORG) => ({
  ok: true,
  data: { organizationId, result: { replay: false, order: ORDER } },
});
const stored = () => {
  const raw = localStorage.getItem(SLOT);
  return raw ? (JSON.parse(raw) as { key: string; sends: number }) : null;
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tab() {
  const setLocked = vi.fn();
  const onRestore = vi.fn();
  const hook = renderHook(() =>
    useOrderSubmission({
      userId: USER,
      organizationId: ORG,
      warehouseId: WH,
      hydrated: true,
      setLocked,
      onRestore,
    }),
  );
  return { ...hook, setLocked, onRestore };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** A tab whose first send's answer was lost: K1 unconfirmed, its record kept. */
async function lostTab() {
  const t = tab();
  await flush();
  createOrderRequestAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await act(async () => t.result.current.send(body(K1)));
  await flush();
  expect(t.result.current.state.phase).toBe('unconfirmed');
  expect(stored()?.key).toBe(K1);
  return t;
}

beforeEach(() => {
  localStorage.clear();
  createOrderRequestAction.mockReset();
  getOrderSubmissionAction.mockReset();
  withdrawOrderSubmissionAction.mockReset();
});
afterEach(() => localStorage.clear());

describe('every call names the page and the account', () => {
  it('create names the organization; status and withdraw name the organization and the placer', async () => {
    const t = await lostTab();
    expect(createOrderRequestAction).toHaveBeenCalledWith(body(K1), { organizationId: ORG });
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: ORG, outcome: 'withdrawn' },
    });
    await act(async () => t.result.current.withdraw());
    await flush();
    expect(withdrawOrderSubmissionAction).toHaveBeenCalledWith({
      warehouseId: WH,
      key: K1,
      organizationId: ORG,
      placerUserId: USER,
    });
    t.unmount();
    localStorage.setItem(SLOT, JSON.stringify(record(K2)));
    getOrderSubmissionAction.mockResolvedValueOnce({ ok: true, data: { organizationId: ORG, outcome: 'none' } });
    tab();
    await flush();
    expect(getOrderSubmissionAction).toHaveBeenCalledWith({
      warehouseId: WH,
      key: K2,
      organizationId: ORG,
      placerUserId: USER,
    });
  });
});

describe('a workspace switch in another tab (findings 1 and 6)', () => {
  it('a resend answered with a refusal RECORDED in another organization stays locked and keeps the record', async () => {
    const t = await lostTab();
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'not_found',
        message: 'x',
        details: { reason: 'warehouse_not_available', settled: true, replay: false, organizationId: OTHER_ORG },
      },
    });
    await act(async () => t.result.current.resend());
    await flush();
    const s = t.result.current.state;
    expect(s.phase).toBe('unconfirmed');
    expect(s.phase === 'unconfirmed' && s.last.reason).toBe('organization_changed');
    expect(stored()).toMatchObject({ key: K1, sends: 2 });
    expect(t.setLocked).toHaveBeenLastCalledWith(true);
  });

  it("the server's own organization_changed refusal of a resend stays locked", async () => {
    const t = await lostTab();
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'x', details: { reason: 'organization_changed', organizationId: OTHER_ORG } },
    });
    await act(async () => t.result.current.resend());
    await flush();
    expect(t.result.current.state.phase).toBe('unconfirmed');
    expect(stored()?.key).toBe(K1);
  });

  it('a withdraw or status answer for another organization never settles the key', async () => {
    const t = await lostTab();
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: OTHER_ORG, outcome: 'withdrawn' },
    });
    await act(async () => t.result.current.withdraw());
    await flush();
    expect(t.result.current.state.phase).toBe('unconfirmed');
    expect(stored()?.key).toBe(K1);
  });
});

describe('a stale tab under another account (finding 2)', () => {
  it("Don't send it answered placer_mismatch stays locked and keeps the first account's record", async () => {
    const t = await lostTab();
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'x', details: { reason: 'placer_mismatch', organizationId: ORG } },
    });
    await act(async () => t.result.current.withdraw());
    await flush();
    const s = t.result.current.state;
    expect(s.phase).toBe('unconfirmed');
    expect(s.phase === 'unconfirmed' && s.last.reason).toBe('placer_mismatch');
    expect(stored()?.key).toBe(K1);
  });
});

describe('the pending slot is compare-and-set (finding 3)', () => {
  it('a second tab never mints a key over a live one: it takes the live key, locks, and reads its status', async () => {
    const second = tab();
    await flush();
    expect(second.result.current.state.phase).toBe('open');
    await lostTab();
    createOrderRequestAction.mockClear();
    getOrderSubmissionAction.mockResolvedValueOnce({ ok: true, data: { organizationId: ORG, outcome: 'none' } });
    await act(async () => second.result.current.send(body(K2)));
    await flush();
    expect(createOrderRequestAction).not.toHaveBeenCalled();
    const s = second.result.current.state;
    expect(s.phase).toBe('unconfirmed');
    expect(s.phase === 'unconfirmed' && s.pending.key).toBe(K1);
    expect(second.onRestore).toHaveBeenCalledWith(body(K1));
    expect(second.setLocked).toHaveBeenLastCalledWith(true);
    expect(getOrderSubmissionAction).toHaveBeenCalledWith(expect.objectContaining({ key: K1 }));
    expect(stored()?.key).toBe(K1);
  });

  it("a final answer never removes another key's record", async () => {
    const t = tab();
    await flush();
    const out = deferred<unknown>();
    createOrderRequestAction.mockReturnValueOnce(out.promise);
    act(() => t.result.current.send(body(K1)));
    // Another tab of this account now holds K2 in the slot.
    localStorage.setItem(SLOT, JSON.stringify(record(K2)));
    await act(async () => out.resolve(placed()));
    await flush();
    expect(t.result.current.state.phase).toBe('placed');
    expect(stored()?.key).toBe(K2);
  });

  it("a live write never overwrites another key's record (nothing is sent)", async () => {
    const t = await lostTab();
    localStorage.setItem(SLOT, JSON.stringify(record(K2)));
    createOrderRequestAction.mockClear();
    await act(async () => t.result.current.resend());
    await flush();
    expect(createOrderRequestAction).not.toHaveBeenCalled();
    expect(stored()?.key).toBe(K2);
    expect(t.result.current.state.phase).toBe('unconfirmed');
    expect(t.result.current.deviceError).not.toBeNull();
  });

  it('an empty slot, or its own key, is written as before', async () => {
    const t = await lostTab();
    createOrderRequestAction.mockResolvedValueOnce(placed());
    await act(async () => t.result.current.resend());
    await flush();
    expect(t.result.current.state.phase).toBe('placed');
    expect(stored()).toBeNull();
  });
});

describe('a page older than the server (finding 9)', () => {
  const gone = () =>
    Object.assign(
      new Error(
        'Server Action "7f00aa" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
      ),
      { name: 'UnrecognizedActionError' },
    );

  it('a resend whose action is gone keeps the key live and says to reload', async () => {
    const t = await lostTab();
    createOrderRequestAction.mockRejectedValueOnce(gone());
    await act(async () => t.result.current.resend());
    await flush();
    const s = t.result.current.state;
    expect(s.phase === 'unconfirmed' && s.last.reason).toBe('page_out_of_date');
    expect(stored()?.key).toBe(K1);
  });

  it('a withdraw whose action is gone keeps the key live too', async () => {
    const t = await lostTab();
    withdrawOrderSubmissionAction.mockRejectedValueOnce(gone());
    await act(async () => t.result.current.withdraw());
    await flush();
    const s = t.result.current.state;
    expect(s.phase === 'unconfirmed' && s.last.reason).toBe('page_out_of_date');
    expect(stored()?.key).toBe(K1);
  });

  it('the only send whose action is gone never ran: final, unlocked, the record removed', async () => {
    const t = tab();
    await flush();
    createOrderRequestAction.mockRejectedValueOnce(gone());
    await act(async () => t.result.current.send(body(K1)));
    await flush();
    const s = t.result.current.state;
    expect(s.phase === 'refused' && s.reason).toBe('page_out_of_date');
    expect(stored()).toBeNull();
  });
});

describe('ready', () => {
  it('is false until the cart has hydrated, then true once the restore check has run', async () => {
    const setLocked = vi.fn();
    const { result, rerender } = renderHook(
      ({ hydrated }) =>
        useOrderSubmission({
          userId: USER,
          organizationId: ORG,
          warehouseId: WH,
          hydrated,
          setLocked,
          onRestore: vi.fn(),
        }),
      { initialProps: { hydrated: false } },
    );
    expect(result.current.ready).toBe(false);
    rerender({ hydrated: true });
    await flush();
    expect(result.current.ready).toBe(true);
  });
});
