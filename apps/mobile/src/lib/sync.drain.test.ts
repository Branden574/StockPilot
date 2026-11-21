import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody } from '@stockpilot/core';

import { adjustSendGate, UNCONFIRMED_ADJUST_PREFIX } from './adjust-outbox';
import { OutboxSessionChangedError } from './outbox-scope';
import {
  beginSetUpRead,
  keptRefusalCountForTests,
  noteServerReadUser,
  recordMembershipInputs,
  registerSetUpInputsSource,
  resetSetUpInputsForTests,
  setUpInputsReadInFlight,
} from './set-up-inputs';
import {
  drainQueue,
  pauseSyncForRestart,
  syncAfterRunning,
  syncNow,
  whenSyncSettled,
} from './sync';
import { noteHoldWorkspace, resetSetUpHoldForTests, setUpHoldIn } from './set-up-hold';
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
const live = vi.hoisted(() => ({
  orgId: 'org-live' as string | null,
  userId: 'u1' as string | null,
  /** The session still owes its authenticator code (docket S43b). */
  stepUpOwed: false,
}));
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
  // getMeta records no owner, so every pull here adopts: it clears the photo
  // caches, marks the cached rows unconfirmed and records the account before
  // it is sent (sync.ts). No clear is ever owed, so markPhotosCleared is
  // never reached; stubbed so the module's imports all resolve.
  setCacheOwner: vi.fn(async () => {}),
  markCacheUnconfirmed: vi.fn(async () => {}),
  markPhotosCleared: vi.fn(async () => {}),
}));
vi.mock('./enabled-modules', () => ({
  ENABLED_MODULES_META_KEY: 'enabled_modules',
  refreshEnabledModules: vi.fn(),
  rereadFailedEnabledModules: vi.fn(async () => undefined),
}));
vi.mock('./use-effective-permissions', () => ({
  EFFECTIVE_PERMISSIONS_META_KEY: 'effective_permissions',
  refreshEffectivePermissions: vi.fn(),
  rereadFailedEffectivePermissions: vi.fn(async () => undefined),
}));
vi.mock('./warehouse-scope', () => ({
  WAREHOUSE_SCOPE_META_KEY: 'warehouse_scope',
  refreshWarehouseScope: vi.fn(),
}));
// photo-cache-wipe.ts pulls in expo-image (native). The drain never resets the
// cache (getMeta records no owner), so the wipe is only passed through, and
// the adopt's photo clear does nothing; the reset and the adopt are tested in
// sync.snapshot-removals.test.ts and cache-owner.sqlite.test.ts.
vi.mock('./photo-cache-wipe', () => ({
  wipeWithPhotoCaches: async (wipe: () => Promise<void>) => {
    await wipe();
    return true;
  },
  clearPhotoCaches: async () => true,
}));

type Row = {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  organizationId?: string | null;
  userId?: string | null;
  attempts?: number;
  lastAttemptAt?: number | null;
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
  live.stepUpOwed = false;
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
  // The check a refusal asks for (set-up-inputs.ts): by default it finds
  // every workspace Optional, so a refusal is judged on its own after it.
  setUpReads.policies = { 'org-live': 'optional', 'org-a': 'optional', 'org-b': 'optional' };
  setUpReads.verified = false;
  setUpReads.count = 0;
  resetSetUpInputsForTests();
  void registerSetUpInputsSource({
    storage: { getAllKeys: async () => [], getItem: async () => null, setItem: async () => {} },
    read: async () => {
      setUpReads.count += 1;
      const at = beginSetUpRead();
      noteServerReadUser({ id: 'u1', factors: setUpReads.verified ? [{ status: 'verified' }] : [] }, at);
      recordMembershipInputs(
        'u1',
        Object.entries(setUpReads.policies).map(([organizationId, mfa_policy]) => ({
          organizationId,
          role: 'staff',
          organization: { name: organizationId, mfa_policy },
        })),
        at,
      );
    },
  });
});

/** What the check a kept refusal asks for reads: each workspace's policy, and the account's factors. */
const setUpReads: {
  policies: Record<string, 'optional' | 'admins_required' | 'all_required'>;
  verified: boolean;
  count: number;
} = { policies: {}, verified: false, count: 0 };

/** The check a kept refusal asked for has answered (and the next one may start). */
async function checkAnswered(): Promise<void> {
  await setUpInputsReadInFlight();
}

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

  it('a refusal (403) is kept for one check of the authenticator policy, then TERMINAL — markRejected, not another retry', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw httpError(403, 'forbidden');
    });
    pending([BUNDLE]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(calls.log).toEqual(['markSending:3', 'api:/api/v1/bundles/b1/distribute', 'markFailed:3']);
    await checkAnswered();
    expect(setUpReads.count).toBe(1);

    calls.log = [];
    const res = await drainQueue();
    expect(calls.log).toEqual([
      'markSending:3',
      'api:/api/v1/bundles/b1/distribute',
      'markRejected:3',
    ]);
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

  // docket B10, integrator decision 3: the live workspace is the account's
  // OWN saved one (null while it is not saved yet). A row with none of its own
  // used to be sent with that null, so api() sent no X-Organization-Id and the
  // server applied it in the account's default organization.
  it("a row with no workspace of its own is HELD while the account's own is unknown, then sent under it once saved", async () => {
    live.orgId = null;
    const ownBeforeAnySave: Row = { ...BUNDLE, organizationId: null, userId: 'u1' };
    pending([RECEIPT, ownBeforeAnySave]);

    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(apiMock.api).not.toHaveBeenCalled();
    // Left exactly as it was: not marked sending, failed or rejected (pending).
    expect(calls.log).toEqual([]);

    live.orgId = 'org-own'; // this account's workspace load saved its choice
    expect(await drainQueue()).toEqual({ ok: 2, failed: 0, rejected: 0 });
    expect(queueMock.markSending).toHaveBeenCalledWith(1, { orgId: 'org-own', userId: 'u1' });
    expect(queueMock.markSending).toHaveBeenCalledWith(3, { orgId: 'org-own', userId: 'u1' });
    expect(apiMock.api.mock.calls.map(([, opts]) => opts)).toEqual([
      expect.objectContaining({ orgId: 'org-own', asUserId: 'u1' }),
      expect.objectContaining({ orgId: 'org-own', asUserId: 'u1' }),
    ]);
  });

  it('a row with its own workspace is not held: it goes under that one while the live one is unknown', async () => {
    live.orgId = null;
    pending([OWN_ROW_ORG_A]);
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/v1/po/po1/receive-line',
      expect.objectContaining({ orgId: 'org-a', asUserId: 'u1' }),
    );
  });

  // The workspace load asks for this pass once it has saved the account's
  // workspace, unless it also clears the cache: its forced full pull then
  // does the same (use-workspace.ts). syncNow() would JOIN a sync already
  // running, whose drain may already have passed the held row; this one
  // starts after it.
  it('syncAfterRunning: a pass asked for during a running sync starts after it, so the row that sync held goes out', async () => {
    live.orgId = null;
    const held: Row = { ...BUNDLE, organizationId: null, userId: 'u1' };
    queueMock.listPending.mockResolvedValueOnce([held, OWN_ROW_ORG_A]).mockResolvedValue([held]);
    let releaseReceipt!: () => void;
    const receiptAnswer = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    apiMock.api.mockImplementation(async (path: string, opts?: { orgId?: string | null }) => {
      calls.log.push(`api:${path}@${opts?.orgId ?? 'none'}`);
      // The pull is answered (an error status still opens the send gate).
      if (path.startsWith('/api/v1/mobile/snapshot')) throw httpError(500, 'internal_error');
      if (path === '/api/v1/po/po1/receive-line') await receiptAnswer;
    });

    const running = syncNow();
    try {
      // The running drain has passed the held row and is sending the receipt.
      await vi.waitFor(() => expect(calls.log).toContain('api:/api/v1/po/po1/receive-line@org-a'));
      expect(calls.log).not.toContain('markSending:3');
      live.orgId = 'org-own'; // the workspace load saved this account's workspace
      const after = syncAfterRunning();
      releaseReceipt();
      await Promise.all([running, after]);
    } finally {
      // Never leave a sync running for the tests after this one.
      releaseReceipt();
      await running;
    }

    expect(calls.log.filter((l) => l.startsWith('api:/api/v1/bundles/'))).toEqual([
      'api:/api/v1/bundles/b1/distribute@org-own',
    ]);
    expect(queueMock.markSending).toHaveBeenCalledWith(3, { orgId: 'org-own', userId: 'u1' });
  });

  it('syncAfterRunning with no sync running starts one at once', async () => {
    pending([OWN_ROW_ORG_A]);
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (path.startsWith('/api/v1/mobile/snapshot')) throw httpError(500, 'internal_error');
    });
    await syncAfterRunning();
    expect(calls.log).toContain('api:/api/v1/po/po1/receive-line');
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

/**
 * docket S43b. A session that still owes its authenticator code is a password
 * and nothing more: the sync neither reads for it nor sends under it. Queued
 * work is left exactly as it is (not failed, not rejected, not stamped) and
 * goes out at the first sync after the code.
 */
describe('a session that still owes its authenticator code: no pull, no send, nothing marked', () => {
  const ADJUST: Row = {
    id: 31,
    kind: 'adjust_stock',
    idempotencyKey: 'k31',
    payload: { itemId: 'i1', body: { delta: 1 } },
    organizationId: 'org-a',
    userId: 'u1',
  };
  const OWN: Row = { ...RECEIPT, organizationId: 'org-a', userId: 'u1' };
  const LEGACY: Row = { ...BUNDLE, organizationId: null, userId: null };

  it('drainQueue holds every row: own, legacy and an adjustment alike', async () => {
    live.stepUpOwed = true;
    pending([OWN, LEGACY, ADJUST]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(calls.log).toEqual([]);
  });

  it('through syncNow: the snapshot is not asked for and nothing is sent', async () => {
    live.stepUpOwed = true;
    pending([OWN]);
    await syncNow();
    expect(apiMock.api).not.toHaveBeenCalled();
    expect(calls.log).toEqual([]);
  });

  it('the code is entered between two rows of one drain: the first is held, the second goes', async () => {
    const second: Row = { ...BUNDLE, organizationId: 'org-a', userId: 'u1' };
    pending([OWN, second]);
    scopeMock.liveOutboxScope
      .mockImplementationOnce(async () => ({ ...live, stepUpOwed: true }))
      .mockImplementation(async () => ({ ...live }));
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:3', 'api:/api/v1/bundles/b1/distribute', 'markOk:3']);
  });

  it('after the code, the same sync pulls and then sends what was held', async () => {
    live.stepUpOwed = true;
    pending([OWN]);
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      // Any answer to the pull lets the drain go on (an error status too).
      if (path.startsWith('/api/v1/mobile/snapshot')) throw httpError(500, 'internal_error');
    });
    await syncNow();
    expect(calls.log).toEqual([]);

    live.stepUpOwed = false;
    await syncNow();
    expect(calls.log).toEqual([
      'api:/api/v1/mobile/snapshot',
      'markSending:1',
      'api:/api/v1/po/po1/receive-line',
      'markOk:1',
    ]);
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

      if (status === 403) {
        // Kept for one check of the authenticator policy first.
        expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
        expect(queueMock.markRejected).not.toHaveBeenCalled();
        await checkAnswered();
        queueMock.markFailed.mockClear();
      }
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

describe('drainQueue — refused before any write: the adjustment stays queued, and its own later ones wait (S26)', () => {
  // The server could not check this account's access in organization A and
  // refused before doing anything: a 503 marked as written-nothing (core
  // contextUnavailableBody, sent only by the API context gate). The row is
  // provably not written, so it stays queued, and the next pass sends it
  // first among its own. Adjustments queued after it by the same account in
  // the same organization are not sent past it in this pass, so they still
  // land in the order they were made. Another organization's adjustments, and
  // every other kind, go as before: the refusal is about one context.
  const adjust = (id: number, org: string, itemId: string): Row => ({
    id,
    kind: 'adjust_stock',
    idempotencyKey: `k${id}`,
    organizationId: org,
    userId: 'u1',
    payload: { itemId, quantityChange: -1, movementType: 'remove', itemLabel: `Item ${itemId}` },
  });
  const A1 = adjust(41, 'org-a', 'a1');
  const A2 = adjust(42, 'org-a', 'a2');
  const B1 = adjust(43, 'org-b', 'b1');
  const R: Row = { ...RECEIPT, id: 44, organizationId: 'org-a', userId: 'u1' };

  function marker() {
    const body = contextUnavailableBody();
    return Object.assign(new Error(body.message), {
      name: 'ApiError',
      status: 503,
      code: body.error,
      details: { ...body.details },
    });
  }

  /** api() to the hand-off; A1's item answers the marker while `refused`, every other request lands. */
  function serve(state: { refused: boolean }) {
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      if (state.refused && path === '/api/v1/items/a1/adjust') throw marker();
      return { ok: true, quantityOnHand: 4 };
    });
  }

  it('keeps the refused row (failed, never rejected), sends no later adjustment of its scope, and the rest go', async () => {
    serve({ refused: true });
    pending([A1, A2, B1, R]);

    expect(await drainQueue()).toEqual({ ok: 2, failed: 1, rejected: 0 });
    expect(calls.log).toEqual([
      'markSending:41',
      'api:/api/v1/items/a1/adjust',
      'markFailed:41',
      // A2 is skipped: not marked sending, not sent, not failed.
      'markSending:43',
      'api:/api/v1/items/b1/adjust',
      'markOk:43',
      'markSending:44',
      'api:/api/v1/po/po1/receive-line',
      'markOk:44',
    ]);
    expect(queueMock.markRejected).not.toHaveBeenCalled();
    // Nothing is in doubt, and the server did answer: the send gate stays open.
    expect(unconfirmedStock.get('a1')).toBeNull();
    expect(adjustSendGate.canSend()).toBe(true);
    expect(queueMock.markFailed).toHaveBeenCalledWith(41, contextUnavailableBody().message);
  });

  it('the next pass sends the refused row first, then the one behind it; while still refused, the one behind waits again', async () => {
    const state = { refused: true };
    serve(state);
    pending([A1, A2, B1, R]);
    await drainQueue();

    // Still refused: the same again, no backoff, nothing parked.
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 2, failed: 1, rejected: 0 });
    expect(calls.log.filter((c) => c.endsWith(':42') || c.includes('/a2/'))).toEqual([]);

    // The check works again: A1, then A2, in the order they were made.
    calls.log = [];
    state.refused = false;
    expect(await drainQueue()).toEqual({ ok: 4, failed: 0, rejected: 0 });
    const sent = calls.log.filter((c) => c.startsWith('api:'));
    expect(sent.indexOf('api:/api/v1/items/a1/adjust')).toBeLessThan(
      sent.indexOf('api:/api/v1/items/a2/adjust'),
    );
    expect(sent).toEqual([
      'api:/api/v1/items/a1/adjust',
      'api:/api/v1/items/a2/adjust',
      'api:/api/v1/items/b1/adjust',
      'api:/api/v1/po/po1/receive-line',
    ]);
  });

  it('the scope is the organization AND the account: after a switch mid-pass, the next account’s adjustments there go', async () => {
    // The drain reads whose rows it may send per row (outbox-scope.ts): a
    // sign-in as another account can land between two rows of one pass. The
    // refusal was about u1 in org-a; u2's adjustment in org-a is not held.
    const U2_A = { ...adjust(45, 'org-a', 'c1'), userId: 'u2' };
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      if (path === '/api/v1/items/a1/adjust') {
        live.userId = 'u2';
        throw marker();
      }
      return { ok: true, quantityOnHand: 4 };
    });
    pending([A1, U2_A]);

    expect(await drainQueue()).toEqual({ ok: 1, failed: 1, rejected: 0 });
    expect(calls.log).toEqual([
      'markSending:41',
      'api:/api/v1/items/a1/adjust',
      'markFailed:41',
      'markSending:45',
      'api:/api/v1/items/c1/adjust',
      'markOk:45',
    ]);
  });

  // Restart now (the phone update pop-up, pauseSyncForRestart) and a held
  // scope in one pass. The refused row's answer has already come, so it is
  // recorded as any refusal is; after it nothing is handed off: the one behind
  // it in its scope is held, and the pause stops the drain before every other
  // row. None of them is marked sending, failed, rejected or held.
  it('Restart now while a scope is held: nothing more is sent, and every other row is left as it was', async () => {
    const state = { refused: true };
    const paused: { resume?: () => void } = {};
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      if (state.refused && path === '/api/v1/items/a1/adjust') {
        // The pop-up's Restart now lands while the refused request is in flight.
        paused.resume ??= pauseSyncForRestart();
        throw marker();
      }
      return { ok: true, quantityOnHand: 4 };
    });
    pending([A1, A2, B1, R]);
    try {
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
      expect(calls.log).toEqual(['markSending:41', 'api:/api/v1/items/a1/adjust', 'markFailed:41']);
      expect(queueMock.markSending).toHaveBeenCalledTimes(1);
      expect(queueMock.markRejected).not.toHaveBeenCalled();
      expect(queueMock.markHeld).not.toHaveBeenCalled();
      expect(unconfirmedStock.get('a1')).toBeNull();
      expect(adjustSendGate.canSend()).toBe(true);

      // A pass that starts while Restart now still waits: not one row is
      // touched, the refused one included.
      calls.log = [];
      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
      expect(calls.log).toEqual([]);
      expect(apiMock.api).toHaveBeenCalledTimes(1);
    } finally {
      paused.resume?.();
    }

    // The restart did not happen and the check works again: the next pass
    // sends everything, the refused row first among its own.
    calls.log = [];
    state.refused = false;
    expect(await drainQueue()).toEqual({ ok: 4, failed: 0, rejected: 0 });
    expect(calls.log.filter((c) => c.startsWith('api:'))).toEqual([
      'api:/api/v1/items/a1/adjust',
      'api:/api/v1/items/a2/adjust',
      'api:/api/v1/items/b1/adjust',
      'api:/api/v1/po/po1/receive-line',
    ]);
  });

  it('Restart now waiting before a pass whose scope would be held: the pass sends nothing', async () => {
    serve({ refused: true });
    pending([A1, A2, B1, R]);
    const resume = pauseSyncForRestart();
    try {
      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
      expect(apiMock.api).not.toHaveBeenCalled();
      expect(calls.log).toEqual([]);
      expect(adjustSendGate.canSend()).toBe(true);
    } finally {
      resume();
    }
    // After the resume the pass runs as it does without a restart waiting.
    expect(await drainQueue()).toEqual({ ok: 2, failed: 1, rejected: 0 });
    expect(calls.log.filter((c) => c.endsWith(':42') || c.includes('/a2/'))).toEqual([]);
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

describe('Restart now pauses the drain (B44)', () => {
  const RECEIPT_2: Row = {
    id: 4,
    kind: 'receive_po_line',
    idempotencyKey: 'k4',
    payload: { poId: 'po1', lineId: 'l2', quantity: 1 },
  };

  /** Lets the pull and the drain run until `done` holds (bounded). */
  async function until(done: () => boolean) {
    for (let i = 0; i < 50 && !done(); i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  it('stops before the next row: paused while the first of three is in flight, one is sent', async () => {
    const paused: { resume?: () => void } = {};
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      paused.resume ??= pauseSyncForRestart();
    });
    pending([RECEIPT, BUNDLE, RECEIPT_2]);
    try {
      expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
      // The rows behind it are left exactly as they were, for the next drain.
      expect(queueMock.markSending).toHaveBeenCalledTimes(1);
      expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markOk:1']);
    } finally {
      paused.resume?.();
    }
  });

  it('whenSyncSettled waits for the sync running now to end', async () => {
    let answerPull!: () => void;
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (path.startsWith('/api/v1/mobile/snapshot')) {
        await new Promise<void>((resolve) => {
          answerPull = resolve;
        });
        throw httpError(500, 'internal_error');
      }
    });
    pending([RECEIPT]);
    const sync = syncNow();
    let settled = false;
    const settling = whenSyncSettled().then(() => {
      settled = true;
    });
    await until(() => calls.log.length > 0);
    expect(calls.log).toEqual(['api:/api/v1/mobile/snapshot']);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    answerPull();
    await sync;
    await settling;
    expect(settled).toBe(true);
    // The drain behind the pull had ended too.
    expect(calls.log).toContain('markOk:1');
    await expect(whenSyncSettled()).resolves.toBeUndefined();
  });

  it('whenSyncSettled waits for a sync asked for behind the running one', async () => {
    const answers: (() => void)[] = [];
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (path.startsWith('/api/v1/mobile/snapshot')) {
        await new Promise<void>((resolve) => answers.push(resolve));
        throw httpError(500, 'internal_error');
      }
    });
    pending([]);
    const first = syncNow();
    // Waiting already when the next sync is asked for: it must wait for that one too.
    let settled = false;
    const settling = whenSyncSettled().then(() => {
      settled = true;
    });
    const behind = syncAfterRunning();
    await until(() => answers.length === 1);
    answers[0]!();
    await first;
    await until(() => answers.length === 2);
    expect(settled).toBe(false);
    answers[1]!();
    await behind;
    await settling;
    expect(settled).toBe(true);
  });

  it('syncNow does nothing while paused, and runs again after the resume', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      // An answered pull (even an error) lets the drain behind it run.
      if (path.startsWith('/api/v1/mobile/snapshot')) throw httpError(500, 'internal_error');
    });
    pending([RECEIPT]);
    const resume = pauseSyncForRestart();
    try {
      await syncNow();
      expect(apiMock.api).not.toHaveBeenCalled();
      expect(queueMock.listPending).not.toHaveBeenCalled();
    } finally {
      resume();
    }
    await syncNow();
    expect(calls.log).toContain('markSending:1');
  });
});

/**
 * Authenticator set-up (set-up-inputs.ts, drain-failure.ts). The server
 * refuses a queued change with 403 while the workspace's policy requires an
 * authenticator the account has not set up. The row is never parked for it:
 * it is kept, held while its own workspace owes set-up, and sent once after.
 */
describe('drainQueue — a queued change waits while an authenticator is being set up', () => {
  const SET_UP_SENTENCE =
    'Multi-factor authentication required. Enroll in MFA before performing this action.';
  /** The refusal as api() throws it, with or without the reason in details. */
  function setUpRefusal(withDetails: boolean): Error {
    return Object.assign(new Error(SET_UP_SENTENCE), {
      status: 403,
      code: 'forbidden',
      ...(withDetails ? { details: { reason: 'mfa_required' } } : {}),
    });
  }
  const OWN_RECEIPT: Row = { ...RECEIPT, organizationId: 'org-a', userId: 'u1' };

  /** The receipt route refuses while set-up is owed; any other path answers. */
  function receiptRefusedUntilSetUp(withDetails: boolean) {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (path.includes('receive-line') && !setUpReads.verified) throw setUpRefusal(withDetails);
    });
  }

  it.each([
    ['with the reason in details', true],
    ['from a route that sends no details', false],
  ])('%s: kept, then held, then sent once after set-up', async (_name, withDetails) => {
    setUpReads.policies['org-a'] = 'all_required';
    receiptRefusedUntilSetUp(withDetails);
    pending([OWN_RECEIPT]);

    // First send: refused, kept (never rejected), and a check is asked for.
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markFailed:1']);
    await checkAnswered();

    // The check finds set-up owed in the row's own workspace: held, untouched.
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual([]);

    // The account sets up an authenticator; the next server read shows it.
    setUpReads.verified = true;
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markOk:1']);
    // Sent with its own key every time, so the server applies it once.
    const sends = apiMock.api.mock.calls.filter(([p]) => String(p).includes('receive-line'));
    expect(sends).toHaveLength(2);
    for (const [, opts] of sends) {
      expect(opts).toMatchObject({ body: { idempotencyKey: 'k1' }, orgId: 'org-a', asUserId: 'u1' });
    }
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('the authenticator answer is never final, even when the check finds nothing owed', async () => {
    // The server's own policy read can fail and hold the member to the
    // strictest policy; the phone's read says Optional.
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw setUpRefusal(true);
    });
    pending([OWN_RECEIPT]);
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
      await checkAnswered();
    }
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('403 with no details.reason, the row\'s workspace missing from the read: kept on every pass, never parked', async () => {
    // The check reads this account's memberships, and the row's workspace is
    // not among them (a partial read, or a membership the read did not
    // return). That is not evidence that nothing is owed there.
    delete setUpReads.policies['org-a'];
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw setUpRefusal(false);
    });
    pending([OWN_RECEIPT]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        calls.log = [];
        expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
        expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markFailed:1']);
        await checkAnswered();
        // The next pass comes a minute later, past the read interval.
        now.mockReturnValue(1_000_000 + (pass + 1) * 60_000);
      }
      expect(setUpReads.count).toBe(3);
    } finally {
      now.mockRestore();
    }
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('per row: after one row is kept then parked, a later row\'s first 403 with no reason is kept, not parked', async () => {
    const ROW_A: Row = { ...BUNDLE, organizationId: 'org-a', userId: 'u1' };
    const ROW_B: Row = { ...RECEIPT, id: 7, idempotencyKey: 'k7', organizationId: 'org-a', userId: 'u1' };
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw httpError(403, 'Missing permission: stock:receive');
    });
    // Row A: kept, read (org-a Optional), then parked on its second 403.
    pending([ROW_A]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    await checkAnswered();
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(queueMock.markRejected).toHaveBeenCalledTimes(1);

    // Row B, later in the same run, same workspace: that read started before
    // B's refusal, so B's first refusal is kept.
    pending([ROW_B]);
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(calls.log).toEqual(['markSending:7', 'api:/api/v1/po/po1/receive-line', 'markFailed:7']);
    expect(queueMock.markRejected).toHaveBeenCalledTimes(1);
  });

  it('many rows kept in one pass ask for one read; the next read waits out the interval', async () => {
    const rows: Row[] = [1, 2, 3, 4].map((id) => ({
      ...RECEIPT,
      id,
      idempotencyKey: `k${id}`,
      organizationId: 'org-a',
      userId: 'u1',
    }));
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw setUpRefusal(true);
    });
    pending(rows);
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      expect(await drainQueue()).toEqual({ ok: 0, failed: 4, rejected: 0 });
      await checkAnswered();
      expect(setUpReads.count).toBe(1);
      // A pass within the interval asks for none.
      now.mockReturnValue(2_000_000 + 10_000);
      await drainQueue();
      await checkAnswered();
      expect(setUpReads.count).toBe(1);
      // Past it: one more, however many rows are kept.
      now.mockReturnValue(2_000_000 + 60_000);
      await drainQueue();
      await checkAnswered();
      expect(setUpReads.count).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('a queued hand-out refused 403 module_disabled with no details.reason is final at once, with no check', async () => {
    const OWN_BUNDLE: Row = { ...BUNDLE, organizationId: 'org-a', userId: 'u1' };
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw Object.assign(new Error('Module not enabled for this organization: bundles'), {
        status: 403,
        code: 'module_disabled',
      });
    });
    pending([OWN_BUNDLE]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(calls.log).toEqual(['markSending:3', 'api:/api/v1/bundles/b1/distribute', 'markRejected:3']);
    await checkAnswered();
    expect(setUpReads.count).toBe(0);
  });

  it('a key queued again after its row was acked starts with no mark: its first 403 with no reason is kept', async () => {
    // The kit screen keeps one key per request shape and can queue it again.
    const KIT: Row = { ...BUNDLE, organizationId: 'org-a', userId: 'u1' };
    let refuse = true;
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (refuse) throw httpError(403, 'Missing permission: bundles:distribute');
    });
    pending([KIT]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    await checkAnswered();
    expect(keptRefusalCountForTests()).toBe(1);
    refuse = false;
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(keptRefusalCountForTests()).toBe(0);

    // The same key, a new row (the acked one was deleted), refused with no reason.
    refuse = true;
    pending([{ ...KIT, id: 8 }]);
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(calls.log).toEqual(['markSending:8', 'api:/api/v1/bundles/b1/distribute', 'markFailed:8']);
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('the marks are empty after a kept row is parked', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw httpError(403, 'Missing permission: stock:receive');
    });
    pending([OWN_RECEIPT]);
    await drainQueue();
    await checkAnswered();
    expect(keptRefusalCountForTests()).toBe(1);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(keptRefusalCountForTests()).toBe(0);
  });

  it('a kept adjustment that is parked takes its mark with it', async () => {
    const ADJ: Row = {
      id: 51,
      kind: 'adjust_stock',
      idempotencyKey: 'k51',
      organizationId: 'org-a',
      userId: 'u1',
      payload: { itemId: 'item-1', quantityChange: 1, itemLabel: 'Polo S (POLO-S)' },
    };
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      throw httpError(403, 'Missing permission: stock:adjust');
    });
    pending([ADJ]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    await checkAnswered();
    expect(keptRefusalCountForTests()).toBe(1);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(keptRefusalCountForTests()).toBe(0);
  });

  it('a kept row is sent again only once its backoff has passed, at most once per 5 minutes', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw setUpRefusal(true);
    });
    const t0 = 3_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      pending([{ ...OWN_RECEIPT, attempts: 0, lastAttemptAt: null }]);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
      // Kept: 3 attempts, the last one at t0; 2^3 s = 8 s to wait.
      pending([{ ...OWN_RECEIPT, attempts: 3, lastAttemptAt: t0 }]);
      calls.log = [];
      now.mockReturnValue(t0 + 7_999);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
      expect(calls.log).toEqual([]);
      now.mockReturnValue(t0 + 8_000);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
      // Many attempts: the wait stops growing at 5 minutes.
      pending([{ ...OWN_RECEIPT, attempts: 40, lastAttemptAt: t0 }]);
      calls.log = [];
      now.mockReturnValue(t0 + 5 * 60_000 - 1);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
      expect(calls.log).toEqual([]);
      now.mockReturnValue(t0 + 5 * 60_000);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    } finally {
      now.mockRestore();
    }
  });

  it('a kept adjustment waiting out its backoff holds the later adjustments of its workspace', async () => {
    const ADJ = (id: number, extra: Partial<Row> = {}): Row => ({
      id,
      kind: 'adjust_stock',
      idempotencyKey: `k${id}`,
      organizationId: 'org-a',
      userId: 'u1',
      payload: { itemId: 'item-1', quantityChange: 1, itemLabel: 'Polo S (POLO-S)' },
      ...extra,
    });
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      throw setUpRefusal(true);
    });
    const t0 = 4_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      pending([ADJ(41)]);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
      pending([ADJ(41, { attempts: 2, lastAttemptAt: t0 }), ADJ(42)]);
      calls.log = [];
      now.mockReturnValue(t0 + 1_000);
      expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
      expect(calls.log).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it('a row never kept is sent every pass, as the backoff is only for kept rows', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw httpError(500);
    });
    pending([{ ...OWN_RECEIPT, attempts: 9, lastAttemptAt: Date.now() }]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
  });

  it('a reader that throws as it is called cannot leave the row "sending": it is marked failed', async () => {
    resetSetUpInputsForTests();
    void registerSetUpInputsSource({
      storage: { getAllKeys: async () => [], getItem: async () => null, setItem: async () => {} },
      read: (): Promise<void> => {
        throw new Error('not ready');
      },
    });
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw setUpRefusal(true);
    });
    pending([OWN_RECEIPT]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markFailed:1']);
  });

  it('a 403 whose code is the authenticator answer, with no details, is kept even when the check says clear', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw Object.assign(new Error(SET_UP_SENTENCE), { status: 403, code: 'mfa_required' });
    });
    pending([OWN_RECEIPT]);
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
      await checkAnswered();
    }
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('a 403 that names another reason is final at once, without a check', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw Object.assign(new Error('This line is assigned to someone else.'), {
        status: 403,
        code: 'forbidden',
        details: { reason: 'assigned_elsewhere' },
      });
    });
    pending([OWN_RECEIPT]);
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 1 });
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markRejected:1']);
    await checkAnswered();
    expect(setUpReads.count).toBe(0);
  });

  it('a policy turned on after a check said clear: the next refusal is kept, never parked', async () => {
    // Read earlier this run: Optional.
    recordMembershipInputs(
      'u1',
      [{ organizationId: 'org-a', role: 'staff', organization: { name: 'A', mfa_policy: 'optional' } }],
      beginSetUpRead(),
    );
    noteServerReadUser({ id: 'u1', factors: [] });
    // Then turned on; the route sends no details.
    setUpReads.policies['org-a'] = 'all_required';
    receiptRefusedUntilSetUp(false);
    pending([OWN_RECEIPT]);

    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    await checkAnswered();
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual([]);
    expect(queueMock.markRejected).not.toHaveBeenCalled();
  });

  it('held per row by its own workspace: the Optional one is sent, the requiring one waits', async () => {
    recordMembershipInputs(
      'u1',
      [
        { organizationId: 'org-a', role: 'staff', organization: { name: 'A', mfa_policy: 'all_required' } },
        { organizationId: 'org-b', role: 'staff', organization: { name: 'B', mfa_policy: 'optional' } },
      ],
      beginSetUpRead(),
    );
    noteServerReadUser({ id: 'u1', factors: [] });
    live.orgId = 'org-b';
    const OPTIONAL_ROW: Row = { ...BUNDLE, organizationId: 'org-b', userId: 'u1' };
    pending([OWN_RECEIPT, OPTIONAL_ROW]);
    expect(await drainQueue()).toEqual({ ok: 1, failed: 0, rejected: 0 });
    expect(calls.log).toEqual(['markSending:3', 'api:/api/v1/bundles/b1/distribute', 'markOk:3']);
  });

  it('a queued adjustment refused for set-up is kept, not parked "Not confirmed", and the ones behind it wait', async () => {
    setUpReads.policies['org-a'] = 'all_required';
    const ADJ = (id: number): Row => ({
      id,
      kind: 'adjust_stock',
      idempotencyKey: `k${id}`,
      organizationId: 'org-a',
      userId: 'u1',
      payload: { itemId: 'item-1', quantityChange: 1, itemLabel: 'Polo S (POLO-S)' },
    });
    apiMock.api.mockImplementation(async (path: string, opts?: { onSend?: () => void }) => {
      calls.log.push(`api:${path}`);
      opts?.onSend?.();
      throw setUpRefusal(true);
    });
    pending([ADJ(41), ADJ(42)]);

    expect(await drainQueue()).toEqual({ ok: 0, failed: 1, rejected: 0 });
    // The first is kept; the second is not handed off in this pass.
    expect(calls.log).toEqual(['markSending:41', 'api:/api/v1/items/item-1/adjust', 'markFailed:41']);
    expect(queueMock.markRejected).not.toHaveBeenCalled();
    expect(unconfirmedStock.get('item-1')).toBeNull();
    await checkAnswered();

    // Then both are held while set-up is owed.
    calls.log = [];
    expect(await drainQueue()).toEqual({ ok: 0, failed: 0, rejected: 0 });
    expect(calls.log).toEqual([]);
  });
});

/**
 * The authenticator set-up hold (set-up-hold.ts): no snapshot pull runs while
 * it is up, whoever asks (a workspace switch, a sign-out), and the drain that
 * follows keeps its per-row rule: rows of the held workspace wait, rows of
 * another workspace are sent as usual.
 */
describe('syncNow while the authenticator set-up hold is up', () => {
  const HELD: Row = { ...RECEIPT, organizationId: 'org-a', userId: 'u1' };
  const ELSEWHERE: Row = { ...BUNDLE, organizationId: 'org-b', userId: 'u1' };

  function heldInOrgA() {
    recordMembershipInputs(
      'u1',
      [
        { organizationId: 'org-a', role: 'staff', organization: { name: 'A', mfa_policy: 'all_required' } },
        { organizationId: 'org-b', role: 'staff', organization: { name: 'B', mfa_policy: 'optional' } },
      ],
      beginSetUpRead(),
    );
    noteServerReadUser({ id: 'u1', factors: [] });
    noteHoldWorkspace('u1', 'org-a');
  }

  it("no snapshot is asked for; the held workspace's row waits, the other workspace's is sent", async () => {
    resetSetUpHoldForTests();
    heldInOrgA();
    pending([HELD, ELSEWHERE]);
    await syncNow(true);
    expect(calls.log).toEqual(['markSending:3', 'api:/api/v1/bundles/b1/distribute', 'markOk:3']);
    resetSetUpHoldForTests();
  });

  it("the could-not-check hold too: no snapshot is asked for, and the held workspace's row is tried", async () => {
    resetSetUpHoldForTests();
    // Answered this run with the organization's row unreadable.
    recordMembershipInputs(
      'u1',
      [{ organizationId: 'org-a', role: 'staff', organization: null }],
      beginSetUpRead(),
    );
    noteServerReadUser({ id: 'u1', factors: [] });
    noteHoldWorkspace('u1', 'org-a');
    expect(setUpHoldIn('u1')).toBe('unknown');
    pending([HELD]);
    await syncNow(true);
    expect(calls.log).toEqual(['markSending:1', 'api:/api/v1/po/po1/receive-line', 'markOk:1']);
    resetSetUpHoldForTests();
  });

  it('once released, the same sync pulls first and then sends what waited', async () => {
    resetSetUpHoldForTests();
    heldInOrgA();
    pending([HELD]);
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      if (path.startsWith('/api/v1/mobile/snapshot')) throw httpError(500, 'internal_error');
    });
    await syncNow();
    expect(calls.log).toEqual([]);
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
    await syncNow();
    expect(calls.log).toEqual([
      'api:/api/v1/mobile/snapshot',
      'markSending:1',
      'api:/api/v1/po/po1/receive-line',
      'markOk:1',
    ]);
    resetSetUpHoldForTests();
  });
});
