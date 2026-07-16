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

import { nextActivityCursor } from '@/lib/activity-pagination';

import {
  ActivityService,
  auditLimitFor,
  collectReceiptLineIds,
  receiptLineSummary,
  resolveBundleNames,
  resolveOrderNumbers,
  resolveReceiptPoNumbers,
  resolveReturnNumbers,
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

describe('auditLimitFor', () => {
  it('halves the limit, rounding up, with a floor of 1', () => {
    expect(auditLimitFor(30)).toBe(15);
    expect(auditLimitFor(6)).toBe(3);
    expect(auditLimitFor(1)).toBe(1);
    expect(auditLimitFor(50)).toBe(25);
  });
});

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

  it('passes the FULL requested limit to movements and a separate (smaller) limit to audit', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    // limit=30 ⇒ movementLimit=30 (the full ask), auditLimit=ceil(30/2)=15 —
    // NOT the old shared halfLimit=ceil(30/1.5)=20 for both. Movements never
    // get less than the caller asked for just because audit rows exist.
    await svc.forItem('item-1', 30);

    const movChain = stub.chains.get('stock_movements.select') ?? [];
    const movArgs = stub.chainArgs.get('stock_movements.select') ?? [];
    const movLimitIdx = movChain.indexOf('limit');
    expect(movArgs[movLimitIdx]![0]).toBe(30);

    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    const auditArgs = stub.chainArgs.get('audit_logs.select') ?? [];
    const auditLimitIdx = auditChain.indexOf('limit');
    expect(auditArgs[auditLimitIdx]![0]).toBe(15);
  });

  // ── Real bug (Issue 6): audit rows must never crowd movements out ───────
  //
  // The old implementation queried movements + audit at the SAME halved
  // limit, merged them, sorted by recency, then sliced the COMBINED list
  // down to `limit` total. If audit rows happened to be more numerous or
  // more recent than movements, that final slice could — and did — throw
  // away legitimately-fetched movement rows. The Movements tab (item-detail
  // filters this feed to kind==='movement') would then show FEWER than
  // `limit` real movements even though more existed and were fetched.
  //
  // This test is the RED→GREEN case: against the old code (shared halved
  // limit + final combined slice), with 8 movements older than 8 audit
  // rows and limit=6, the merged-then-sliced top 6 are ALL audit rows —
  // zero movements survive. Against the fixed code (separate caps, no
  // final combined slice), all `movementLimit` movements always come
  // through untouched by audit volume/recency.
  it('never crowds movements out of the feed with newer/more-numerous audit rows (regression)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: Array.from({ length: 8 }, (_, i) => ({
          id: `m${i}`,
          movement_type: 'adjust',
          quantity_change: 1,
          previous_quantity: i,
          new_quantity: i + 1,
          reason: null,
          notes: null,
          // All older than every audit row below.
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
      'audit_logs.select': {
        data: Array.from({ length: 8 }, (_, i) => ({
          id: `a${i}`,
          event: 'item.updated',
          metadata: {},
          // All newer than every movement row above.
          created_at: new Date(2025, 2, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1', 6);
    const movementEvents = events.filter((e) => e.kind === 'movement');
    // movementLimit === the requested limit (6) — every fetched movement
    // row survives regardless of how many newer audit rows exist.
    expect(movementEvents).toHaveLength(6);
  });

  it('caps audit rows at their own (smaller) limit, independently of movement volume', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': {
        data: Array.from({ length: 8 }, (_, i) => ({
          id: `a${i}`,
          event: 'item.updated',
          metadata: {},
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1', 6); // auditLimit = ceil(6/2) = 3
    expect(events).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Movement/Activity P4 (review fix): "Load older" composite keyset cursor.
  // `before` is a PER-KIND `{ createdAt, id }` boundary applied via
  // PostgREST's `.or(a,and(b,c))` predicate — "created_at < X OR (created_at
  // = X AND id < Y)" — paired with a secondary `.order('id', …)` sort so
  // `(created_at, id)` is a total, tie-free order. Per-kind caps
  // (movementLimit/auditLimit) are otherwise unchanged.
  // ─────────────────────────────────────────────────────────────────────

  const CURSOR_ID_MOV = '99999999-9999-9999-9999-999999999999';
  const CURSOR_ID_AUD = '88888888-8888-8888-8888-888888888888';

  /** Pulls out every `.order(...)` call's args, in call order, from a
   *  recorded chain — `chain`/`args` are parallel arrays (see supabase-mock). */
  function orderCalls(chain: string[], args: unknown[][]): unknown[][] {
    return chain.reduce<unknown[][]>((acc, method, i) => {
      if (method === 'order') acc.push(args[i]!);
      return acc;
    }, []);
  }

  it('applies the composite (created_at, id) keyset predicate to BOTH queries when a per-kind cursor is passed', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1', 30, {
      before: {
        movement: { createdAt: '2025-06-01T00:00:00.000Z', id: CURSOR_ID_MOV },
        audit: { createdAt: '2025-05-01T00:00:00.000Z', id: CURSOR_ID_AUD },
      },
    });

    const movChain = stub.chains.get('stock_movements.select') ?? [];
    const movArgs = stub.chainArgs.get('stock_movements.select') ?? [];
    const movOrIdx = movChain.indexOf('or');
    expect(movOrIdx).toBeGreaterThan(-1);
    expect(movArgs[movOrIdx]).toEqual([
      `created_at.lt.2025-06-01T00:00:00.000Z,and(created_at.eq.2025-06-01T00:00:00.000Z,id.lt.${CURSOR_ID_MOV})`,
    ]);
    // Secondary sort by id makes the ordering deterministic at a tie —
    // required for the keyset predicate above to be correct.
    expect(orderCalls(movChain, movArgs)).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);

    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    const auditArgs = stub.chainArgs.get('audit_logs.select') ?? [];
    const auditOrIdx = auditChain.indexOf('or');
    expect(auditOrIdx).toBeGreaterThan(-1);
    expect(auditArgs[auditOrIdx]).toEqual([
      `created_at.lt.2025-05-01T00:00:00.000Z,and(created_at.eq.2025-05-01T00:00:00.000Z,id.lt.${CURSOR_ID_AUD})`,
    ]);
    expect(orderCalls(auditChain, auditArgs)).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('applies the cursor to only the kind that has one — the other kind\'s query stays unfiltered', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    // Movements exhausted already (no cursor for it); audits still paging.
    await svc.forItem('item-1', 30, {
      before: { audit: { createdAt: '2025-05-01T00:00:00.000Z', id: CURSOR_ID_AUD } },
    });

    expect(stub.chains.get('stock_movements.select') ?? []).not.toContain('or');
    const auditChain = stub.chains.get('audit_logs.select') ?? [];
    expect(auditChain).toContain('or');
  });

  it('omits the keyset predicate entirely on both queries when no cursor is passed (byte-identical to before this feature)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');

    expect(stub.chains.get('stock_movements.select') ?? []).not.toContain('or');
    expect(stub.chains.get('stock_movements.select') ?? []).not.toContain('lt');
    expect(stub.chains.get('audit_logs.select') ?? []).not.toContain('lt');
  });

  it('keeps the separate per-kind caps intact when paging with a cursor (no combined slice)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: Array.from({ length: 8 }, (_, i) => ({
          id: `m${i}`,
          movement_type: 'adjust',
          quantity_change: 1,
          previous_quantity: i,
          new_quantity: i + 1,
          reason: null,
          notes: null,
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
      'audit_logs.select': {
        data: Array.from({ length: 8 }, (_, i) => ({
          id: `a${i}`,
          event: 'item.updated',
          metadata: {},
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1', 6, {
      before: {
        movement: { createdAt: '2025-06-01T00:00:00.000Z', id: CURSOR_ID_MOV },
        audit: { createdAt: '2025-06-01T00:00:00.000Z', id: CURSOR_ID_AUD },
      },
    });
    const movementEvents = events.filter((e) => e.kind === 'movement');
    const auditEvents = events.filter((e) => e.kind === 'audit');
    expect(movementEvents).toHaveLength(6); // movementLimit === the requested limit
    expect(auditEvents).toHaveLength(3); // auditLimit === ceil(6/2)
  });

  // ── REQUIRED regression (Blocker 1): a same-`created_at` tie straddling
  // the cap boundary must survive to the next page. This models what a REAL
  // Postgres does under the fixed keyset predicate: page 1's `.limit()` cuts
  // a tie group in half (kept: the row whose id sorts higher under `ORDER
  // BY created_at DESC, id DESC`); page 2, seeded with the composite cursor
  // `nextActivityCursor` computed from page 1, must return the sibling row
  // the cap cut off.
  //
  // Why this is the case the OLD tests missed: every prior cursor test used
  // rows with DISTINCT timestamps, so a bare `created_at` boundary was
  // indistinguishable from a composite one — both would work. Two rows
  // sharing the EXACT SAME `created_at` is the only shape that exposes the
  // bug: the OLD `nextActivityCursor` returned the bare string
  // '2025-04-01T00:00:00.000Z' for this page, and old `forItem` would apply
  // `.lt('created_at', '2025-04-01T00:00:00.000Z')` on page 2 — which a real
  // Postgres evaluates as `created_at < X`, excluding BOTH tied rows
  // (including `m-tie-1` below, forever). Verified directly: reverting
  // `nextActivityCursor`/`forItem` to the pre-fix (string-cursor, `.lt`-only)
  // implementation and re-running this exact test fails the final
  // assertion — page 2 comes back with zero movements instead of
  // `m-tie-1` (see the P4 review fix-up's verification notes).
  // ─────────────────────────────────────────────────────────────────────

  it('a tie at the cap boundary: the row cut off by page 1 is returned on page 2, not skipped', async () => {
    const TIE_CREATED_AT = new Date(2025, 3, 1, 0, 0).toISOString();
    const NEWER_CREATED_AT = new Date(2025, 4, 1, 0, 0).toISOString();

    function tieMovementRow(id: string, createdAt: string) {
      return {
        id,
        movement_type: 'adjust',
        quantity_change: 1,
        previous_quantity: 0,
        new_quantity: 1,
        reason: null,
        notes: null,
        created_at: createdAt,
        user_id: null,
      };
    }

    // Page 1: a real Postgres running
    //   ORDER BY created_at DESC, id DESC LIMIT 2
    // over {m-newer (NEWER), m-tie-2 (TIE), m-tie-1 (TIE)} keeps m-newer and
    // m-tie-2 ('m-tie-2' > 'm-tie-1' lexicographically, so it sorts first
    // among the tied pair) — m-tie-1 is cut off by the limit.
    const page1Stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          tieMovementRow('m-newer', NEWER_CREATED_AT),
          tieMovementRow('m-tie-2', TIE_CREATED_AT),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc1 = makeService(page1Stub.client);
    const page1Events = await svc1.forItem('item-1', 2);

    expect(page1Events.map((e) => e.id)).toEqual(['m:m-newer', 'm:m-tie-2']);

    const cursor = nextActivityCursor(page1Events);
    // The composite boundary pins BOTH the tied timestamp AND the exact row
    // id that made the cut — not just the bare timestamp.
    expect(cursor).toEqual({ movement: { createdAt: TIE_CREATED_AT, id: 'm-tie-2' } });

    // Page 2: a real Postgres running the SAME query with the keyset
    // predicate `created_at < TIE_CREATED_AT OR (created_at = TIE_CREATED_AT
    // AND id < 'm-tie-2')` correctly matches m-tie-1 ('m-tie-1' < 'm-tie-2'
    // AND created_at is equal) — nothing else remains.
    const page2Stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [tieMovementRow('m-tie-1', TIE_CREATED_AT)],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc2 = makeService(page2Stub.client);
    const page2Events = await svc2.forItem('item-1', 2, { before: cursor! });

    // Plumbing check: the SAME cursor value computed above is exactly what
    // reached the query as the `.or()` predicate.
    const movChain = page2Stub.chains.get('stock_movements.select') ?? [];
    const movArgs = page2Stub.chainArgs.get('stock_movements.select') ?? [];
    const orIdx = movChain.indexOf('or');
    expect(movArgs[orIdx]).toEqual([
      `created_at.lt.${TIE_CREATED_AT},and(created_at.eq.${TIE_CREATED_AT},id.lt.m-tie-2)`,
    ]);

    // The crux: the tied row page 1's cap cut off is NOT lost.
    expect(page2Events.map((e) => e.id)).toEqual(['m:m-tie-1']);
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
    expect(events[0]!.reason).toBe('EOL product');
    expect(events[0]!.delta).toBeNull();
    expect(events[0]!.quantityAfter).toBeNull();
    expect(events[0]!.previousQuantity).toBeNull();
    expect(events[0]!.referenceType).toBeNull();
    expect(events[0]!.referenceId).toBeNull();
    expect(events[0]!.referenceLabel).toBeNull();
    expect(events[0]!.notes).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Movement/Activity P2 Task 2: movement-shadowing stock.* audit events
// (stock.adjusted/transferred/received/removed) are suppressed from the item
// feed — the movement row already represents the same change with a richer
// prev→after / from→to display (P1). Every other audit event is untouched.
// See MOVEMENT_SHADOWED_AUDIT_EVENTS in activity.ts for the full rationale.
// ─────────────────────────────────────────────────────────────────────────────

describe('ActivityService.forItem suppresses movement-shadowing audit events', () => {
  it('returns the movement row and drops its paired stock.adjusted audit row', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm-adj',
            movement_type: 'adjust',
            quantity_change: -5,
            previous_quantity: 20,
            new_quantity: 15,
            reason: 'cycle count correction',
            notes: null,
            created_at: '2025-04-01T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': {
        data: [
          {
            id: 'a-adj',
            event: 'stock.adjusted',
            metadata: {
              entity_id: 'item-1',
              before: { quantity_on_hand: 20 },
              after: { quantity_on_hand: 15 },
            },
            created_at: '2025-04-01T00:00:00.001Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('m:m-adj');
    expect(events[0]!.kind).toBe('movement');
    expect(events.some((e) => e.id === 'a:a-adj')).toBe(false);
  });

  it('still returns a non-shadowed audit event (inventory.item.updated) with metadata before/after intact', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': {
        data: [
          {
            id: 'a-upd',
            event: 'inventory.item.updated',
            metadata: {
              entity_id: 'item-1',
              before: { name: 'Old Name' },
              after: { name: 'New Name' },
              changed_keys: ['name'],
            },
            created_at: '2025-04-02T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('a:a-upd');
    expect(events[0]!.kind).toBe('audit');
    expect(events[0]!.metadata).toEqual({
      entity_id: 'item-1',
      before: { name: 'Old Name' },
      after: { name: 'New Name' },
      changed_keys: ['name'],
    });
  });

  it('suppresses a stock.transferred audit row even when no movement row exists for it', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': {
        data: [
          {
            id: 'a-tx',
            event: 'stock.transferred',
            metadata: {
              entity_id: 'item-1',
              before: { location_id: 'loc-a' },
              after: { location_id: 'loc-b' },
            },
            created_at: '2025-04-03T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(0);
  });

  it('suppresses stock.received and stock.removed alongside stock.adjusted/transferred', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': {
        data: [
          {
            id: 'a-rcv',
            event: 'stock.received',
            metadata: {},
            created_at: '2025-04-04T00:00:00.000Z',
            user_id: null,
          },
          {
            id: 'a-rem',
            event: 'stock.removed',
            metadata: {},
            created_at: '2025-04-04T00:01:00.000Z',
            user_id: null,
          },
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(0);
  });

  it("pushes the exclusion down to the query ('.not(event, in, ...)') alongside the org/entity filters", async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');

    const chain = stub.chains.get('audit_logs.select') ?? [];
    const args = stub.chainArgs.get('audit_logs.select') ?? [];
    const notIdx = chain.indexOf('not');
    expect(notIdx).toBeGreaterThan(-1);
    expect(args[notIdx]).toEqual([
      'event',
      'in',
      '(stock.adjusted,stock.transferred,stock.received,stock.removed)',
    ]);
  });

  it('per-kind caps still hold: shadowed audit rows never crowd out real audit rows within auditLimit, and movements are unaffected', async () => {
    const stub = makeSupabaseStub({
      // 4 real movements — movementLimit should return all 4, untouched by
      // anything happening on the audit side.
      'stock_movements.select': {
        data: Array.from({ length: 4 }, (_, i) => ({
          id: `m${i}`,
          movement_type: 'adjust',
          quantity_change: 1,
          previous_quantity: i,
          new_quantity: i + 1,
          reason: null,
          notes: null,
          created_at: new Date(2025, 0, 1, 0, i).toISOString(),
          user_id: null,
        })),
        error: null,
      },
      // 4 shadowed stock.* rows + 4 real item-updated rows. A real DB would
      // never return the shadowed rows at all (the `.not()` filter excludes
      // them before LIMIT is applied) — this test models the JS-level
      // defensive filter by including them in the mocked "raw" query result
      // anyway, the same way this in-memory mock doesn't evaluate `.not()`
      // semantics. limit=6 -> auditLimit=ceil(6/2)=3.
      'audit_logs.select': {
        data: [
          ...Array.from({ length: 4 }, (_, i) => ({
            id: `shadow${i}`,
            event: 'stock.adjusted',
            metadata: {},
            created_at: new Date(2025, 2, 1, 0, i).toISOString(),
            user_id: null,
          })),
          ...Array.from({ length: 4 }, (_, i) => ({
            id: `real${i}`,
            event: 'inventory.item.updated',
            metadata: {},
            created_at: new Date(2025, 1, 1, 0, i).toISOString(),
            user_id: null,
          })),
        ],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1', 6);
    const movementEvents = events.filter((e) => e.kind === 'movement');
    const auditEvents = events.filter((e) => e.kind === 'audit');

    // Movements: full movementLimit (4, all that exist) survives untouched —
    // shadowed audit volume never affects the movement side of the cap.
    expect(movementEvents).toHaveLength(4);
    expect(movementEvents.map((e) => e.id).sort()).toEqual(
      ['m:m0', 'm:m1', 'm:m2', 'm:m3'].sort(),
    );

    // Audits: auditLimit=3 real rows — none of the 4 shadowed rows survive,
    // and all 3 kept rows are real (non-shadowed) events, not wasted slots.
    expect(auditEvents).toHaveLength(3);
    expect(auditEvents.every((e) => e.id.startsWith('a:real'))).toBe(true);
    expect(auditEvents.some((e) => e.id.startsWith('a:shadow'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Movement/Activity P3 Task 1 defense: InventoryService.archive()/
// softDelete() used to insert a FICTIONAL stock_movements row
// (movement_type='adjust', reason='item_archived'/'item_deleted') that never
// corresponded to a real stock change. The insert has been removed at the
// source and a one-time migration (0271) purges any rows it already wrote,
// but `forItem` also filters LIFECYCLE_REASON_MOVEMENTS as a defensive
// backstop for any org whose cleanup hasn't run (or a future accidental
// write).
//
// Unlike MOVEMENT_SHADOWED_AUDIT_EVENTS, this filtering happens ONLY in JS,
// never at the query layer: `stock_movements.reason` is nullable (most
// 'initial' rows and many 'add'/'transfer' rows carry `reason: null`), and
// PostgREST's `.not(col, 'in', (...))` compiles to `NOT (col = ANY(...))`,
// which is NULL — not TRUE — when `col` is NULL, so Postgres drops the row.
// A query-layer `.not('reason', 'in', ...)` here would silently discard
// every null-reason movement from the item feed (verified against prod:
// 61% of movements have a null reason).
// ─────────────────────────────────────────────────────────────────────────────

describe('ActivityService.forItem filters legacy lifecycle-reason movements', () => {
  it('drops a legacy item_archived movement row while keeping a real movement', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm-real',
            movement_type: 'adjust',
            quantity_change: -5,
            previous_quantity: 20,
            new_quantity: 15,
            reason: 'cycle count correction',
            notes: null,
            created_at: '2025-05-01T00:00:00.000Z',
            user_id: 'u1',
          },
          {
            id: 'm-fictional',
            movement_type: 'adjust',
            quantity_change: -20,
            previous_quantity: 20,
            new_quantity: 0,
            reason: 'item_archived',
            notes: null,
            created_at: '2025-05-02T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'm:m-real',
      kind: 'movement',
      type: 'adjust',
      delta: -5,
      previousQuantity: 20,
      quantityAfter: 15,
      reason: 'cycle count correction',
    });
    expect(events.some((e) => e.id === 'm:m-fictional')).toBe(false);
  });

  it('drops a legacy item_deleted movement row too', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm-fictional-del',
            movement_type: 'adjust',
            quantity_change: -8,
            previous_quantity: 8,
            new_quantity: 0,
            reason: 'item_deleted',
            notes: null,
            created_at: '2025-05-03T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events).toHaveLength(0);
  });

  it('keeps null-reason movements (e.g. initial, transfer) while still dropping legacy lifecycle rows', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm-initial',
            movement_type: 'initial',
            quantity_change: 10,
            previous_quantity: 0,
            new_quantity: 10,
            reason: null,
            notes: null,
            created_at: '2025-05-01T00:00:00.000Z',
            user_id: 'u1',
          },
          {
            id: 'm-transfer',
            movement_type: 'transfer',
            quantity_change: 0,
            previous_quantity: 10,
            new_quantity: 10,
            moved_quantity: 4,
            reason: null,
            notes: null,
            created_at: '2025-05-02T00:00:00.000Z',
            user_id: 'u1',
          },
          {
            id: 'm-fictional',
            movement_type: 'adjust',
            quantity_change: -10,
            previous_quantity: 10,
            new_quantity: 0,
            reason: 'item_archived',
            notes: null,
            created_at: '2025-05-03T00:00:00.000Z',
            user_id: 'u1',
          },
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id).sort()).toEqual(['m:m-initial', 'm:m-transfer']);
    expect(events.some((e) => e.id === 'm:m-fictional')).toBe(false);
  });

  it('does NOT filter stock_movements at the query layer (reason is nullable — a .not(reason, in, …) there would drop null-reason rows)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    await svc.forItem('item-1');

    const chain = stub.chains.get('stock_movements.select') ?? [];
    expect(chain).not.toContain('not');
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
    previous_quantity: 9,
    new_quantity: 10,
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: null,
    reference_type: null,
    reference_id: null,
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

// ─────────────────────────────────────────────────────────────────────────────
// Issue 4: clickable source links — the four reference-label batch resolvers.
// Each mirrors resolveReceiptPoNumbers's contract: one batched query, skips
// the query entirely on an empty id list, and degrades to an empty map on
// error (never throws, never breaks the feed).
// ─────────────────────────────────────────────────────────────────────────────

describe('reference-label resolvers', () => {
  it('resolveOrderNumbers formats order_number via formatOrderNumber and skips unresolved rows', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: [
          { id: 'req-1', order_number: 49 },
          { id: 'req-2', order_number: null },
        ],
        error: null,
      },
    });
    const map = await resolveOrderNumbers(makeServiceContext(stub.client), ['req-1', 'req-2']);
    expect(map.get('req-1')).toBe('SO-000049');
    expect(map.has('req-2')).toBe(false);
  });

  it('resolveOrderNumbers skips the query entirely on an empty id list', async () => {
    const stub = makeSupabaseStub();
    const map = await resolveOrderNumbers(makeServiceContext(stub.client), []);
    expect(map.size).toBe(0);
    expect(stub.fromCalls).toEqual([]);
  });

  it('resolveOrderNumbers degrades to an empty map on a query error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = makeSupabaseStub({
      'order_requests.select': { data: null, error: { message: 'boom' } },
    });
    const map = await resolveOrderNumbers(makeServiceContext(stub.client), ['req-1']);
    expect(map.size).toBe(0);
    spy.mockRestore();
  });

  it('resolveReturnNumbers resolves return_number and skips unresolved rows', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [
          { id: 'ret-1', return_number: 'RMA-1029' },
          { id: 'ret-2', return_number: null },
        ],
        error: null,
      },
    });
    const map = await resolveReturnNumbers(makeServiceContext(stub.client), ['ret-1', 'ret-2']);
    expect(map.get('ret-1')).toBe('RMA-1029');
    expect(map.has('ret-2')).toBe(false);
  });

  it('resolveBundleNames resolves the bundle name', async () => {
    const stub = makeSupabaseStub({
      'bundles.select': {
        data: [{ id: 'bun-1', name: 'Back-to-School Kit' }],
        error: null,
      },
    });
    const map = await resolveBundleNames(makeServiceContext(stub.client), ['bun-1']);
    expect(map.get('bun-1')).toBe('Back-to-School Kit');
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
    expect(events[0]!.reason).toBe('PO PO-2026-014');
    expect(events[0]!.type).toBe('receive_po');
    // The receipt uuid living in `notes` is an internal implementation
    // detail (already consumed to produce the human reason above) — never
    // surfaced to the user as if it were their own free-text note.
    expect(events[0]!.notes).toBeNull();
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
    expect(events[0]!.reason).toBe('PO receipt');
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
    expect(events[0]!.reason).toBe('PO PO-88');
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
    // Issue 3: reason (empty here) and notes are two SEPARATE fields now —
    // notes is never used to fill in a missing reason (that conflation was
    // exactly the bug: it made reason+notes indistinguishable downstream).
    expect(e.reason).toBeNull();
    expect(e.notes).toBe('restock front rack');
  });

  // ── Issue 1: previous_quantity threaded onto the event ───────────────────

  it('threads previous_quantity onto the event alongside new_quantity', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [movementRow({ id: 'm-pq', previous_quantity: 250, new_quantity: 235 })],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.previousQuantity).toBe(250);
    expect(events[0]!.quantityAfter).toBe(235);
  });

  // ── Issue 3: reason AND notes both survive when BOTH are set ─────────────

  it('carries BOTH reason and notes through when the row has both (previously notes was dropped)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-both',
            reason: 'Damaged in transit',
            notes: 'Box was crushed, 3 units unsellable',
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.reason).toBe('Damaged in transit');
    expect(events[0]!.notes).toBe('Box was crushed, 3 units unsellable');
  });

  // ── Issue 4: reference_type/reference_id + resolved display label ───────

  it('threads reference_type/reference_id onto the event and resolves a display label (order_request)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-ref',
            movement_type: 'remove',
            reference_type: 'order_request',
            reference_id: 'req-1',
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
      'order_requests.select': {
        data: [{ id: 'req-1', order_number: 49 }],
        error: null,
      },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.referenceType).toBe('order_request');
    expect(events[0]!.referenceId).toBe('req-1');
    expect(events[0]!.referenceLabel).toBe('SO-000049');
  });

  it('leaves referenceLabel null for a known type with no cheap number (cycle_count) — still routable', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          movementRow({
            id: 'm-cc',
            movement_type: 'adjust',
            reference_type: 'cycle_count',
            reference_id: 'cc-1',
          }),
        ],
        error: null,
      },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.referenceType).toBe('cycle_count');
    expect(events[0]!.referenceId).toBe('cc-1');
    expect(events[0]!.referenceLabel).toBeNull();
    // No display number for cycle counts → no extra lookup query fires.
    expect(stub.fromCalls).not.toContain('order_requests');
    expect(stub.fromCalls).not.toContain('returns');
    expect(stub.fromCalls).not.toContain('bundles');
  });

  it('skips every reference-label query when no movement row has a reference', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [movementRow({ id: 'm-none' })], error: null },
      'audit_logs.select': { data: [], error: null },
    });
    const svc = makeService(stub.client);

    const events = await svc.forItem('item-1');
    expect(events[0]!.referenceType).toBeNull();
    expect(events[0]!.referenceLabel).toBeNull();
    expect(stub.fromCalls).not.toContain('order_requests');
    expect(stub.fromCalls).not.toContain('returns');
    expect(stub.fromCalls).not.toContain('bundles');
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
