import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adjustSendGate, UNCONFIRMED_ADJUST_PREFIX } from './adjust-outbox';
import { OutboxSessionChangedError } from './outbox-scope';
import { drainQueue, syncNow } from './sync';
import { UNCONFIRMED_SETTLE_MS, unconfirmedStock } from './unconfirmed-stock';

// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform,
// so declaring them below keeps the import block lint-clean (the same shape
// warehouse-scope.test.ts uses).

/**
 * The outbox drain, EXECUTED — not pinned as source text (SP-060).
 *
 * drain-rejection-wiring.test.ts guards the *wiring* of this loop with
 * readFileSync string pins, and it says those pins exist because sync.ts
 * "cannot be loaded in this node vitest environment". That premise is wrong:
 * the only reason sync.ts needs native modules is its imports, and vi.mock
 * replaces them (warehouse-scope.test.ts already does this for './db'). The
 * pins therefore never executed the state machine that decides whether an
 * operator's offline work is sent, kept, or destroyed:
 *
 *     markSending → sendOne → markOk        (markOk DELETES the row)
 *                          ↘ markFailed     (retried next tick)
 *                          ↘ markRejected   (terminal)
 *
 * A refactor that moved `markOk` above the `await sendOne(...)` — or dropped
 * `markFailed` from the catch, stranding the row in 'sending' until the next
 * app restart — kept every pinned substring intact and silently lost queued PO
 * receipts. This file fails on exactly those mutations; the pins stay, because
 * they see import wiring that mocks hide.
 */

const netMock = vi.hoisted(() => ({
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));
vi.mock('expo-network', () => netMock);

/** Every queue/api touch, in order — the assertion subject. */
const calls = vi.hoisted(() => ({ log: [] as string[] }));

const queueMock = vi.hoisted(() => ({
  listPending: vi.fn(),
  markSending: vi.fn(),
  markOk: vi.fn(),
  markFailed: vi.fn(),
  markRejected: vi.fn(),
  markHeld: vi.fn(),
}));
vi.mock('./queue', () => queueMock);

/** The workspace and account live on the device, read by the drain per row. */
const live = vi.hoisted(() => ({ orgId: 'org-live' as string | null, userId: 'u1' as string | null }));
const scopeMock = vi.hoisted(() => ({ liveOutboxScope: vi.fn() }));
vi.mock('./session-scope', () => scopeMock);

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => apiMock);

const disabledMock = vi.hoisted(() => ({ getAccountDisabled: vi.fn(() => false) }));
vi.mock('./account-disabled-state', () => disabledMock);

// db.ts / the meta-backed nav caches pull in expo-sqlite + React — none of the
// drain path touches them, so they are stubbed wholesale.
vi.mock('./db', () => ({
  getDb: vi.fn(),
  withDbTransaction: vi.fn(),
  currentCacheGeneration: vi.fn(() => 0),
  getMeta: vi.fn(async () => null),
  setMeta: vi.fn(async () => {}),
}));
vi.mock('./enabled-modules', () => ({
  ENABLED_MODULES_META_KEY: 'enabled_modules',
  refreshEnabledModules: vi.fn(),
}));
vi.mock('./use-effective-permissions', () => ({
  EFFECTIVE_PERMISSIONS_META_KEY: 'effective_permissions',
  refreshEffectivePermissions: vi.fn(),
}));
vi.mock('./warehouse-scope', () => ({
  WAREHOUSE_SCOPE_META_KEY: 'warehouse_scope',
  refreshWarehouseScope: vi.fn(),
}));

type Row = {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  organizationId?: string | null;
  userId?: string | null;
};

function httpError(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  calls.log = [];
  disabledMock.getAccountDisabled.mockReturnValue(false);
  netMock.getNetworkStateAsync.mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  });
  live.orgId = 'org-live';
  live.userId = 'u1';
  scopeMock.liveOutboxScope.mockReset().mockImplementation(async () => ({ ...live }));
  for (const name of ['markSending', 'markOk', 'markFailed', 'markRejected', 'markHeld'] as const) {
    queueMock[name].mockReset().mockImplementation(async (id: number) => {
      calls.log.push(`${name}:${id}`);
    });
  }
  queueMock.listPending.mockReset();
  apiMock.api.mockReset().mockImplementation(async (path: string) => {
    calls.log.push(`api:${path}`);
  });
  // drainQueue is called here without the snapshot pull that precedes it in
  // syncNow; that pull is what opens the adjust_stock send gate
  // (adjust-outbox.ts). Open it as a pull that got an answer would; the tests
  // of the gate itself close it again.
  adjustSendGate.resetForTests();
  adjustSendGate.serverAnswered();
  unconfirmedStock.resetForTests();
});

function pending(rows: Row[]) {
  queueMock.listPending.mockResolvedValue(rows);
}

const RECEIPT: Row = {
  id: 1,
  kind: 'receive_po_line',
  idempotencyKey: 'k1',
  payload: { poId: 'po1', lineId: 'l1', quantity: 2 },
};
const COUNT: Row = {
  id: 2,
  kind: 'record_count',
  idempotencyKey: 'k2',
  payload: { cycleCountId: 'cc1', lineId: 'l9', countedQuantity: 3 },
};
const BUNDLE: Row = {
  id: 3,
  kind: 'distribute_bundle',
  idempotencyKey: 'k3',
  payload: { bundleId: 'b1', quantity: 1 },
};

describe('drainQueue — the state machine, executed', () => {
  it('acks ONLY after the send lands, and reports the row as ok', async () => {
    pending([RECEIPT]);
    const res = await drainQueue();
    // The order is the whole point: markOk deletes the row, so it may never
    // run before the request the row exists to make.
    expect(calls.log).toEqual([
      'markSending:1',
      'api:/api/v1/po/po1/receive-line',
      'markOk:1',
    ]);
    expect(res).toEqual({ ok: 1, failed: 0, rejected: 0 });
  });

  it('sends the row’s own idempotency key so a retry cannot double-receive', async () => {
    pending([RECEIPT]);
    await drainQueue();
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/po/po1/receive-line', {
      method: 'POST',
      body: { poId: 'po1', lineId: 'l1', quantity: 2, idempotencyKey: 'k1' },
      // A legacy row (no owner): the live workspace and account.
      orgId: 'org-live',
      asUserId: 'u1',
    });
  });

  it('a 5xx KEEPS the work: markFailed, never markOk, never markRejected', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw httpError(500);
    });
    pending([RECEIPT]);
    const res = await drainQueue();
    expect(calls.log).toEqual([
      'markSending:1',
      'api:/api/v1/po/po1/receive-line',
      'markFailed:1',
    ]);
    expect(res).toEqual({ ok: 0, failed: 1, rejected: 0 });
  });

  it('a definitive refusal (403) is TERMINAL — markRejected, not another retry', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw httpError(403, 'forbidden');
    });
    pending([BUNDLE]);
    const res = await drainQueue();
    expect(calls.log).toEqual([
      'markSending:3',
      'api:/api/v1/bundles/b1/distribute',
      'markRejected:3',
    ]);
    expect(queueMock.markFailed).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: 0, failed: 0, rejected: 1 });
  });

  it('a 401 on a KNOWN-DISABLED account is terminal; on a live account it retries', async () => {
    apiMock.api.mockImplementation(async () => {
      throw httpError(401, 'unauthorized');
    });
    pending([RECEIPT]);
    disabledMock.getAccountDisabled.mockReturnValue(true);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });

    calls.log = [];
    disabledMock.getAccountDisabled.mockReturnValue(false);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
  });

  it('one failure does not abandon the rest of the queue', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (path.includes('/bundles/')) throw httpError(500);
    });
    pending([BUNDLE, RECEIPT]);
    expect(await drainQueue()).toEqual({ ok: 1, failed: 1, rejected: 0 });
  });

  it('never touches record_count rows — the cycle-count engine owns them', async () => {
    pending([RECEIPT, COUNT, BUNDLE]);
    await drainQueue();
    // Not marked sending, not sent, not failed: the row is left exactly as it
    // was for CycleCountSyncEngine. Two engines pushing the same edit would
    // post the operator's count twice.
    expect(calls.log.some((c) => c.endsWith(':2'))).toBe(false);
    expect(apiMock.api).not.toHaveBeenCalledWith(
      expect.stringContaining('/cycle-counts/'),
      expect.anything(),
    );
  });

  it('offline: nothing is dequeued, nothing is marked', async () => {
    netMock.getNetworkStateAsync.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });
    pending([RECEIPT]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual([]);
    expect(queueMock.listPending).not.toHaveBeenCalled();
  });

  it('an unknown kind fails the row instead of silently dropping it', async () => {
    pending([{ id: 7, kind: 'teleport_stock', idempotencyKey: 'k7', payload: {} }]);
    const res = await drainQueue();
    expect(calls.log).toEqual(['markSending:7', 'markFailed:7']);
    expect(res).toEqual({ ok: 0, failed: 1, rejected: 0 });
  });
});

describe('drainQueue — every row is sent under its own org, and only as its own account (S4a)', () => {
  const OWN_ROW_ORG_A: Row = { ...RECEIPT, organizationId: 'org-a', userId: 'u1' };

  it('a row queued in org A reaches api() with org A while org B is the active workspace', async () => {
    live.orgId = 'org-b';
    pending([OWN_ROW_ORG_A]);
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/po/po1/receive-line',
      expect.objectContaining({ orgId: 'org-a', asUserId: 'u1' }),
    );
  });

  it("a row queued by U1 is HELD under U2's session: not sent, not failed, not rejected, not touched", async () => {
    live.userId = 'u2';
    pending([OWN_ROW_ORG_A]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(apiMock.api).not.toHaveBeenCalled();
    // Left exactly as it was: no status write of any kind.
    expect(calls.log).toEqual([]);
  });

  it('a session change BETWEEN two rows of one drain stops the second row', async () => {
    // The first send is where the session changes (a sign-out, "Use a
    // different account", a revoked session): the check is per row, so the
    // second row is held rather than sent under the next account.
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      live.userId = 'u2';
    });
    pending([OWN_ROW_ORG_A, { ...BUNDLE, organizationId: 'org-a', userId: 'u1' }]);
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markOk:1']);
    expect(apiMock.api).not.toHaveBeenCalledWith('/api/v1/bundles/b1/distribute', expect.anything());
  });

  it('a legacy row is sent under the live context and stamped with it at its first send', async () => {
    pending([RECEIPT]);
    await drainQueue();
    expect(queueMock.markSending).toHaveBeenCalledWith(1, { orgId: 'org-live', userId: 'u1' });
  });

  it('with nobody signed in nothing is sent and nothing is marked', async () => {
    live.userId = null;
    pending([RECEIPT, OWN_ROW_ORG_A]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(calls.log).toEqual([]);
  });

  it('api() refusing because the account changed at the moment of sending puts the row back, unfailed', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw new OutboxSessionChangedError();
    });
    pending([OWN_ROW_ORG_A]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markHeld:1']);
  });
});

describe('drainQueue — adjust_stock: the same route as an online tap, AT MOST ONCE', () => {
  // What the item screen queued for a -1 made with no connection
  // (adjust-outbox.ts queuedAdjustPayload).
  const ADJUST: Row = {
    id: 9,
    kind: 'adjust_stock',
    idempotencyKey: 'k9',
    organizationId: 'org-a',
    userId: 'u1',
    payload: {
      itemId: 'item-1',
      quantityChange: -1,
      movementType: 'remove',
      reason: 'Mobile detail',
      notes: 'Queued offline on the phone at 2026-09-25T17:02:03.000Z (phone clock).',
      itemLabel: 'Polo S (POLO-S)',
    },
  };

  /** api() as far as the hand-off, then the given outcome. */
  function sendThen(outcome: () => unknown, handOff = true) {
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      if (handOff) opts?.onSend?.();
      return outcome();
    });
  }

  function lastErrorOf(id: number): string {
    const call = queueMock.markRejected.mock.calls.find((c) => c[0] === id);
    return String(call?.[1] ?? '');
  }

  it('POSTs the stored body to /api/v1/items/<id>/adjust under the row’s own org and account, then acks', async () => {
    live.orgId = 'org-b';
    sendThen(() => ({ ok: true, quantityOnHand: 3 }));
    pending([ADJUST]);

    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:9', 'api:/api/v1/items/item-1/adjust', 'markOk:9']);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/items/item-1/adjust', {
      method: 'POST',
      // Exactly the route's body: no item id, no label, and no idempotency
      // key (the route has none; nothing pretends otherwise).
      body: {
        quantityChange: -1,
        movementType: 'remove',
        reason: 'Mobile detail',
        notes: 'Queued offline on the phone at 2026-09-25T17:02:03.000Z (phone clock).',
      },
      orgId: 'org-a',
      asUserId: 'u1',
      onSend: expect.any(Function),
    });
  });

  it.each([400, 403, 409, 422])(
    'a %i refusal is TERMINAL: rejected with the item named, never retried',
    async (status) => {
      sendThen(() => {
        throw httpError(status, 'Missing permission: stock:adjust');
      });
      pending([ADJUST]);

      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
      expect(queueMock.markFailed).not.toHaveBeenCalled();
      expect(lastErrorOf(9)).toBe(
        '\u22121 to Polo S (POLO-S): Missing permission: stock:adjust. Nothing was changed.',
      );
    },
  );

  it('a 401 on a live account retries; on a disabled account it is rejected', async () => {
    sendThen(() => {
      throw httpError(401, 'unauthenticated');
    });
    pending([ADJUST]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });

    disabledMock.getAccountDisabled.mockReturnValue(true);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    // The route's 401 body is a bare { error: 'unauthenticated' }, which api()
    // turns into the message; Unsent work says it in words instead.
    expect(lastErrorOf(9)).toBe(
      '\u22121 to Polo S (POLO-S): This account was disabled when it was sent. Nothing was changed.',
    );
  });

  it('a 429 retries: the rate limit answers before the route writes', async () => {
    sendThen(() => {
      throw httpError(429, 'Too many requests');
    });
    pending([ADJUST]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('a 5xx after the hand-off is NOT retried: parked as not confirmed, so it can never apply twice', async () => {
    sendThen(() => {
      throw httpError(500, 'internal_error');
    });
    pending([ADJUST]);

    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(calls.log).toEqual([
      'markSending:9',
      'api:/api/v1/items/item-1/adjust',
      'markRejected:9',
    ]);
    expect(queueMock.markFailed).not.toHaveBeenCalled();
    expect(lastErrorOf(9)).toMatch(/^Not confirmed: \u22121 to Polo S \(POLO-S\) was sent/);
  });

  it('a network error AFTER the hand-off is parked as not confirmed', async () => {
    sendThen(() => {
      throw new Error('Network request failed');
    });
    pending([ADJUST]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(lastErrorOf(9)).toMatch(/may or may not have been saved/);
  });

  it('a failure BEFORE the hand-off retries: nothing left the phone', async () => {
    sendThen(() => {
      throw new Error('Network request failed');
    }, false);
    pending([ADJUST]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('the stored item id is only ever one path segment', async () => {
    sendThen(() => ({ ok: true }));
    pending([{ ...ADJUST, payload: { ...ADJUST.payload, itemId: '../../bundles/b1/distribute' } }]);
    await drainQueue();
    expect(apiMock.api.mock.calls[0]?.[0]).toBe(
      '/api/v1/items/..%2F..%2Fbundles%2Fb1%2Fdistribute/adjust',
    );
  });

  it('a malformed row is rejected without a request', async () => {
    pending([{ ...ADJUST, payload: { quantityChange: -1 } }]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it("another account's queued adjustment is held, and a session change at send time puts it back", async () => {
    live.userId = 'u2';
    pending([ADJUST]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual([]);

    live.userId = 'u1';
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw new OutboxSessionChangedError();
    });
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:9', 'api:/api/v1/items/item-1/adjust', 'markHeld:9']);
  });

  it('the other kinds keep their retry rule: a 5xx on a receipt is still retried', async () => {
    sendThen(() => {
      throw httpError(500);
    });
    pending([RECEIPT]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
  });
});

describe('drainQueue — one lost answer parks ONE adjustment, never the ones behind it', () => {
  const adjustRow = (id: number, itemId: string): Row => ({
    id,
    kind: 'adjust_stock',
    idempotencyKey: `k${id}`,
    organizationId: 'org-a',
    userId: 'u1',
    payload: {
      itemId,
      quantityChange: 1,
      movementType: 'add',
      reason: 'Mobile detail',
      itemLabel: `Item ${itemId}`,
    },
  });
  const ROWS = [adjustRow(21, 'i1'), adjustRow(22, 'i2'), adjustRow(23, 'i3')];

  /** The link drops after the hand-off: fetch fails with no answer. */
  function linkDropsAfterHandOff() {
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      throw new TypeError('Network request failed');
    });
  }

  it('the rows after a lost answer are never handed off in that pass: left pending, untouched', async () => {
    linkDropsAfterHandOff();
    pending(ROWS);

    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    // Only the first reached api(). The other two were never marked sending,
    // failed or rejected: the next pass sends them.
    expect(calls.log).toEqual(['markSending:21', 'api:/api/v1/items/i1/adjust', 'markRejected:21']);
    expect(apiMock.api).toHaveBeenCalledTimes(1);
  });

  it('a later pass sends none while the server has not answered since, and other kinds still go', async () => {
    linkDropsAfterHandOff();
    pending(ROWS);
    await drainQueue();

    calls.log = [];
    apiMock.api.mockReset().mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
    });
    // No pull answered in between (drainQueue called on its own): still closed.
    pending([ROWS[1]!, RECEIPT]);
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markOk:1']);
  });

  it('through syncNow: a pull with no answer keeps queued adjustments back; a pull with any answer lets them go', async () => {
    pending([ROWS[0]!]);
    // The pull fails with no answer (the link is down, the OS still says online).
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      if (path.startsWith('/api/v1/mobile/snapshot')) throw new TypeError('Network request failed');
      opts?.onSend?.();
      return { ok: true, quantityOnHand: 4 };
    });
    await syncNow();
    expect(calls.log).toEqual(['api:/api/v1/mobile/snapshot']);

    // The pull is answered, even with an error status: the round trip works.
    calls.log = [];
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      if (path.startsWith('/api/v1/mobile/snapshot')) throw httpError(500, 'internal_error');
      opts?.onSend?.();
      return { ok: true, quantityOnHand: 4 };
    });
    await syncNow();
    expect(calls.log).toEqual([
      'api:/api/v1/mobile/snapshot',
      'markSending:21',
      'api:/api/v1/items/i1/adjust',
      'markOk:21',
    ]);
  });

  it('at app start (no pull answered yet) no queued adjustment is handed off', async () => {
    adjustSendGate.resetForTests();
    pending([ROWS[0]!]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(calls.log).toEqual([]);
  });

  it('re-reads the network before each adjustment: offline at the row, it is not sent', async () => {
    // Online when the drain starts, offline by the time it reaches the row.
    netMock.getNetworkStateAsync
      .mockResolvedValueOnce({ isConnected: true, isInternetReachable: true })
      .mockResolvedValue({ isConnected: false, isInternetReachable: false });
    pending([ROWS[0]!, ROWS[1]!]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(calls.log).toEqual([]);
  });
});

describe('drainQueue — an adjustment parked "Not confirmed" labels the item it may still change', () => {
  const ROW: Row = {
    id: 31,
    kind: 'adjust_stock',
    idempotencyKey: 'k31',
    organizationId: 'org-a',
    userId: 'u1',
    payload: { itemId: 'item-9', quantityChange: 5, movementType: 'add', itemLabel: 'Tee M (TEE-M)' },
  };
  const HANDED_OFF_AT = 1_000_000;

  function answer(outcome: () => unknown) {
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      return outcome();
    });
  }

  it('records the doubt from the hand-off, BEFORE the row leaves the outbox, and a read then cannot clear it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(HANDED_OFF_AT);
    try {
      let seenAtPark: unknown = 'not called';
      queueMock.markRejected.mockImplementation(async (id: number) => {
        calls.log.push(`markRejected:${id}`);
        seenAtPark = unconfirmedStock.get('item-9');
      });
      answer(() => {
        throw new TypeError('Network request failed');
      });
      pending([ROW]);

      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
      const doubt = {
        expectedTotal: null,
        settlesAt: HANDED_OFF_AT + UNCONFIRMED_SETTLE_MS,
        mayStillLand: true,
      };
      // The item screen re-reads the item as soon as the row leaves the
      // outbox: the label must already be there.
      expect(seenAtPark).toEqual(doubt);
      // That read, sent right away, shows the old total: it cannot end a write
      // that may still be committing.
      unconfirmedStock.recordRead('item-9', 12, HANDED_OFF_AT + 1_000);
      expect(unconfirmedStock.get('item-9')).toEqual(doubt);
      // A read sent after the write can no longer land settles it.
      unconfirmedStock.recordRead('item-9', 12, HANDED_OFF_AT + UNCONFIRMED_SETTLE_MS);
      expect(unconfirmedStock.get('item-9')).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it('a 5xx after the hand-off labels it the same way', async () => {
    answer(() => {
      throw httpError(502, 'bad_gateway');
    });
    pending([ROW]);
    await drainQueue();
    expect(unconfirmedStock.get('item-9')?.mayStillLand).toBe(true);
  });

  it('a refusal, a retry before the hand-off and a success label nothing', async () => {
    answer(() => {
      throw httpError(403, 'Missing permission: stock:adjust');
    });
    pending([ROW]);
    await drainQueue();
    expect(unconfirmedStock.get('item-9')).toBeNull();

    apiMock.api.mockImplementation(async () => {
      throw new TypeError('Network request failed');
    });
    await drainQueue();
    expect(unconfirmedStock.get('item-9')).toBeNull();

    answer(() => ({ ok: true, quantityOnHand: 17 }));
    await drainQueue();
    expect(unconfirmedStock.get('item-9')).toBeNull();
  });

  it('the parked record says to wait out the window before checking', async () => {
    answer(() => {
      throw new TypeError('Network request failed');
    });
    pending([ROW]);
    await drainQueue();
    const call = queueMock.markRejected.mock.calls.find((c) => c[0] === 31);
    const lastError = String(call?.[1] ?? '');
    expect(lastError.startsWith(UNCONFIRMED_ADJUST_PREFIX)).toBe(true);
    expect(lastError).toContain(`within ${UNCONFIRMED_SETTLE_MS / 1000} seconds of being sent`);
  });
});

describe('sendOne carries no second copy of the record_count send (SP-099)', () => {
  /**
   * Source pin, because the branch it guards is UNREACHABLE by construction —
   * drainQueue `continue`s past record_count before sendOne is ever called, and
   * sendOne is not exported. That dead copy had already drifted from the live
   * sender in cycle-count-sync.ts (which coerces countedQuantity, rejects
   * non-finite/negative values and passes an AbortSignal, none of which the
   * dead copy did) — pattern #26: the next person to fix the record_count send
   * fixes one copy and ships nothing.
   */
  it('the dead branch is gone and the skip that made it dead is still there', () => {
    const src = readFileSync(path.resolve(__dirname, './sync.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/case 'record_count'/);
    expect(code).not.toMatch(/lines\/\$\{lineId\}\/record/);
    expect(code).toContain("if (action.kind === 'record_count') continue;");
  });
});
