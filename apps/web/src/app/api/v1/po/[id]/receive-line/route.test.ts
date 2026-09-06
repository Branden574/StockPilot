import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ReceivingService } from '@/server/services/receiving';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryList: vi.fn(),
}));
vi.mock('@/server/services/receiving', () => ({ ReceivingService: vi.fn() }));

const PO = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const LINE_DONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Record<string, unknown>;

interface TableFixture {
  /** Rows the query resolves to. */
  rows: Row[];
  error?: { code: string; message: string } | null;
}

/**
 * Minimal PostgREST-shaped builder. It is a thenable (so `await
 * builder.select().eq()...` resolves to the whole row set) AND exposes
 * `maybeSingle()` with the REAL supabase-js semantics: >1 matching row is a
 * PGRST116 error, not a row. That asymmetry is the whole point of the SP-064
 * case below — the old route used maybeSingle() and therefore 500'd on a PO
 * that legitimately lists one item on two lines.
 */
function makeBuilder(fixture: TableFixture) {
  const settle = () =>
    Promise.resolve({ data: fixture.rows, error: fixture.error ?? null });
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => {
      if (fixture.error) return { data: null, error: fixture.error };
      if (fixture.rows.length > 1) {
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message:
              'JSON object requested, multiple (or no) rows returned',
          },
        };
      }
      return { data: fixture.rows[0] ?? null, error: null };
    },
    then: (
      onOk: (v: unknown) => unknown,
      onErr?: (e: unknown) => unknown,
    ) => settle().then(onOk, onErr),
  };
  return builder;
}

const postReceipt = vi.fn();

function buildCtx(tables: Record<string, TableFixture>) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    supabase: {
      from: (table: string) =>
        makeBuilder(tables[table] ?? { rows: [] }),
    } as never,
  };
}

function buildRequest(body: unknown) {
  return new Request(`https://test.local/api/v1/po/${PO}/receive-line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const params = { params: Promise.resolve({ id: PO }) };

function openPo(overrides: Row = {}): TableFixture {
  return {
    rows: [
      {
        id: PO,
        status: 'ordered',
        destination_location_id: null,
        supplier_id: null,
        ...overrides,
      },
    ],
  };
}

function poLine(id: string, ordered: number, received: number): Row {
  return {
    id,
    item_id: ITEM,
    quantity_ordered: ordered,
    quantity_received: received,
    unit_cost: 2,
  };
}

function post(tables: Record<string, TableFixture>, body: unknown) {
  vi.mocked(withApiContext).mockResolvedValue(buildCtx(tables) as never);
  return POST(buildRequest(body), params);
}

beforeEach(() => {
  vi.clearAllMocks();
  postReceipt.mockResolvedValue({ id: 'r1', receipt_number: 'RCV-1' });
  vi.mocked(ReceivingService).mockImplementation(
    () => ({ postReceipt }) as unknown as ReceivingService,
  );
});

/**
 * SP-064 — purchase_order_items has no unique index on
 * (purchase_order_id, item_id); a vendor PO may list the same item twice.
 */
describe('receive-line: a PO carrying the same item on two lines', () => {
  const tables = () => ({
    purchase_orders: openPo(),
    purchase_order_items: {
      rows: [poLine(LINE_DONE, 20, 20), poLine(LINE_OPEN, 5, 0)],
    },
  });

  it('receives instead of 500ing when the item appears on two lines', async () => {
    const res = await post(tables(), {
      itemId: ITEM,
      qty: 2,
      warehouseId: WH,
      idempotencyKey: KEY,
    });
    expect(res.status).toBe(200);
    expect(postReceipt).toHaveBeenCalledTimes(1);
  });

  it('posts against the line that still has quantity outstanding', async () => {
    await post(tables(), {
      itemId: ITEM,
      qty: 2,
      warehouseId: WH,
      idempotencyKey: KEY,
    });
    const input = postReceipt.mock.calls[0]?.[0] as {
      lines: { poLineId: string; qtyReceived: number }[];
    };
    expect(input.lines[0]?.poLineId).toBe(LINE_OPEN);
    expect(input.lines[0]?.qtyReceived).toBe(2);
  });
});

/**
 * SP-124 — migration 0285 removed the DB's over_receive_blocked guard
 * (vendors over-ship; owner decision 2026-07-21). This route must not
 * reinstate it: the mobile outbox re-sends a 409 forever.
 */
describe('receive-line: over-receipt is allowed (0285)', () => {
  it('accepts a receipt against a line already at its ordered qty', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: { rows: [poLine(LINE_DONE, 10, 10)] },
      },
      { itemId: ITEM, qty: 2, warehouseId: WH, idempotencyKey: KEY },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { remainingAfter?: number };
    expect(postReceipt).toHaveBeenCalledTimes(1);
    // Negative = "2 over", the same variance the web receipt shows.
    expect(body.remainingAfter).toBe(-2);
  });

  it('accepts a qty larger than what is outstanding on the line', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 8)] },
      },
      { itemId: ITEM, qty: 5, warehouseId: WH, idempotencyKey: KEY },
    );
    expect(res.status).toBe(200);
    const input = postReceipt.mock.calls[0]?.[0] as {
      lines: { qtyReceived: number }[];
    };
    expect(input.lines[0]?.qtyReceived).toBe(5);
  });
});

describe('receive-line: guards that must survive', () => {
  it('refuses a closed PO with 409 po_closed', async () => {
    const res = await post(
      {
        purchase_orders: openPo({ status: 'received' }),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 0)] },
      },
      { itemId: ITEM, qty: 1, warehouseId: WH, idempotencyKey: KEY },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('po_closed');
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it('returns 404 not_on_po when the item is not on the PO', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: { rows: [] },
      },
      { itemId: ITEM, qty: 1, warehouseId: WH, idempotencyKey: KEY },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('not_on_po');
  });

  it('still 500s on a real read error from the line lookup', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: {
          rows: [],
          error: { code: '42P01', message: 'relation does not exist' },
        },
      },
      { itemId: ITEM, qty: 1, warehouseId: WH, idempotencyKey: KEY },
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('internal_error');
  });
});

describe('receive-line: ServiceError mapping', () => {
  const tables = () => ({
    purchase_orders: openPo(),
    purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 0)] },
  });

  it('maps validation_error (lot/serial checks) to 400, not 500', async () => {
    postReceipt.mockRejectedValueOnce(
      new ServiceError('validation_error', 'lot required'),
    );
    const res = await post(tables(), {
      itemId: ITEM,
      qty: 1,
      warehouseId: WH,
      idempotencyKey: KEY,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('maps module_disabled to 403', async () => {
    postReceipt.mockRejectedValueOnce(
      new ServiceError('module_disabled', 'Module not enabled: receiving'),
    );
    const res = await post(tables(), {
      itemId: ITEM,
      qty: 1,
      warehouseId: WH,
      idempotencyKey: KEY,
    });
    expect(res.status).toBe(403);
  });

  it('still maps conflict (idempotency) to 409', async () => {
    postReceipt.mockRejectedValueOnce(
      new ServiceError('conflict', 'idempotency_conflict'),
    );
    const res = await post(tables(), {
      itemId: ITEM,
      qty: 1,
      warehouseId: WH,
      idempotencyKey: KEY,
    });
    expect(res.status).toBe(409);
  });
});
