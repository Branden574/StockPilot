import type { ConnectionRef } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { buildInventoryValuationJE, maybePostMonthlyValuation } from './valuation';

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

/**
 * The journal entry MUST balance (Σ debits === Σ credits). A positive delta
 * (inventory grew) debits the inventory-asset account and credits the offset;
 * a negative delta swaps them. A zero delta produces no JE.
 */
function sumByPosting(
  je: NonNullable<ReturnType<typeof buildInventoryValuationJE>>,
  posting: 'Debit' | 'Credit',
): number {
  return je.Line.filter((l) => l.JournalEntryLineDetail.PostingType === posting).reduce(
    (sum, l) => sum + l.Amount,
    0,
  );
}

describe('buildInventoryValuationJE', () => {
  it('positive delta: Debit inventoryAsset / Credit valuationOffset, both Amount=delta', () => {
    const je = buildInventoryValuationJE({
      deltaValue: 100,
      inventoryAssetId: 'A',
      valuationOffsetId: 'B',
      txnDate: '2026-05-31',
    });

    expect(je).toEqual({
      TxnDate: '2026-05-31',
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 100,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'A' } },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 100,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'B' } },
        },
      ],
    });
    // balance check
    expect(sumByPosting(je!, 'Debit')).toBe(sumByPosting(je!, 'Credit'));
  });

  it('negative delta: swaps — Debit valuationOffset / Credit inventoryAsset, Amount=abs(delta)', () => {
    const je = buildInventoryValuationJE({
      deltaValue: -40,
      inventoryAssetId: 'A',
      valuationOffsetId: 'B',
      txnDate: '2026-05-31',
    });

    expect(je).toEqual({
      TxnDate: '2026-05-31',
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 40,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'B' } },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 40,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'A' } },
        },
      ],
    });
    expect(sumByPosting(je!, 'Debit')).toBe(sumByPosting(je!, 'Credit'));
  });

  it('zero delta: returns null (no JE)', () => {
    expect(
      buildInventoryValuationJE({
        deltaValue: 0,
        inventoryAssetId: 'A',
        valuationOffsetId: 'B',
        txnDate: '2026-05-31',
      }),
    ).toBeNull();
  });
});

/**
 * Fake service-role admin seam for maybePostMonthlyValuation. `inventoryRows`
 * is the full set of active/non-deleted/non-rental items for the org; the fake
 * honours `.range(from,to)` so the paginated scan in currentInventoryValue is
 * exercised (a single un-paged read of >page-size rows would be a regression).
 * Every org_connections update is recorded into `writes` for assertions.
 */
function makeFakeAdmin(opts: {
  inventoryRows?: Array<{ quantity_on_hand: number; unit_cost: number }>;
  inventoryError?: string;
}) {
  const writes: Array<{ table: string; values: any; filters: Record<string, any> }> = [];
  const inventoryRows = opts.inventoryRows ?? [];

  function builder(table: string) {
    const state: { filters: Record<string, any>; range?: [number, number] } = { filters: {} };
    const self: any = {
      select() {
        return self;
      },
      eq(col: string, val: any) {
        state.filters[col] = val;
        return self;
      },
      is(col: string) {
        state.filters[col] = null;
        return self;
      },
      order() {
        return self;
      },
      range(from: number, to: number) {
        state.range = [from, to];
        // inventory_items reads resolve here (the terminal call in the scan).
        if (opts.inventoryError) {
          return Promise.resolve({ data: null, error: { message: opts.inventoryError } });
        }
        return Promise.resolve({ data: inventoryRows.slice(from, to + 1), error: null });
      },
      update(values: any) {
        const chain: any = {
          _filters: {} as Record<string, any>,
          eq(col: string, val: any) {
            chain._filters[col] = val;
            return chain;
          },
          then(resolve: any) {
            writes.push({ table, values, filters: chain._filters });
            return resolve({ error: null });
          },
        };
        return chain;
      },
    };
    return self;
  }

  return { from: (t: string) => builder(t), __writes: writes };
}

/** Fake QboClient recording every post() so we can assert the JE + requestId. */
function makeFakeClient() {
  const posts: Array<{ path: string; body: any; requestId?: string }> = [];
  return {
    post: vi.fn(async (path: string, body: any, requestId?: string) => {
      posts.push({ path, body, requestId });
      return {};
    }),
    __posts: posts,
  };
}

function makeConn(settings: Record<string, unknown>): ConnectionRef {
  return {
    id: 'conn-1',
    organizationId: 'org-1',
    providerId: 'quickbooks',
    status: 'active',
    externalAccountId: 'realm-9',
    settings,
  };
}

const CONFIGURED = { accountIds: { inventoryAsset: 'A', valuationOffset: 'B' } };
const NOW = new Date('2026-05-30T12:00:00.000Z'); // month 2026-05

describe('maybePostMonthlyValuation', () => {
  it('month-gate: returns early without posting or writing when already done this month', async () => {
    const admin = makeFakeAdmin({ inventoryRows: [{ quantity_on_hand: 5, unit_cost: 10 }] });
    const client = makeFakeClient();
    await maybePostMonthlyValuation(
      admin as any,
      makeConn({ ...CONFIGURED, lastValuationMonth: '2026-05' }),
      client as any,
      NOW,
    );
    expect(client.__posts).toHaveLength(0);
    expect(admin.__writes).toHaveLength(0);
  });

  it('config gap: records skip in settings.lastValuationSkipReason, NEVER touches last_error, and does not advance the month', async () => {
    const admin = makeFakeAdmin({ inventoryRows: [{ quantity_on_hand: 5, unit_cost: 10 }] });
    const client = makeFakeClient();
    await maybePostMonthlyValuation(admin as any, makeConn({}), client as any, NOW);

    expect(client.__posts).toHaveLength(0);
    expect(admin.__writes).toHaveLength(1);
    const w = admin.__writes[0]!;
    // The shared drain-error column is never written by the valuation skip.
    expect(w.values).not.toHaveProperty('last_error');
    expect(w.values.settings.lastValuationSkipReason).toMatch(/not configured/);
    // The month is NOT stamped (it should retry once configured).
    expect(w.values.settings.lastValuationMonth).toBeUndefined();
  });

  it('config gap: does NOT re-write when the skip reason is already set (no per-tick write amplification)', async () => {
    const admin = makeFakeAdmin({});
    const client = makeFakeClient();
    await maybePostMonthlyValuation(
      admin as any,
      makeConn({
        lastValuationSkipReason:
          'Inventory valuation skipped: inventoryAsset/valuationOffset account not configured',
      }),
      client as any,
      NOW,
    );
    expect(admin.__writes).toHaveLength(0);
  });

  it('posts a balanced JE for the delta with the per-period requestid and merges settings without clobbering accountIds', async () => {
    // current = 5*10 + 3*20 = 110; snapshot 40 → delta 70.
    const admin = makeFakeAdmin({
      inventoryRows: [
        { quantity_on_hand: 5, unit_cost: 10 },
        { quantity_on_hand: 3, unit_cost: 20 },
      ],
    });
    const client = makeFakeClient();
    await maybePostMonthlyValuation(
      admin as any,
      makeConn({ ...CONFIGURED, lastValuationSnapshotValue: 40 }),
      client as any,
      NOW,
    );

    expect(client.__posts).toHaveLength(1);
    const { path, body, requestId } = client.__posts[0]!;
    expect(path).toBe('/journalentry');
    expect(requestId).toBe('val-realm-9-2026-05');
    // delta 70 > 0 → Debit asset A / Credit offset B, balanced.
    expect(body.Line[0]).toEqual({
      DetailType: 'JournalEntryLineDetail',
      Amount: 70,
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: 'A' } },
    });
    expect(body.Line[1]).toEqual({
      DetailType: 'JournalEntryLineDetail',
      Amount: 70,
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: 'B' } },
    });

    const w = admin.__writes.find((x) => x.table === 'org_connections')!;
    expect(w.values.settings.accountIds).toEqual(CONFIGURED.accountIds); // not clobbered
    expect(w.values.settings.lastValuationSnapshotValue).toBe(110);
    expect(w.values.settings.lastValuationMonth).toBe('2026-05');
    expect(w.values.settings.lastValuationSkipReason).toBeNull(); // stale skip cleared
  });

  it('idempotency: a second call in the same calendar month does NOT post again (gate set by the first)', async () => {
    const inventoryRows = [{ quantity_on_hand: 10, unit_cost: 5 }]; // value 50
    const admin = makeFakeAdmin({ inventoryRows });
    const client = makeFakeClient();
    const conn = makeConn({ ...CONFIGURED, lastValuationSnapshotValue: 0 });

    await maybePostMonthlyValuation(admin as any, conn, client as any, NOW);
    expect(client.__posts).toHaveLength(1);

    // Simulate the persisted settings being read back next tick (same month).
    const persisted = admin.__writes.find((x) => x.table === 'org_connections')!.values.settings;
    await maybePostMonthlyValuation(admin as any, makeConn(persisted), client as any, NOW);
    expect(client.__posts).toHaveLength(1); // still 1 — no double post
  });

  it('zero delta: advances the month + snapshot but posts no JE', async () => {
    const admin = makeFakeAdmin({ inventoryRows: [{ quantity_on_hand: 2, unit_cost: 25 }] }); // 50
    const client = makeFakeClient();
    await maybePostMonthlyValuation(
      admin as any,
      makeConn({ ...CONFIGURED, lastValuationSnapshotValue: 50 }),
      client as any,
      NOW,
    );
    expect(client.__posts).toHaveLength(0);
    const w = admin.__writes.find((x) => x.table === 'org_connections')!;
    expect(w.values.settings.lastValuationMonth).toBe('2026-05');
  });

  it('pages the full inventory set (no silent truncation feeding the JE)', async () => {
    // 2500 rows of value 1 each (qty 1 × cost 1). A capped/un-paged read would
    // under-count; the paginated scan must sum all 2500 → delta 2500.
    const inventoryRows = Array.from({ length: 2500 }, () => ({
      quantity_on_hand: 1,
      unit_cost: 1,
    }));
    const admin = makeFakeAdmin({ inventoryRows });
    const client = makeFakeClient();
    await maybePostMonthlyValuation(
      admin as any,
      makeConn({ ...CONFIGURED, lastValuationSnapshotValue: 0 }),
      client as any,
      NOW,
    );
    expect(client.__posts[0]!.body.Line[0].Amount).toBe(2500);
  });
});
