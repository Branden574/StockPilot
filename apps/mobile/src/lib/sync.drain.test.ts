import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { drainQueue } from './sync';

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
}));
vi.mock('./queue', () => queueMock);

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => apiMock);

const disabledMock = vi.hoisted(() => ({ getAccountDisabled: vi.fn(() => false) }));
vi.mock('./account-disabled-state', () => disabledMock);

// db.ts / the meta-backed nav caches pull in expo-sqlite + React — none of the
// drain path touches them, so they are stubbed wholesale.
vi.mock('./db', () => ({
  getDb: vi.fn(),
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
  for (const name of ['markSending', 'markOk', 'markFailed', 'markRejected'] as const) {
    queueMock[name].mockReset().mockImplementation(async (id: number) => {
      calls.log.push(`${name}:${id}`);
    });
  }
  queueMock.listPending.mockReset();
  apiMock.api.mockReset().mockImplementation(async (path: string) => {
    calls.log.push(`api:${path}`);
  });
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
