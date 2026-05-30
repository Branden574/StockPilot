import { describe, expect, it, vi } from 'vitest';

import { MAX_ATTEMPTS, nextBackoff, runDrain } from './drainer';

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

vi.mock('./secret-store', () => ({
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })),
  putConnectionSecret: vi.fn(async () => 'new-secret-id'),
}));

describe('nextBackoff', () => {
  it('is exponential and capped, jittered within bounds', () => {
    const b1 = nextBackoff(1),
      b8 = nextBackoff(8);
    expect(b1).toBeGreaterThan(0);
    expect(b8).toBeLessThanOrEqual(60 * 60 * 1000); // cap 1h
    expect(nextBackoff(2)).toBeGreaterThanOrEqual(nextBackoff(1) * 0.5);
  });
  it('MAX_ATTEMPTS is a small finite number', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(12);
  });
});

/**
 * Builds a minimal fake admin client. `tables` is a map of table name to the
 * data each `select()` should resolve. Mutating calls (upsert/update) are
 * recorded into `writes` so assertions can inspect them. Errors can be injected
 * per (table, op) via `errors`.
 */
function makeFakeAdmin(opts: {
  conns?: any[];
  events?: any[];
  /** keyed by `${connectionId}:${eventId}` */
  syncLog?: Record<string, any>;
  /** keyed by `${table}:${op}` -> error message */
  errors?: Record<string, string>;
  /** error message to inject on the candidate-selection RPC */
  candidatesRpcError?: string;
}) {
  const writes: Array<{ table: string; op: string; values: any }> = [];
  /** records every connector_drain_candidates RPC call so tests can assert args */
  const candidateCalls: Array<{ fn: string; args: any }> = [];
  const err = (key: string) =>
    opts.errors?.[key] ? { message: opts.errors[key] } : null;

  function builder(table: string) {
    const state: { filters: Record<string, any> } = { filters: {} };
    const self: any = {
      select() {
        return self;
      },
      eq(col: string, val: any) {
        state.filters[col] = val;
        return self;
      },
      in() {
        return self;
      },
      is(col: string) {
        state.filters[col] = null;
        return self;
      },
      not() {
        return self;
      },
      order() {
        return self;
      },
      limit() {
        return self;
      },
      maybeSingle() {
        if (table === 'connection_sync_log') {
          const key = `${state.filters.connection_id}:${state.filters.outbox_event_id}`;
          return Promise.resolve({
            data: opts.syncLog?.[key] ?? null,
            error: err('connection_sync_log:select'),
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      upsert(values: any) {
        writes.push({ table, op: 'upsert', values });
        return Promise.resolve({ error: err(`${table}:upsert`) });
      },
      update(values: any) {
        writes.push({ table, op: 'update', values });
        const chain: any = {
          eq() {
            return chain;
          },
          then(resolve: any) {
            return resolve({ error: err(`${table}:update`) });
          },
        };
        return chain;
      },
      // org_connections terminal select (.eq('status','active'))
      then(resolve: any) {
        if (table === 'org_connections') {
          return resolve({ data: opts.conns ?? [], error: err('org_connections:select') });
        }
        return resolve({ data: [], error: null });
      },
    };
    return self;
  }

  return {
    from: (t: string) => builder(t),
    // Candidate selection is delegated to a SECURITY DEFINER RPC that excludes
    // terminal/backed-off events server-side (head-of-line starvation fix).
    rpc: vi.fn(async (fn: string, args: any) => {
      if (fn === 'connector_drain_candidates') {
        candidateCalls.push({ fn, args });
        if (opts.candidatesRpcError) {
          return { data: null, error: { message: opts.candidatesRpcError } };
        }
        return { data: opts.events ?? [], error: null };
      }
      return { data: null, error: null };
    }),
    __writes: writes,
    __candidateCalls: candidateCalls,
  };
}

const okConnector = (subscribedTopics: string[] = ['receipt.posted']) => ({
  id: 'quickbooks' as const,
  modes: ['push'] as const,
  subscribedTopics,
  handleOutboxEvent: vi.fn(async () => ({ ok: true, externalId: 'ext-1' })),
});

describe('runDrain error handling (fail-closed)', () => {
  it('throws when the org_connections select fails', async () => {
    const admin = makeFakeAdmin({ errors: { 'org_connections:select': 'db down' } });
    await expect(
      runDrain(admin as any, {}, new Date()),
    ).rejects.toThrow(/db down/);
  });

  it('throws when the candidate-selection RPC fails', async () => {
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      candidatesRpcError: 'events boom',
    });
    await expect(
      runDrain(admin as any, { quickbooks: okConnector() } as any, new Date()),
    ).rejects.toThrow(/events boom/);
  });

  it('does NOT fire the connector when the pending-row upsert fails', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
      errors: { 'connection_sync_log:upsert': 'write failed' },
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(1);
  });
});

describe('runDrain happy path', () => {
  it('dispatches a due event and records success', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).toHaveBeenCalledTimes(1);
    expect(res.processed).toBe(1);
    expect(res.succeeded).toBe(1);
    // pending upsert + success update + org_connections update
    const successUpdate = (admin.__writes as any[]).find(
      (w) => w.table === 'connection_sync_log' && w.op === 'update' && w.values.status === 'success',
    );
    expect(successUpdate).toBeTruthy();
  });

  it('bounds the candidate window via the RPC (org/topics/now/limit), not an unbounded NOT IN', async () => {
    // Head-of-line starvation fix: candidate selection delegates to a SECURITY
    // DEFINER RPC that excludes terminal/backed-off events server-side, bounded
    // by a work-remaining limit. Assert we call it with the connection scope and
    // a finite limit rather than fetching every terminal id into a NOT-IN list.
    const connector = okConnector(['receipt.posted']);
    const now = new Date('2026-05-30T00:00:00.000Z');
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [],
    });
    await runDrain(admin as any, { quickbooks: connector } as any, now);
    const calls = (admin as any).__candidateCalls as Array<{ fn: string; args: any }>;
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toMatchObject({
      p_connection_id: 'conn-1',
      p_organization_id: 'org-1',
      p_topics: ['receipt.posted'],
      p_now: now.toISOString(),
    });
    expect(typeof args.p_limit).toBe('number');
    expect(args.p_limit).toBeGreaterThan(0);
    // RPC returned [] → nothing dispatched and the unbounded terminal-id fetch
    // never happens.
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
  });

  it('does not re-dispatch an event already terminal (success) for the connection', async () => {
    // Defense in depth on top of the RPC exclusion: even if a terminal event
    // slipped into the candidate set, the per-event ledger point-read skips it.
    const connector = okConnector(['receipt.posted']);
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
      syncLog: { 'conn-1:evt-1': { status: 'success', attempts: 1 } },
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.processed).toBe(0);
  });

  it('skips when secret_id is null on an active connection (no dispatch)', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: null,
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.succeeded).toBe(0);
  });
});
