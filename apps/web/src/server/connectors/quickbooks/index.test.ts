import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionRef, ConnectorDeps, OutboxEvent } from '@stockpilot/core';

import { runDrain } from '../drainer';
import { QboClient } from './client';
import { quickbooksConnector } from './index';

// QboClient is constructed inside handleOutboxEvent; mock the module so each test
// can inject a spy-able post/query without hitting the network. vi.hoisted keeps
// the spies defined before the hoisted vi.mock factory references them.
const { postSpy, querySpy } = vi.hoisted(() => ({ postSpy: vi.fn(), querySpy: vi.fn() }));
vi.mock('./client', () => ({ QboClient: vi.fn() }));

// The global test setup runs vi.restoreAllMocks() in afterEach, which strips a
// module mock's implementation between tests. Re-establish the QboClient → spy
// wiring (and a clean default Bill response) before EACH test so order doesn't
// matter.
beforeEach(() => {
  postSpy.mockReset().mockResolvedValue({ Bill: { Id: 'qbo-bill-99' } });
  querySpy.mockReset().mockResolvedValue({ QueryResponse: {} });
  vi.mocked(QboClient).mockImplementation(
    () => ({ post: postSpy, query: querySpy }) as unknown as QboClient,
  );
});

// Drainer dependencies (only exercised by the integration test below).
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('../secret-store', () => ({
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })),
  putConnectionSecret: vi.fn(async () => 'new-secret-id'),
}));

const conn: ConnectionRef = {
  id: 'conn-1',
  organizationId: 'org-1',
  providerId: 'quickbooks',
  status: 'active',
  externalAccountId: 'realm-1',
  settings: { env: 'sandbox', accountIds: { billExpense: 'acct-9' } },
};

const event: OutboxEvent = {
  id: 'evt-1',
  organizationId: 'org-1',
  topic: 'receipt.posted',
  aggregateType: 'receipt',
  aggregateId: 'r1',
  payload: {},
  dedupeKey: null,
  createdAt: new Date().toISOString(),
};

function makeDeps(overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return {
    admin: {},
    fetch,
    getMapping: vi.fn(async () => ({ externalId: 'qbo-vendor-7', externalMeta: {} })),
    putMapping: vi.fn(async () => undefined),
    ...overrides,
  };
}

/**
 * Builds a fake service-role admin whose per-table reads resolve `{ data, error }`.
 * `tables` maps a table name to its select result; `errors` injects a `{ error }`
 * on a given table's read so we can prove the connector fails CLOSED (throws)
 * instead of swallowing a transient DB error and ACKing a dropped export.
 */
function makeAdmin(opts: {
  tables?: Record<string, { data: unknown; error?: { message: string } | null }>;
}) {
  const tables = opts.tables ?? {};
  function builder(table: string) {
    const result = tables[table] ?? { data: null, error: null };
    const self: any = {
      select: () => self,
      eq: () => self,
      maybeSingle: () => Promise.resolve({ data: result.data, error: result.error ?? null }),
      // receipt_lines resolves directly (no maybeSingle) — make the chain awaitable.
      then: (resolve: any) => resolve({ data: result.data, error: result.error ?? null }),
    };
    return self;
  }
  return { from: (t: string) => builder(t) };
}

describe('quickbooksConnector.handleOutboxEvent — fail-closed reads', () => {
  it('THROWS (does not ack) on a transient receipts read error', async () => {
    const admin = makeAdmin({
      tables: { receipts: { data: null, error: { message: 'db down' } } },
    });
    await expect(
      quickbooksConnector.handleOutboxEvent(event, conn, {} as any, makeDeps({ admin })),
    ).rejects.toThrow(/db down/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('acks (ok:true) only when the receipt is genuinely absent (no error, null row)', async () => {
    const admin = makeAdmin({ tables: { receipts: { data: null, error: null } } });
    const res = await quickbooksConnector.handleOutboxEvent(
      event,
      conn,
      {} as any,
      makeDeps({ admin }),
    );
    expect(res).toEqual({ ok: true });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('THROWS on a transient receipt_lines read error (never POSTs an Amount-0 Bill)', async () => {
    const admin = makeAdmin({
      tables: {
        receipts: { data: { id: 'r1', purchase_order_id: 'po-1', receipt_number: 'RC-1' }, error: null },
        receipt_lines: { data: null, error: { message: 'lines boom' } },
      },
    });
    await expect(
      quickbooksConnector.handleOutboxEvent(event, conn, {} as any, makeDeps({ admin })),
    ).rejects.toThrow(/lines boom/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('THROWS on a transient purchase_orders read error', async () => {
    const admin = makeAdmin({
      tables: {
        receipts: { data: { id: 'r1', purchase_order_id: 'po-1', receipt_number: 'RC-1' }, error: null },
        receipt_lines: { data: [{ qty_accepted_base: 1, unit_cost: 1 }], error: null },
        purchase_orders: { data: null, error: { message: 'po boom' } },
      },
    });
    await expect(
      quickbooksConnector.handleOutboxEvent(event, conn, {} as any, makeDeps({ admin })),
    ).rejects.toThrow(/po boom/);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('THROWS on a transient suppliers read error', async () => {
    const admin = makeAdmin({
      tables: {
        receipts: { data: { id: 'r1', purchase_order_id: 'po-1', receipt_number: 'RC-1' }, error: null },
        receipt_lines: { data: [{ qty_accepted_base: 1, unit_cost: 1 }], error: null },
        purchase_orders: { data: { supplier_id: 'sup-1' }, error: null },
        suppliers: { data: null, error: { message: 'sup boom' } },
      },
    });
    await expect(
      quickbooksConnector.handleOutboxEvent(event, conn, {} as any, makeDeps({ admin })),
    ).rejects.toThrow(/sup boom/);
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('quickbooksConnector.handleOutboxEvent — zero-amount short-circuit', () => {
  it('acks without POSTing when every line is rejected (aggregate Amount 0)', async () => {
    const admin = makeAdmin({
      tables: {
        receipts: { data: { id: 'r1', purchase_order_id: 'po-1', receipt_number: 'RC-1' }, error: null },
        receipt_lines: {
          data: [
            { qty_accepted_base: 0, unit_cost: 5 },
            { qty_accepted_base: 0, unit_cost: 3 },
          ],
          error: null,
        },
        purchase_orders: { data: { supplier_id: 'sup-1' }, error: null },
        suppliers: { data: { id: 'sup-1', name: 'Acme' }, error: null },
      },
    });
    const res = await quickbooksConnector.handleOutboxEvent(
      event,
      conn,
      {} as any,
      makeDeps({ admin }),
    );
    expect(res).toEqual({ ok: true });
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('quickbooksConnector via runDrain (integration) — Step 6', () => {
  /**
   * Fake admin for the drainer: org_connections / connection_sync_log writes are
   * recorded, the candidate RPC returns our event once, and the connector's
   * rehydration reads (receipts/receipt_lines/purchase_orders/suppliers) resolve
   * from `domain`. `syncLog` is mutated by the recorded writes so a SECOND run
   * sees the first run's success row (idempotency).
   */
  function makeDrainAdmin(domain: Record<string, { data: unknown }>) {
    const writes: Array<{ table: string; op: string; values: any }> = [];
    const syncLog: Record<string, any> = {};
    function builder(table: string) {
      const filters: Record<string, any> = {};
      const self: any = {
        select: () => self,
        eq: (c: string, v: any) => {
          filters[c] = v;
          return self;
        },
        in: () => self,
        is: () => self,
        order: () => self,
        limit: () => self,
        maybeSingle: () => {
          if (table === 'connection_sync_log') {
            const key = `${filters.connection_id}:${filters.outbox_event_id}`;
            return Promise.resolve({ data: syncLog[key] ?? null, error: null });
          }
          const d = domain[table]?.data ?? null;
          return Promise.resolve({ data: d, error: null });
        },
        upsert: (values: any) => {
          writes.push({ table, op: 'upsert', values });
          if (table === 'connection_sync_log') {
            syncLog[`${values.connection_id}:${values.outbox_event_id}`] = values;
          }
          return Promise.resolve({ error: null });
        },
        update: (values: any) => {
          writes.push({ table, op: 'update', values });
          const chain: any = {
            eq: (c: string, v: any) => {
              filters[c] = v;
              return chain;
            },
            then: (resolve: any) => {
              if (table === 'connection_sync_log') {
                const key = `${filters.connection_id}:${filters.outbox_event_id}`;
                syncLog[key] = { ...(syncLog[key] ?? {}), ...values };
              }
              return resolve({ error: null });
            },
          };
          return chain;
        },
        then: (resolve: any) => {
          if (table === 'org_connections') {
            return resolve({
              data: [
                {
                  id: 'conn-1',
                  organization_id: 'org-1',
                  provider_id: 'quickbooks',
                  status: 'active',
                  secret_id: 'sec-1',
                  external_account_id: 'realm-1',
                  settings: { env: 'sandbox', accountIds: { billExpense: 'acct-9' } },
                },
              ],
              error: null,
            });
          }
          const d = domain[table]?.data ?? null;
          return resolve({ data: d, error: null });
        },
      };
      return self;
    }
    return {
      from: (t: string) => builder(t),
      rpc: vi.fn(async (fn: string) =>
        fn === 'connector_drain_candidates'
          ? {
              data: [
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
              error: null,
            }
          : { data: null, error: null },
      ),
      __writes: writes,
    };
  }

  it('posts exactly one Bill, records success + external_id, and does NOT re-post on re-run', async () => {
    // beforeEach already wires postSpy → { Bill: { Id: 'qbo-bill-99' } }.
    const domain = {
      receipts: { data: { id: 'r1', purchase_order_id: 'po-1', receipt_number: 'RC-1' } },
      receipt_lines: { data: [{ qty_accepted_base: 4, unit_cost: 2.5 }] },
      purchase_orders: { data: { supplier_id: 'sup-1' } },
      suppliers: { data: { id: 'sup-1', name: 'Acme' } },
      connection_mappings: { data: { external_id: 'qbo-vendor-7', external_meta: {} } },
    };
    const admin = makeDrainAdmin(domain);

    const res1 = await runDrain(
      admin as any,
      { quickbooks: quickbooksConnector } as any,
      new Date(),
    );
    expect(res1.succeeded).toBe(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
    // the Bill body's aggregate amount = 4 * 2.5 = 10
    expect(postSpy).toHaveBeenCalledWith(
      '/bill',
      expect.objectContaining({ Line: [expect.objectContaining({ Amount: 10 })] }),
      'rcpt-r1',
    );
    const success = (admin.__writes as any[]).find(
      (w) =>
        w.table === 'connection_sync_log' &&
        w.op === 'update' &&
        w.values.status === 'success',
    );
    expect(success?.values.external_id).toBe('qbo-bill-99');

    // Re-run: the recorded success row short-circuits — no second POST.
    const res2 = await runDrain(
      admin as any,
      { quickbooks: quickbooksConnector } as any,
      new Date(),
    );
    expect(res2.processed).toBe(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
