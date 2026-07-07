import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import {
  ActivityService,
  collectReceiptLineIds,
  receiptLineSummary,
  resolveReceiptPoNumbers,
} from './activity';

beforeEach(() => {
  vi.clearAllMocks();
});

// ActivityService.forItem uses the constructor (private), so we use a
// little helper to instantiate it from a ctx — bypassing the private
// constructor via the JS-accessible class shape.
function makeService(client: unknown): ActivityService {
  // The constructor is `private` at the type level only; we still reach it
  // via `new` here because TypeScript private is structural at runtime.
   
  return new (ActivityService as any)(makeServiceContext(client));
}

describe('ActivityService.forItem', () => {
  it('merges movement + audit events and sorts by createdAt desc', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm-old',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 5,
            reason: 'restock',
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'u1',
          },
          {
            id: 'm-new',
            movement_type: 'transfer',
            quantity_change: -2,
            new_quantity: 3,
            reason: null,
            notes: 'moved to A',
            created_at: '2025-03-01T00:00:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
      'audit_logs.select': {
        data: [
          {
            id: 'a1',
            event: 'item.updated',
            metadata: { reason: 'rename' },
            created_at: '2025-02-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'user_profiles.select': {
        data: [{ id: 'u1', full_name: 'Alice', email: 'a@x.com' }],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.id)).toEqual(['m:m-new', 'a:a1', 'm:m-old']);
  });

  it('falls back to "System" when movement has null user_id', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'initial',
            quantity_change: 10,
            new_quantity: 10,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe('System');
    expect(events[0]!.actorEmail).toBeNull();
  });

  it('looks up user_profiles via in() with the merged set of user_ids', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 1,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': {
        data: [
          {
            id: 'a1',
            event: 'item.updated',
            metadata: {},
            created_at: '2025-01-02T00:00:00.000Z',
            user_id: 'u2',
          },
        ],
        error: null,
      },
      'user_profiles.select': {
        data: [
          { id: 'u1', full_name: 'Alice', email: 'a@x.com' },
          { id: 'u2', full_name: null, email: 'b@x.com' },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');

    const chain = stub.chains.get('user_profiles.select') ?? [];
    const args = stub.chainArgs.get('user_profiles.select') ?? [];
    const inIdx = chain.indexOf('in');
    expect(inIdx).toBeGreaterThan(-1);
    expect(args[inIdx]![0]).toBe('id');
    // Order is not guaranteed (Set iteration), so compare as sorted lists.
    expect([...(args[inIdx]![1] as string[])].sort()).toEqual(['u1', 'u2']);
  });

  it('skips the user_profiles lookup entirely when no user_ids are present', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');
    expect(stub.fromCalls).not.toContain('user_profiles');
  });

  it('uses email when full_name is null', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 1,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'user_profiles.select': {
        data: [{ id: 'u1', full_name: null, email: 'who@x.com' }],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.actor).toBe('who@x.com');
    expect(events[0]!.actorEmail).toBe('who@x.com');
  });

  it('"Unknown" when user_id has no matching profile row', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            quantity_change: 1,
            new_quantity: 1,
            reason: null,
            notes: null,
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: 'ghost',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'user_profiles.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.actor).toBe('Unknown');
    expect(events[0]!.actorEmail).toBeNull();
  });

  it('caps total events at the requested limit', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: Array.from({ length: 20 }, (_, i) => ({
          id: `m${i}`,
          movement_type: 'adjust',
          quantity_change: 1,
          new_quantity: 1,
          reason: null,
          notes: null,
          // Newer first so they win the sort.
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
      'audit_logs.select': {
        data: Array.from({ length: 20 }, (_, i) => ({
          id: `a${i}`,
          event: 'item.updated',
          metadata: {},
          created_at: new Date(2024, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1', 6);
    expect(events).toHaveLength(6);
  });

  it('passes ceil(limit / 1.5) as the per-source limit', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    // limit=30 ⇒ halfLimit = ceil(30 / 1.5) = 20
    await svc.forItem('item-1', 30);

    const movChain = stub.chains.get('stock_movements.select') ?? [];
    const movArgs = stub.chainArgs.get('stock_movements.select') ?? [];
    const movLimitIdx = movChain.indexOf('limit');
    expect(movArgs[movLimitIdx]![0]).toBe(20);

    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    const auditArgs = stub.chainArgs.get('audit_logs.select') ?? [];
    const auditLimitIdx = auditChain.indexOf('limit');
    expect(auditArgs[auditLimitIdx]![0]).toBe(20);
  });

  it('uses metadata.reason as audit summary when present', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': {
        data: [
          {
            id: 'a1',
            event: 'item.archived',
            metadata: { reason: 'EOL product' },
            created_at: '2025-01-01T00:00:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.kind).toBe('audit');
    expect(events[0]!.summary).toBe('EOL product');
    expect(events[0]!.delta).toBeNull();
    expect(events[0]!.quantityAfter).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issues 3 + 4 display mapping (migration 0231): transfers surface
// moved_quantity + location ids; pre-0231 receipt rows ('receipt_line') are
// batch-resolved to 'PO {number}' with a 'PO receipt' fallback.
// ─────────────────────────────────────────────────────────────────────────────

const RECEIPT_ID = '11111111-2222-3333-4444-555555555555';

function movementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    movement_type: 'adjust',
    quantity_change: 1,
    new_quantity: 10,
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: null,
    notes: null,
    created_at: '2025-01-01T00:00:00.000Z',
    user_id: null,
    ...overrides,
  };
}

describe('receipt_line display helpers', () => {
  it('collectReceiptLineIds keeps only receipt_line rows with uuid notes, de-duplicated', () => {
    expect(
      collectReceiptLineIds([
        { reason: 'receipt_line', notes: RECEIPT_ID },
        { reason: 'receipt_line', notes: ` ${RECEIPT_ID} ` }, // trimmed dup
        { reason: 'receipt_line', notes: 'not-a-uuid' },
        { reason: 'receipt_line', notes: null },
        { reason: 'PO PO-9', notes: RECEIPT_ID }, // new-style row: not collected
        { reason: null, notes: RECEIPT_ID },
      ]),
    ).toEqual([RECEIPT_ID]);
  });

  it("receiptLineSummary resolves to 'PO {number}', falling back to 'PO receipt'", () => {
    const map = new Map([[RECEIPT_ID, 'PO-2026-014']]);
    expect(receiptLineSummary(RECEIPT_ID, map)).toBe('PO PO-2026-014');
    expect(receiptLineSummary(RECEIPT_ID, new Map())).toBe('PO receipt');
    expect(receiptLineSummary(null, new Map())).toBe('PO receipt');
  });

  it('resolveReceiptPoNumbers resolves ids in one query and skips empty lists', async () => {
    const stub = makeSupabaseStub({
      'receipts.select': {
        data: [{ id: RECEIPT_ID, purchase_orders: { po_number: 'PO-77' } }],
        error: null,
      },
    });
    const map = await resolveReceiptPoNumbers(makeServiceContext(stub.client), [RECEIPT_ID]);
    expect(map.get(RECEIPT_ID)).toBe('PO-77');
    expect(stub.fromCalls).toEqual(['receipts']);

    const emptyStub = makeSupabaseStub();
    const emptyMap = await resolveReceiptPoNumbers(makeServiceContext(emptyStub.client), []);
    expect(emptyMap.size).toBe(0);
    expect(emptyStub.fromCalls).toEqual([]);
  });

  it('resolveReceiptPoNumbers degrades to an empty map on a query error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = makeSupabaseStub({
      'receipts.select': { data: null, error: { message: 'boom' } },
    });
    const map = await resolveReceiptPoNumbers(makeServiceContext(stub.client), [RECEIPT_ID]);
    expect(map.size).toBe(0);
    spy.mockRestore();
  });
});

describe('ActivityService.forItem display mapping (0231)', () => {
  it("maps an OLD receipt row (reason='receipt_line', notes=receipt id) to 'PO {number}'", async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-old',
            movement_type: 'receive_po',
            quantity_change: 5,
            reason: 'receipt_line',
            notes: RECEIPT_ID,
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'receipts.select': {
        data: [{ id: RECEIPT_ID, purchase_orders: { po_number: 'PO-2026-014' } }],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.summary).toBe('PO PO-2026-014');
    expect(events[0]!.type).toBe('receive_po');
  });

  it("falls back to 'PO receipt' for an unresolvable old receipt row", async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-orphan',
            movement_type: 'receive_po',
            reason: 'receipt_line',
            notes: RECEIPT_ID,
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'receipts.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.summary).toBe('PO receipt');
  });

  it("passes a NEW receipt row's 'PO {n}' reason through with no receipts lookup", async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-new',
            movement_type: 'receive_po',
            reason: 'PO PO-88',
            notes: RECEIPT_ID,
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.summary).toBe('PO PO-88');
    // No receipt_line rows → the extra receipts query never fires.
    expect(stub.fromCalls).not.toContain('receipts');
  });

  it('surfaces movedQuantity + from/to location ids for transfers (delta stays 0)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-tx',
            movement_type: 'transfer',
            quantity_change: 0,
            new_quantity: 500,
            moved_quantity: '250', // numeric arrives as string via PostgREST
            from_location_id: 'loc-a',
            to_location_id: 'loc-b',
            notes: 'restock front rack',
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    const e = events[0]!;
    expect(e.delta).toBe(0);
    expect(e.movedQuantity).toBe(250);
    expect(e.fromLocationId).toBe('loc-a');
    expect(e.toLocationId).toBe('loc-b');
    expect(e.summary).toBe('restock front rack');
  });

  it('keeps movedQuantity null on OLD transfer rows (display shows no number, not 0)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-tx-old',
            movement_type: 'transfer',
            quantity_change: 0,
            moved_quantity: null,
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.movedQuantity).toBeNull();
  });
});
