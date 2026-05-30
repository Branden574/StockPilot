import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runDrain } from '../drainer';
import { QboClient } from './client';
import { quickbooksConnector } from './index';

/**
 * End-to-end drainer integration test (Phase 3a Task 9, integration portion).
 *
 * Proves the QuickBooks connector, driven through the real `runDrain`
 * orchestrator, POSTs exactly ONE Bill for a posted receipt and is idempotent:
 * a second drain over the same in-memory store does NOT re-POST because the
 * first run recorded a `success` row in `connection_sync_log`.
 *
 * Differs from index.test.ts's lighter integration check by asserting the full
 * terminal state: success ledger row (status + external_id) AND
 * org_connections.last_synced_at being stamped on the success path.
 *
 * The network is fully stubbed: `./client` is module-mocked so QboClient.post
 * returns a canned Bill without any HTTP. The mock implementation is re-wired in
 * beforeEach because the global setup's afterEach runs vi.restoreAllMocks(),
 * which strips a module mock's implementation between tests (mirrors
 * index.test.ts).
 */
const { postSpy, querySpy } = vi.hoisted(() => ({ postSpy: vi.fn(), querySpy: vi.fn() }));
vi.mock('./client', () => ({ QboClient: vi.fn() }));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

// Non-expired secrets so the drainer never calls refreshAuth (no token network).
vi.mock('../secret-store', () => ({
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })),
  putConnectionSecret: vi.fn(async () => 'new-secret-id'),
}));

beforeEach(() => {
  postSpy.mockReset().mockResolvedValue({ Bill: { Id: 'BILL-1' } });
  querySpy.mockReset().mockResolvedValue({ QueryResponse: {} });
  vi.mocked(QboClient).mockImplementation(
    () => ({ post: postSpy, query: querySpy }) as unknown as QboClient,
  );
});

/** Fixed timestamp injected as runDrain's `now` so assertions are deterministic. */
const NOW = new Date('2026-05-30T12:00:00.000Z');

const CONNECTION_ROW = {
  id: 'conn-1',
  organization_id: 'org-1',
  provider_id: 'quickbooks',
  status: 'active',
  secret_id: 'sec-1',
  external_account_id: 'realm1',
  settings: { env: 'sandbox', accountIds: { billExpense: '42' } },
};

const EVENT_ROW = {
  id: 'evt-1',
  organization_id: 'org-1',
  topic: 'receipt.posted',
  aggregate_type: 'receipt',
  aggregate_id: 'rcpt-aggregate-1',
  payload: {
    purchaseOrderId: 'po-1',
    warehouseId: 'wh-1',
    receiptNumber: 'RC-1',
    lineCount: 1,
    totalAccepted: 5,
    totalRejected: 0,
  },
  dedupe_key: null,
  created_at: NOW.toISOString(),
};

/**
 * In-memory service-role admin for the drainer. Backs:
 *  - org_connections: one active QBO connection (recorded updates also mutate
 *    the row so last_synced_at can be asserted).
 *  - connection_sync_log: per-(connection,event) ledger; the recorded
 *    upsert/update writes mutate it so a SECOND run sees the success row.
 *  - the connector's rehydration reads (receipts/receipt_lines/purchase_orders/
 *    suppliers) and connection_mappings vendor lookup, served from `domain`.
 * rpc('connector_drain_candidates') returns the eligible event; secret RPCs are
 * unused because secret-store is module-mocked above.
 */
function makeDrainAdmin(domain: Record<string, { data: unknown }>) {
  const writes: Array<{ table: string; op: string; values: any }> = [];
  const syncLog: Record<string, any> = {};
  const connections: Record<string, any> = { 'conn-1': { ...CONNECTION_ROW } };

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
      not: () => self,
      order: () => self,
      limit: () => self,
      maybeSingle: () => {
        if (table === 'connection_sync_log') {
          const key = `${filters.connection_id}:${filters.outbox_event_id}`;
          return Promise.resolve({ data: syncLog[key] ?? null, error: null });
        }
        return Promise.resolve({ data: domain[table]?.data ?? null, error: null });
      },
      upsert: (values: any) => {
        writes.push({ table, op: 'upsert', values });
        if (table === 'connection_sync_log') {
          syncLog[`${values.connection_id}:${values.outbox_event_id}`] = { ...values };
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
            if (table === 'org_connections' && filters.id) {
              connections[filters.id] = { ...(connections[filters.id] ?? {}), ...values };
            }
            return resolve({ error: null });
          },
        };
        return chain;
      },
      // Terminal select: org_connections returns the active set; domain tables
      // (e.g. receipt_lines, queried without maybeSingle) resolve their array.
      then: (resolve: any) => {
        if (table === 'org_connections') {
          return resolve({ data: Object.values(connections), error: null });
        }
        return resolve({ data: domain[table]?.data ?? null, error: null });
      },
    };
    return self;
  }

  return {
    from: (t: string) => builder(t),
    rpc: vi.fn(async (fn: string) =>
      fn === 'connector_drain_candidates'
        ? { data: [EVENT_ROW], error: null }
        : { data: null, error: null },
    ),
    __writes: writes,
    __connections: connections,
    __syncLog: syncLog,
  };
}

describe('quickbooksConnector via runDrain — end-to-end Bill export + idempotency', () => {
  function buildDomain() {
    return {
      receipts: {
        data: { id: 'rcpt-aggregate-1', purchase_order_id: 'po-1', receipt_number: 'RC-1' },
      },
      // qty_accepted_base 5 @ unit_cost 2 → aggregate Bill amount 10.
      receipt_lines: { data: [{ qty_accepted_base: 5, unit_cost: 2 }] },
      purchase_orders: { data: { supplier_id: 'sup-1' } },
      suppliers: { data: { id: 'sup-1', name: 'Acme Supplies' } },
      // Pre-existing supplier→Vendor mapping so resolveVendor short-circuits and
      // the only POST is the Bill (keeps the "exactly one Bill" count exact).
      connection_mappings: { data: { external_id: 'qbo-vendor-7', external_meta: {} } },
      // integrations module enabled for org-1 (migration 0144 gate) so the
      // drainer dispatches; a disabled-module case is covered in drainer.test.ts.
      organization_modules: { data: [{ organization_id: 'org-1' }] },
    };
  }

  it('posts exactly one Bill with success ledger + last_synced_at, and does not re-post on re-run', async () => {
    const admin = makeDrainAdmin(buildDomain());

    // First drain: the event is eligible → one Bill POST.
    const res1 = await runDrain(admin as any, { quickbooks: quickbooksConnector } as any, NOW);
    expect(res1.processed).toBe(1);
    expect(res1.succeeded).toBe(1);

    // Exactly one Bill POST, with the aggregate amount (5 * 2 = 10) and the
    // receipt-derived idempotency requestid.
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(
      '/bill',
      expect.objectContaining({
        VendorRef: { value: 'qbo-vendor-7' },
        Line: [
          expect.objectContaining({
            Amount: 10,
            AccountBasedExpenseLineDetail: { AccountRef: { value: '42' } },
          }),
        ],
      }),
      'rcpt-rcpt-aggregate-1',
    );

    // connection_sync_log row for (connection, event) is success with the Bill id.
    const ledger = admin.__syncLog['conn-1:evt-1'];
    expect(ledger?.status).toBe('success');
    expect(ledger?.external_id).toBe('BILL-1');

    // org_connections.last_synced_at stamped with the injected `now`.
    expect(admin.__connections['conn-1']?.last_synced_at).toBe(NOW.toISOString());

    // Second drain over the SAME store: the recorded success row makes it
    // idempotent — no second Bill POST, nothing processed.
    const res2 = await runDrain(admin as any, { quickbooks: quickbooksConnector } as any, NOW);
    expect(res2.processed).toBe(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
