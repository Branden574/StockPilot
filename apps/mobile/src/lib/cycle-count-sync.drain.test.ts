import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cycleCountSync } from './cycle-count-sync';
import { OutboxSessionChangedError, REPLACED_BY_LATER_COUNT } from './outbox-scope';

/**
 * The cycle-count drain (engine 2), EXECUTED — the twin of sync.drain.test.ts.
 *
 * S4a: both drains send each row under the organization it was queued in, and
 * only while the live session is the account that queued it, checked before
 * EACH send. The same predicate (outbox-scope.ts outboxSendDecision) serves
 * both engines; this file proves engine 2 actually applies it.
 *
 * Only the engine's collaborators are faked (the SQLite cache, api(), the
 * network, the session); the engine's own loop runs as shipped.
 */

vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

const netMock = vi.hoisted(() => ({
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
  addNetworkStateListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('expo-network', () => netMock);

const calls = vi.hoisted(() => ({ log: [] as string[] }));

type Row = {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastAttemptAt: number | null;
  status: string;
  organizationId: string | null;
  userId: string | null;
  /** Backoff elapsed (cycle-count-cache outboxQueued). */
  due: boolean;
};

const cacheMock = vi.hoisted(() => ({
  rows: [] as unknown[],
  outboxQueued: vi.fn(),
  outboxAck: vi.fn(),
  outboxBumpFailure: vi.fn(),
  outboxMarkSending: vi.fn(),
  outboxReject: vi.fn(),
  totalPendingCount: vi.fn(async () => 1),
}));
vi.mock('./cycle-count-cache', () => cacheMock);

const queueMock = vi.hoisted(() => ({
  countRejected: vi.fn(async () => 0),
  markHeld: vi.fn(),
}));
vi.mock('./queue', () => queueMock);

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => apiMock);

vi.mock('./account-disabled-state', () => ({ getAccountDisabled: () => false }));

const live = vi.hoisted(() => ({
  orgId: 'org-live' as string | null,
  userId: 'u1' as string | null,
}));
vi.mock('./session-scope', () => ({ liveOutboxScope: vi.fn(async () => ({ ...live })) }));

function countRow(
  id: number,
  lineId: string,
  owner: { org: string | null; user: string | null },
): Row {
  return {
    id,
    kind: 'record_count',
    idempotencyKey: `k${id}`,
    payload: { cycleCountId: 'cc1', lineId, countedQuantity: 5 },
    attempts: 0,
    lastAttemptAt: null,
    status: 'pending',
    organizationId: owner.org,
    userId: owner.user,
    due: true,
  };
}

beforeEach(() => {
  calls.log = [];
  live.orgId = 'org-live';
  live.userId = 'u1';
  cacheMock.outboxQueued.mockReset().mockImplementation(async () => cacheMock.rows);
  for (const name of [
    'outboxAck',
    'outboxBumpFailure',
    'outboxMarkSending',
    'outboxReject',
  ] as const) {
    cacheMock[name].mockReset().mockImplementation(async (id: number) => {
      calls.log.push(`${name}:${id}`);
    });
  }
  queueMock.markHeld.mockReset().mockImplementation(async (id: number) => {
    calls.log.push(`markHeld:${id}`);
  });
  apiMock.api.mockReset().mockImplementation(async (path: string) => {
    calls.log.push(`api:${path}`);
  });
});

const recordPath = (lineId: string) => `/api/v1/cycle-counts/cc1/lines/${lineId}/record`;

describe('CycleCountSyncEngine drain — own org, own account, per row (S4a)', () => {
  it('a row queued in org A is sent with org A while org B is the active workspace', async () => {
    live.orgId = 'org-b';
    cacheMock.rows = [countRow(1, 'l1', { org: 'org-a', user: 'u1' })];

    await cycleCountSync.forceSync();

    expect(apiMock.api).toHaveBeenCalledWith(
      recordPath('l1'),
      expect.objectContaining({ orgId: 'org-a', asUserId: 'u1' }),
    );
    expect(calls.log).toEqual(['outboxMarkSending:1', `api:${recordPath('l1')}`, 'outboxAck:1']);
  });

  it("a row counted by U1 is HELD under U2's session: not sent, not failed, not rejected, not touched", async () => {
    live.userId = 'u2';
    cacheMock.rows = [countRow(1, 'l1', { org: 'org-a', user: 'u1' })];

    await cycleCountSync.forceSync();

    expect(apiMock.api).not.toHaveBeenCalled();
    expect(calls.log).toEqual([]);
  });

  it('a session change BETWEEN two rows of one drain stops the second row', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      live.userId = 'u2'; // signed out / another account, mid-drain
    });
    cacheMock.rows = [
      countRow(1, 'l1', { org: 'org-a', user: 'u1' }),
      countRow(2, 'l2', { org: 'org-a', user: 'u1' }),
    ];

    await cycleCountSync.forceSync();

    expect(calls.log).toEqual(['outboxMarkSending:1', `api:${recordPath('l1')}`, 'outboxAck:1']);
    expect(apiMock.api).not.toHaveBeenCalledWith(recordPath('l2'), expect.anything());
  });

  it('a legacy row is sent under the live context and stamped with it at its first send', async () => {
    cacheMock.rows = [countRow(1, 'l1', { org: null, user: null })];

    await cycleCountSync.forceSync();

    expect(cacheMock.outboxMarkSending).toHaveBeenCalledWith(1, {
      orgId: 'org-live',
      userId: 'u1',
    });
    expect(apiMock.api).toHaveBeenCalledWith(
      recordPath('l1'),
      expect.objectContaining({ orgId: 'org-live', asUserId: 'u1' }),
    );
  });

  it('api() refusing because the account changed at the moment of sending puts the row back, unfailed', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      calls.log.push(`api:${path}`);
      throw new OutboxSessionChangedError();
    });
    cacheMock.rows = [countRow(1, 'l1', { org: 'org-a', user: 'u1' })];

    await cycleCountSync.forceSync();

    expect(calls.log).toEqual(['outboxMarkSending:1', `api:${recordPath('l1')}`, 'markHeld:1']);
  });

  it("a superseded row is acked when it is the live account's, parked (never deleted) when it is another's", async () => {
    // Two lines, each with an older row and a newer one (ids are monotonic).
    cacheMock.rows = [
      countRow(1, 'l1', { org: 'org-a', user: 'u1' }), // own, superseded by 3
      countRow(2, 'l2', { org: 'org-a', user: 'u9' }), // another account's, superseded by 4
      countRow(3, 'l1', { org: 'org-a', user: 'u1' }),
      countRow(4, 'l2', { org: 'org-a', user: 'u1' }),
    ];

    await cycleCountSync.forceSync();

    expect(cacheMock.outboxAck).toHaveBeenCalledWith(1);
    expect(cacheMock.outboxAck).not.toHaveBeenCalledWith(2);
    expect(cacheMock.outboxReject).toHaveBeenCalledWith(2, REPLACED_BY_LATER_COUNT);
  });
});

describe('newest-wins sees rows still in retry backoff (S4 review, pre-existing)', () => {
  it('an older count in backoff is superseded by the correction behind it, never sent after it', async () => {
    // Row 1 (the 5) failed and is backing off; row 2 (the 7) was queued while
    // row 1 was in flight. Judged among due rows only, row 1 was invisible:
    // the 7 was sent and acked, then the 5 was sent on its own.
    cacheMock.rows = [
      { ...countRow(1, 'l1', { org: 'org-a', user: 'u1' }), status: 'failed', attempts: 3, due: false },
      countRow(2, 'l1', { org: 'org-a', user: 'u1' }),
    ];

    await cycleCountSync.forceSync();

    expect(calls.log).toEqual([
      'outboxAck:1', // superseded without being sent
      'outboxMarkSending:2',
      `api:${recordPath('l1')}`,
      'outboxAck:2',
    ]);
  });

  it('the newest row of a line is not sent before its own backoff has elapsed', async () => {
    cacheMock.rows = [
      countRow(1, 'l1', { org: 'org-a', user: 'u1' }), // older, due: superseded all the same
      { ...countRow(2, 'l1', { org: 'org-a', user: 'u1' }), status: 'failed', attempts: 2, due: false },
      countRow(3, 'l2', { org: 'org-a', user: 'u1' }),
    ];

    await cycleCountSync.forceSync();

    expect(calls.log).toEqual([
      'outboxAck:1',
      'outboxMarkSending:3',
      `api:${recordPath('l2')}`,
      'outboxAck:3',
    ]);
  });
});

describe('forceSync waits for a drain already running (the sign-out recount depends on it)', () => {
  it('does not resolve until the in-flight drain has finished', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    apiMock.api.mockImplementationOnce(async (path: string) => {
      calls.log.push(`api:${path}`);
      await gate;
    });
    cacheMock.rows = [countRow(1, 'l1', { org: 'org-a', user: 'u1' })];

    const first = cycleCountSync.forceSync();
    await vi.waitFor(() => expect(calls.log).toContain(`api:${recordPath('l1')}`));

    let secondDone = false;
    const second = cycleCountSync.forceSync().then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(calls.log.indexOf('outboxAck:1')).toBeGreaterThan(-1);
  });
});

describe('the record body says when the count was taken (server 0369)', () => {
  // The engine passes a body FACTORY (clientSentAt is stamped as the request
  // leaves, after the bearer is resolved), which api() calls just before send.
  const sentBody = () => {
    const body = (apiMock.api.mock.calls[0]?.[1] as { body: unknown } | undefined)?.body;
    return (typeof body === 'function' ? (body as () => unknown)() : body) as
      | Record<string, unknown>
      | undefined;
  };

  it('hands api() a body factory, not a body stamped before the send', async () => {
    cacheMock.rows = [countRow(1, 'l1', { org: 'org-a', user: 'u1' })];
    await cycleCountSync.forceSync();
    const body = (apiMock.api.mock.calls[0]?.[1] as { body: unknown } | undefined)?.body;
    expect(typeof body).toBe('function');
  });

  it('a row stamped at enqueue sends its capturedAt and a fresh clientSentAt', async () => {
    const row = countRow(1, 'l1', { org: 'org-a', user: 'u1' });
    row.payload = { ...row.payload, capturedAt: '2026-09-24T14:20:00.000Z' };
    (row as Row & { createdAt: number }).createdAt = Date.parse('2026-09-24T14:20:00.000Z');
    cacheMock.rows = [row];

    const before = Date.now();
    await cycleCountSync.forceSync();

    const body = sentBody();
    expect(body?.capturedAt).toBe('2026-09-24T14:20:00.000Z');
    expect(Date.parse(String(body?.clientSentAt))).toBeGreaterThanOrEqual(before);
    expect(body?.countedQuantity).toBe(5);
  });

  it('a row queued before the field existed falls back to its created_at', async () => {
    const row = countRow(1, 'l1', { org: 'org-a', user: 'u1' });
    (row as Row & { createdAt: number }).createdAt = Date.parse('2026-09-24T09:15:00.000Z');
    cacheMock.rows = [row];

    await cycleCountSync.forceSync();

    const body = sentBody();
    expect(body?.capturedAt).toBe('2026-09-24T09:15:00.000Z');
    expect(typeof body?.clientSentAt).toBe('string');
  });
});
