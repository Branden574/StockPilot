import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { assertModuleEnabled, assertPermission, ServiceError } from '@/server/services/context';
import { assertCanPostReceipt } from '@/server/services/lib/receipt-post-rule';
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
  /** Rows for the second and later reads of the table, in order (the last
   *  one repeats): the line read after the receipt sees what it recorded. */
  later?: Row[][];
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

/** The fixture for the nth read (0-based) of a table. */
function nthRead(fixture: TableFixture, n: number): TableFixture {
  if (n === 0 || !fixture.later || fixture.later.length === 0) return fixture;
  const rows = fixture.later[Math.min(n - 1, fixture.later.length - 1)]!;
  return { rows, error: fixture.error };
}

function buildCtx(tables: Record<string, TableFixture>) {
  const reads = new Map<string, number>();
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager' as const,
    mfaRequired: false,
    mfaSatisfied: true,
    // The module the receipt needs, so the route reaches the order.
    enabledModules: new Set<ModuleId>(['receiving']),
    supabase: {
      from: (table: string) => {
        const n = reads.get(table) ?? 0;
        reads.set(table, n + 1);
        return makeBuilder(nthRead(tables[table] ?? { rows: [] }, n));
      },
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
  vi.mocked(ReceivingService).mockImplementation(function () {
    return { postReceipt } as unknown as ReceivingService;
  });
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
        purchase_order_items: {
          rows: [poLine(LINE_DONE, 10, 10)],
          // The line after the receipt: 2 more received.
          later: [[poLine(LINE_DONE, 10, 12)]],
        },
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

describe('receive-line: the module and the permission are checked before the order is read', () => {
  const BODY = { itemId: ITEM, qty: 1, warehouseId: WH, idempotencyKey: KEY };
  const ORDER = () => ({
    purchase_orders: openPo(),
    purchase_order_items: { rows: [poLine(LINE_OPEN, 5, 0)] },
  });
  const NO_ORDER = () => ({});

  /** The route as a caller with `overrides`, recording every table it reads. */
  async function sendAs(overrides: Row, tables: Record<string, TableFixture>) {
    const read: string[] = [];
    vi.mocked(withApiContext).mockResolvedValue({
      ...buildCtx(tables),
      ...overrides,
      supabase: {
        from: (table: string) => {
          read.push(table);
          return makeBuilder(tables[table] ?? { rows: [] });
        },
      },
    } as never);
    const res = await POST(buildRequest(BODY), params);
    return { read, status: res.status, body: (await res.json()) as unknown };
  }

  const REFUSED: Array<[string, Row, () => void]> = [
    [
      'receiving is off',
      { enabledModules: new Set<ModuleId>() },
      () =>
        assertModuleEnabled(
          { ...buildCtx({}), enabledModules: new Set<ModuleId>() } as never,
          'receiving',
        ),
    ],
    [
      'the role cannot adjust stock',
      { role: 'viewer' },
      () => assertPermission({ ...buildCtx({}), role: 'viewer' } as never, 'stock:adjust'),
    ],
    [
      'a staff member (below manager)',
      { role: 'staff' },
      () => assertCanPostReceipt({ ...buildCtx({}), role: 'staff' } as never),
    ],
    [
      'a staff member granted purchase_orders:manage',
      {
        role: 'staff',
        permissions: new Set(['stock:adjust', 'purchase_orders:read', 'purchase_orders:manage']),
      },
      () =>
        assertCanPostReceipt({
          ...buildCtx({}),
          role: 'staff',
          permissions: new Set(['stock:adjust', 'purchase_orders:read', 'purchase_orders:manage']),
        } as never),
    ],
    [
      'an authenticator must be set up first',
      { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false },
      () =>
        assertPermission(
          { ...buildCtx({}), mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false } as never,
          'stock:adjust',
        ),
    ],
  ];

  it.each(REFUSED)(
    '%s: refused before any read, with the answer the receipt gives, whether or not the order exists',
    async (_label, overrides, refusal) => {
      // The receipt's own answer to the same refusal (the service refusing it).
      let thrown: unknown;
      try {
        refusal();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ServiceError);
      postReceipt.mockRejectedValueOnce(thrown);
      const fromTheReceipt = await sendAs({ enabledModules: new Set<ModuleId>(['receiving']) }, ORDER());

      const withOrder = await sendAs(overrides, ORDER());
      const withoutOrder = await sendAs(overrides, NO_ORDER());

      expect(withOrder.status).toBe(403);
      expect(withOrder.read).toEqual([]);
      expect(withoutOrder.read).toEqual([]);
      expect(withoutOrder).toEqual(withOrder);
      expect({ status: withOrder.status, body: withOrder.body }).toEqual({
        status: fromTheReceipt.status,
        body: fromTheReceipt.body,
      });
      expect(postReceipt).toHaveBeenCalledTimes(1);
    },
  );

  it('a member who passes the checks reads the order, then the receipt runs', async () => {
    const passed = await sendAs({}, ORDER());
    expect(passed.status).toBe(200);
    // The order, the receipt the key may already name, the line to receive
    // on, and that line again after the receipt.
    expect(passed.read).toEqual([
      'purchase_orders',
      'receipts',
      'purchase_order_items',
      'purchase_order_items',
    ]);
    const missing = await sendAs({}, NO_ORDER());
    expect(missing).toMatchObject({ status: 404, body: { error: 'po_not_found' } });
  });
});

describe('receive-line: a key that already names a receipt is answered from that receipt', () => {
  const RECEIPT = { id: 'r1', receipt_number: 'RCV-1' };
  const stored = (poLineId: string, itemId = ITEM): Record<string, TableFixture> => ({
    receipts: { rows: [{ id: RECEIPT.id, warehouse_id: WH }] },
    receipt_lines: { rows: [{ purchase_order_line_id: poLineId, item_id: itemId, unit_cost: 2 }] },
  });
  const BODY = { itemId: ITEM, qty: 1, warehouseId: WH, idempotencyKey: KEY };

  beforeEach(() => {
    postReceipt.mockResolvedValue(RECEIPT);
  });

  it('the same key twice: the same receipt, the same request, and remainingAfter is what the line holds', async () => {
    const first = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 0)], later: [[poLine(LINE_OPEN, 10, 1)]] },
      },
      BODY,
    );
    const again = await post(
      {
        purchase_orders: openPo(),
        ...stored(LINE_OPEN),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 1)] },
      },
      BODY,
    );
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    const b = (await again.json()) as Record<string, unknown>;
    expect(b).toEqual(a);
    expect(a).toMatchObject({ receiptId: 'r1', poLineId: LINE_OPEN, remainingAfter: 9 });
    expect(postReceipt).toHaveBeenCalledTimes(2);
    expect(postReceipt.mock.calls[1]?.[0]).toEqual(postReceipt.mock.calls[0]?.[0]);
  });

  it('an item on two lines: the retry sends the receipt\'s own line, not the next open one', async () => {
    const first = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: {
          rows: [poLine(LINE_DONE, 1, 0), poLine(LINE_OPEN, 5, 0)],
          later: [[poLine(LINE_DONE, 1, 1)]],
        },
      },
      BODY,
    );
    // The first line is complete after the first post, so a fresh pick would choose LINE_OPEN.
    const again = await post(
      {
        purchase_orders: openPo(),
        ...stored(LINE_DONE),
        purchase_order_items: { rows: [poLine(LINE_DONE, 1, 1)] },
      },
      BODY,
    );
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    const sent = postReceipt.mock.calls.map(
      (c) => (c[0] as { lines: { poLineId: string }[] }).lines[0]?.poLineId,
    );
    expect(sent).toEqual([LINE_DONE, LINE_DONE]);
    expect(postReceipt.mock.calls[1]?.[0]).toEqual(postReceipt.mock.calls[0]?.[0]);
  });

  it('the first post closed the order: the retry is answered with the receipt, not po_closed', async () => {
    const first = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 1, 0)], later: [[poLine(LINE_OPEN, 1, 1)]] },
      },
      BODY,
    );
    const again = await post(
      {
        purchase_orders: openPo({ status: 'received' }),
        ...stored(LINE_OPEN),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 1, 1)] },
      },
      BODY,
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(postReceipt.mock.calls[1]?.[0]).toEqual(postReceipt.mock.calls[0]?.[0]);
  });

  it('without a warehouse in the body, the retry sends the receipt\'s own warehouse', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        ...stored(LINE_OPEN),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 1)] },
      },
      { itemId: ITEM, qty: 1, idempotencyKey: KEY },
    );
    expect(res.status).toBe(200);
    expect((postReceipt.mock.calls[0]?.[0] as { warehouseId: string }).warehouseId).toBe(WH);
  });

  it('a key that names a receipt of another item is sent as a new request, on the line its item picks', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        ...stored(LINE_DONE, '55555555-5555-4555-8555-555555555555'),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 1)] },
      },
      BODY,
    );
    expect(res.status).toBe(200);
    expect(postReceipt).toHaveBeenCalledTimes(1);
    expect(
      (postReceipt.mock.calls[0]?.[0] as { lines: { poLineId: string }[] }).lines[0]?.poLineId,
    ).toBe(LINE_OPEN);
  });

  it('a key that names a receipt of two lines is sent as a new request', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        receipts: { rows: [{ id: RECEIPT.id, warehouse_id: WH }] },
        receipt_lines: {
          rows: [
            { purchase_order_line_id: LINE_DONE, item_id: ITEM, unit_cost: 2 },
            { purchase_order_line_id: LINE_OPEN, item_id: ITEM, unit_cost: 2 },
          ],
        },
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 1)] },
      },
      BODY,
    );
    expect(res.status).toBe(200);
    expect(
      (postReceipt.mock.calls[0]?.[0] as { lines: { poLineId: string }[] }).lines[0]?.poLineId,
    ).toBe(LINE_OPEN);
  });

  it('a failed read of the key answers 500 with nothing posted', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        receipts: { rows: [], error: { code: '57014', message: 'canceling statement' } },
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 0)] },
      },
      BODY,
    );
    expect(res.status).toBe(500);
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it('a failed read of the line after the receipt answers the receipt with remainingAfter null', async () => {
    const res = await post(
      {
        purchase_orders: openPo(),
        purchase_order_items: { rows: [poLine(LINE_OPEN, 10, 0)], later: [[]] },
      },
      BODY,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ receiptId: 'r1', remainingAfter: null });
  });
});
