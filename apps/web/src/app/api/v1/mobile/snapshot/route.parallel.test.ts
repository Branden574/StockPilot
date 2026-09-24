import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';

import { GET } from './route';

/**
 * The mobile snapshot's reads run TOGETHER, and nothing else about the route
 * moves.
 *
 * Measured 2026-09-22: the snapshot made ~11 Supabase calls one after another,
 * and a call that goes through our Vercel servers can stall 1-8 s at
 * Supabase's entry point (bundles alone took 3779 ms inside one user's
 * snapshot at 18:45:23Z). In series every stall adds up; in parallel the
 * snapshot costs its slowest read. These tests pin the four things that
 * change must not break:
 *
 *   1. the reads start together (the point of the change),
 *   2. a rate-limited or unauthenticated caller still gets NO data, and no
 *      data read starts before the rate-limit verdict,
 *   3. the response is byte-for-byte the one the serial route produced,
 *   4. a failing read produces exactly the response and the report it did.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));

// ── Recording PostgREST stub ─────────────────────────────────────────────

/** One recorded query: the table, the select string, and every builder call. */
interface Query {
  table: string;
  select: string;
  calls: Array<{ method: string; args: unknown[] }>;
  /** Set when the query is awaited — i.e. when the request is sent. */
  started: boolean;
  /** Set when the query's answer has been handed back. */
  settled: boolean;
}

/** What one query answers: a PostgREST result, or `reject` to make it throw. */
type Answer = { data: unknown; error: unknown } | { reject: Error };
type Responder = (q: Query) => Answer;

const queries: Query[] = [];

/** While set, every awaited query parks here until the test releases it. */
let gate: Promise<void> | null = null;

/**
 * Chainable PostgREST-shaped stub. Every builder method returns the same
 * proxy; the chain resolves through `then`, which is the moment a real
 * builder sends its request. That is what "started" means below.
 */
function makeClient(respond: Responder) {
  return {
    from(table: string) {
      const q: Query = { table, select: '', calls: [], started: false, settled: false };
      queries.push(q);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                q.started = true;
                return Promise.resolve(gate)
                  .then(() => respond(q))
                  .then((answer) => {
                    q.settled = true;
                    return 'reject' in answer ? reject(answer.reject) : resolve(answer);
                  });
              };
            }
            return (...args: unknown[]) => {
              if (prop === 'select') q.select = String(args[0] ?? '');
              q.calls.push({ method: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy as never;
    },
  };
}

/** Collapse the multi-line select strings so a query reads on one line. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Which of the route's reads a recorded query is. */
function kindOf(q: Query): string {
  const sel = norm(q.select);
  if (q.table === 'inventory_items') {
    if (sel === 'id') return 'removed_items';
    if (sel.includes('sku')) return 'items';
    return 'bundle_phantoms';
  }
  if (q.table === 'bundles') return sel === 'id' ? 'active_bundle_ids' : 'bundles';
  if (q.table === 'purchase_orders') return 'pos';
  if (q.table === 'cycle_counts') return 'cycle_counts';
  return q.table;
}

const rangeOf = (q: Query) =>
  (q.calls.find((c) => c.method === 'range')?.args as [number, number] | undefined) ?? [0, 999];

// ── A world rich enough to exercise every mapping in the response ───────

const ROWS = {
  warehouses: [
    { id: 'wh1', name: 'Main', updated_at: '2026-09-01T00:00:00.000Z' },
    { id: 'wh2', name: 'Overflow', updated_at: '2026-09-01T00:00:00.000Z' },
  ],
  items: [
    {
      id: 'i-1',
      sku: 'SKU-1',
      name: 'Widget',
      barcode: '0123',
      quantity_on_hand: '7',
      unit_cost: '2.5',
      warehouse_id: 'wh1',
      item_type: 'standard',
      is_bundle: false,
      updated_at: '2026-09-22T12:00:00.000Z',
    },
    {
      id: 'i-2',
      sku: null,
      name: 'Loose part',
      barcode: null,
      quantity_on_hand: null,
      unit_cost: null,
      warehouse_id: null,
      item_type: 'consumable',
      is_bundle: false,
      updated_at: '2026-09-22T12:00:00.000Z',
    },
  ],
  pos: [
    {
      id: 'po-1',
      po_number: 'PO-0001',
      status: 'ordered',
      expected_at: '2026-10-01',
      destination_location_id: 'loc-1',
      updated_at: '2026-09-22T12:00:00.000Z',
      destination: { warehouse_id: 'wh1' },
      items: [
        {
          id: 'pol-1',
          item_id: 'i-1',
          quantity_ordered: '10',
          quantity_received: 3,
          unit_cost: '2.5',
        },
      ],
    },
    {
      id: 'po-2',
      po_number: 'PO-0002',
      status: 'draft',
      expected_at: null,
      destination_location_id: null,
      updated_at: '2026-09-22T11:00:00.000Z',
      destination: [{ warehouse_id: 'wh2' }],
      items: null,
    },
  ],
  counts: [
    {
      id: 'cc-1',
      count_number: 7,
      status: 'in_progress',
      warehouse_id: 'wh1',
      started_at: '2026-09-22T09:00:00.000Z',
      assigned_to: 'u-1',
      notes: 'aisle 3',
      lines: [
        { id: 'ccl-1', item_id: 'i-1', expected_quantity: '7', counted_quantity: null },
        { id: 'ccl-2', item_id: 'i-2', expected_quantity: 0, counted_quantity: '4' },
      ],
    },
  ],
  bundles: [
    {
      id: 'b-1',
      name: 'Starter kit',
      sku: 'KIT-1',
      preassembly_enabled: true,
      phantom_item_id: 'ph-1',
      updated_at: '2026-09-22T12:00:00.000Z',
    },
    {
      id: 'b-2',
      name: 'Travel kit',
      sku: null,
      preassembly_enabled: null,
      phantom_item_id: null,
      updated_at: '2026-09-22T12:00:00.000Z',
    },
  ],
  components: [
    { bundle_id: 'b-1', item_id: 'i-1', quantity: '2', is_optional: false },
    { bundle_id: 'b-1', item_id: 'i-2', quantity: 1, is_optional: true },
  ],
  phantoms: [{ id: 'ph-1', quantity_on_hand: '3', warehouse_id: 'wh1' }],
  /** Every non-bundle item that changed since the cursor, in scope or not. */
  changedItemIds: ['i-1', 'i-2', 'i-gone'],
  activeBundleIds: ['b-1', 'b-2', 'b-3'],
};

/** Per-read overrides: an error result, or a thrown rejection. */
type Faults = Partial<Record<string, Answer>>;

function respondFor(faults: Faults = {}): Responder {
  return (q) => {
    const kind = kindOf(q);
    const fault = faults[kind];
    if (fault) return fault;
    const [from, to] = rangeOf(q);
    switch (kind) {
      case 'warehouses':
        return { data: ROWS.warehouses, error: null };
      case 'items':
        return { data: ROWS.items.slice(from, to + 1), error: null };
      case 'pos':
        return { data: ROWS.pos, error: null };
      case 'cycle_counts':
        return { data: ROWS.counts, error: null };
      case 'bundles':
        return { data: ROWS.bundles, error: null };
      case 'bundle_components':
        return { data: ROWS.components, error: null };
      case 'bundle_phantoms':
        return { data: ROWS.phantoms, error: null };
      case 'removed_items':
        return {
          data: ROWS.changedItemIds.slice(from, to + 1).map((id) => ({ id })),
          error: null,
        };
      case 'active_bundle_ids':
        return {
          data: ROWS.activeBundleIds.slice(from, to + 1).map((id) => ({ id })),
          error: null,
        };
      default:
        return { data: [], error: null };
    }
  };
}

const SCOPED_ACCESS = {
  readableIds: ['wh1', 'wh2'],
  writableIds: ['wh1', 'wh2'],
  hasAllAccess: false,
  primaryWarehouseId: 'wh1',
};

function mockContext(respond: Responder, role = 'staff') {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    permissions: new Set(['inventory.read', 'purchasing.read']),
    enabledModules: new Set(['inventory', 'purchasing', 'bundles']),
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
    supabase: makeClient(respond),
  } as never);
}

const SINCE = '2026-09-22T11:00:00.000Z';
const NOW = '2026-09-22T18:45:23.000Z';

function request(qs = '') {
  return new NextRequest(`http://localhost/api/v1/mobile/snapshot${qs}`);
}

/** Let every queued microtask and one macrotask turn run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  queries.length = 0;
  gate = null;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(getWarehouseAccess).mockResolvedValue(SCOPED_ACCESS as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 1. The reads start together ─────────────────────────────────────────

describe('the reads start together', () => {
  it('sends every independent read before any of them has answered', async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    mockContext(respondFor());

    const pending = GET(request(`?since=${SINCE}`));
    await flush();
    await flush();

    // Nothing has answered yet: every query is still parked at the gate.
    expect(queries.every((q) => !q.settled)).toBe(true);
    const inFlight = new Set(queries.filter((q) => q.started).map(kindOf));
    // The serial route had sent ONE read at this point (warehouses) and was
    // waiting on it before it would even build the next.
    expect([...inFlight].sort()).toEqual(
      [
        'active_bundle_ids',
        'bundles',
        'cycle_counts',
        'items',
        'pos',
        'removed_items',
        'warehouses',
      ].sort(),
    );
    // Components and phantoms need the bundle ids, so they wait for bundles.
    expect(inFlight.has('bundle_components')).toBe(false);
    expect(inFlight.has('bundle_phantoms')).toBe(false);

    release();
    const res = await pending;
    expect(res.status).toBe(200);
    // ...and once bundles answered, both dependent reads went out.
    expect(queries.some((q) => kindOf(q) === 'bundle_components' && q.started)).toBe(true);
    expect(queries.some((q) => kindOf(q) === 'bundle_phantoms' && q.started)).toBe(true);
  });

  it('checks the rate limit while warehouse access resolves, and reads nothing before the verdict', async () => {
    let verdict!: (v: { allowed: boolean; count: number; resetAt: number }) => void;
    vi.mocked(checkRateLimit).mockReturnValue(
      new Promise((r) => {
        verdict = r;
      }),
    );
    mockContext(respondFor());

    const pending = GET(request());
    await flush();
    await flush();

    // Both calls are out at once: the rate-limit round trip no longer sits
    // in front of the access lookup.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(getWarehouseAccess).toHaveBeenCalledTimes(1);
    // But not ONE data read has been built, let alone sent: the heavy reads
    // are exactly what the limit exists to cap.
    expect(queries).toHaveLength(0);

    verdict({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(queries.length).toBeGreaterThan(0);
  });
});

// ── 2. A denied or unauthenticated caller gets nothing ──────────────────

describe('rate limit and authentication still deny', () => {
  it('keeps the same key, limit, window and (fail-open) mode', async () => {
    mockContext(respondFor());
    await GET(request());
    expect(checkRateLimit).toHaveBeenCalledWith('mobile-snapshot:user:u-1', 30, 60_000);
    // No fourth argument: the route's mode stays the default, 'open'.
    expect(vi.mocked(checkRateLimit).mock.calls[0]).toHaveLength(3);
  });

  it('answers 429 with Retry-After and reads no data when the limit is exceeded', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 42_000,
    });
    mockContext(respondFor());

    const res = await GET(request(`?since=${SINCE}`));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.text()).toBe(
      JSON.stringify({
        error: 'rate_limited',
        message: 'Syncing too often — try again shortly.',
      }),
    );
    expect(queries).toHaveLength(0);
  });

  it('denies a check that failed in closed mode the same way — any allowed:false is a 429', async () => {
    // What checkRateLimit returns for a failed RPC when mode === 'closed'.
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 30,
      resetAt: Date.now() + 60_000,
    });
    mockContext(respondFor());
    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(queries).toHaveLength(0);
  });

  it('does not report a warehouse-access failure for a request it is refusing anyway', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 1_000,
    });
    vi.mocked(getWarehouseAccess).mockRejectedValue(new Error('assignments unreadable'));
    mockContext(respondFor());

    const res = await GET(request());

    expect(res.status).toBe(429);
    expect(reportError).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it('answers 500 with no data when the rate-limit check itself throws', async () => {
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('rate limiter exploded'));
    vi.mocked(getWarehouseAccess).mockRejectedValue(new Error('and so did access'));
    mockContext(respondFor());

    const res = await GET(request());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', code: 'snapshot_uncaught' });
    expect(queries).toHaveLength(0);
  });

  it('answers 401 without touching the rate limiter, access or any table when unauthenticated', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(getWarehouseAccess).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });
});

// ── 2b. An access lookup that failed is a refusal ───────────────────────

/**
 * This route used to catch a thrown access lookup as hasAllAccess: true,
 * which dropped every warehouse filter for a staff or viewer caller and told
 * the phone it could see every warehouse. For staff and viewer, a lookup that
 * threw, or that answered from a read that failed (getWarehouseAccess marks
 * that answer `unreadable`), now gets the route's failed-read answer instead:
 * a 500 with a `query` tag and NO data read built. A 500 rather than an empty
 * 200 because the phone acts on a 200 (a full pull deletes every cached item
 * it was not sent), and keeps its cache on any non-2xx. Manager-and-above are
 * decided by role and never make the lookup (next describe).
 */
describe('a staff or viewer access lookup that failed is refused, never widened', () => {
  const REFUSAL = { error: 'internal_error', query: 'warehouse_access' };

  async function expectRefused(qs: string) {
    const res = await GET(request(qs));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(REFUSAL);
    // Not one data read was built, let alone sent.
    expect(queries).toHaveLength(0);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toEqual({
      tag: 'mobile.snapshot.warehouse_access',
      organizationId: 'org-1',
    });
  }

  it.each([
    ['staff', 'a full pull', ''],
    ['staff', 'a delta pull', `?since=${SINCE}`],
    ['viewer', 'a full pull', ''],
    ['viewer', 'a delta pull', `?since=${SINCE}`],
  ])('a THROWN lookup refuses %s: %s', async (role, _label, qs) => {
    vi.mocked(getWarehouseAccess).mockRejectedValue(new Error('assignments unreadable'));
    mockContext(respondFor(), role);
    await expectRefused(qs);
    const reported = vi.mocked(reportError).mock.calls[0]?.[0] as Error;
    expect(reported.message).toBe('assignments unreadable');
  });

  it.each([
    ['staff', false],
    ['viewer', false],
    // The 0280 all-warehouses flag reaches hasAllAccess only through a
    // readable membership row; an unreadable answer is refused whatever it
    // carries, so a failed read can never be served as "every warehouse".
    ['staff', true],
  ])(
    'an answer built from a failed read refuses %s (hasAllAccess: %s)',
    async (role, hasAllAccess) => {
      vi.mocked(getWarehouseAccess).mockResolvedValue({
        readableIds: [],
        writableIds: [],
        hasAllAccess,
        primaryWarehouseId: null,
        unreadable: true,
      } as never);
      mockContext(respondFor(), role);
      await expectRefused('');
    },
  );

  it('the refusal still waits for the rate-limit verdict: a limited caller gets its 429, unreported', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 5_000,
    });
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
      unreadable: true,
    } as never);
    mockContext(respondFor());

    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(reportError).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it('a readable answer is served exactly as before (scoped caller, filters applied)', async () => {
    mockContext(respondFor());
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(reportError).not.toHaveBeenCalled();
    const wh = queries.find((q) => kindOf(q) === 'warehouses');
    expect(wh?.calls.find((c) => c.method === 'in')?.args).toEqual(['id', ['wh1', 'wh2']]);
    const items = queries.find((q) => kindOf(q) === 'items');
    expect(items?.calls.find((c) => c.method === 'in')?.args).toEqual([
      'warehouse_id',
      ['wh1', 'wh2'],
    ]);
  });
});

// ── 2c. Manager-and-above: the role decides ─────────────────────────────

/**
 * getWarehouseAccess answers hasAllAccess = true for owner, admin and manager
 * on their role alone, and this route never reads their id list. It used to
 * ask anyway, so a failed `warehouses` list read answered a manager 500 (after
 * the lookup started failing closed). The route no longer makes the lookup
 * for them: their sync cannot fail on it, and costs one read less.
 */
describe('manager-and-above are served by role, whatever the lookup would do', () => {
  const MANAGERS = ['owner', 'admin', 'manager'];
  const LOOKUP_FAILURES: Array<[string, () => void]> = [
    [
      'throws',
      () => vi.mocked(getWarehouseAccess).mockRejectedValue(new Error('warehouses unreadable')),
    ],
    [
      'answers unreadable',
      () =>
        vi.mocked(getWarehouseAccess).mockResolvedValue({
          readableIds: [],
          writableIds: [],
          hasAllAccess: true,
          primaryWarehouseId: null,
          unreadable: true,
        } as never),
    ],
  ];

  for (const role of MANAGERS) {
    for (const [label, arrange] of LOOKUP_FAILURES) {
      it(`${role}: a lookup that ${label} does not stop the sync`, async () => {
        arrange();
        mockContext(respondFor(), role);

        const res = await GET(request(`?since=${SINCE}`));

        expect(res.status).toBe(200);
        expect(getWarehouseAccess).not.toHaveBeenCalled();
        expect(reportError).not.toHaveBeenCalled();
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.warehouseScope).toEqual({
          hasAllAccess: true,
          warehouseNames: ['Main', 'Overflow'],
        });
        expect((body.items as unknown[]).length).toBe(2);
        // Every warehouse, unfiltered: no warehouse filter on any read.
        const byKind = (k: string) => queries.find((q) => kindOf(q) === k)!;
        expect(byKind('warehouses').calls.some((c) => c.method === 'in')).toBe(false);
        expect(byKind('items').calls.some((c) => c.method === 'in')).toBe(false);
        expect(byKind('pos').calls.some((c) => c.args[0] === 'destination.warehouse_id')).toBe(
          false,
        );
        expect(norm(byKind('pos').select)).not.toContain('!inner');
        expect(byKind('cycle_counts').calls.some((c) => c.method === 'or')).toBe(false);
      });
    }
  }

  it('staff still make the lookup (the rows decide for them)', async () => {
    mockContext(respondFor(), 'staff');
    await GET(request());
    expect(getWarehouseAccess).toHaveBeenCalledTimes(1);
  });
});

// ── 2d. A scoped member with no readable warehouse gets none ────────────

/**
 * The filters used to be guarded by `!hasAllAccess && readableIds.length`, so
 * a staff or viewer whose lookup SUCCEEDED but found no assignment got no
 * warehouse filter at all: every warehouse, item, PO and count row level
 * security let through, cached on the phone. Narrowing is now decided by
 * hasAllAccess alone; narrowed to nothing, the four warehouse-scoped reads
 * answer empty and are never sent.
 */
describe('a scoped member with no readable warehouse gets no warehouse-scoped data', () => {
  const NONE = {
    readableIds: [],
    writableIds: [],
    hasAllAccess: false,
    primaryWarehouseId: null,
  };
  const SCOPED_READS = ['warehouses', 'items', 'pos', 'cycle_counts'];

  it.each(['staff', 'viewer'])(
    '%s: empty lists, and not one of those reads is sent',
    async (role) => {
      vi.mocked(getWarehouseAccess).mockResolvedValue(NONE as never);
      mockContext(respondFor(), role);

      const res = await GET(request(`?since=${SINCE}`));

      expect(res.status).toBe(200);
      expect(reportError).not.toHaveBeenCalled();
      expect(queries.filter((q) => SCOPED_READS.includes(kindOf(q)) && q.started)).toEqual([]);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.warehouses).toEqual([]);
      expect(body.items).toEqual([]);
      expect(body.openPOs).toEqual([]);
      expect(body.openCycleCounts).toEqual([]);
      expect(body.warehouseScope).toEqual({ hasAllAccess: false, warehouseNames: [] });
      // The org-wide reads still run: bundles as always, and every item that
      // changed since the cursor is reported as removed (none was delivered).
      expect((body.bundles as unknown[]).length).toBe(2);
      expect(body.removedItemIds).toEqual(['i-1', 'i-2', 'i-gone']);
      expect(body.activeBundleIds).toEqual(['b-1', 'b-2', 'b-3']);
    },
  );

  it('a full pull is empty too (the phone sweeps what it held)', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue(NONE as never);
    mockContext(respondFor());
    const res = await GET(request());
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.warehouses).toEqual([]);
    expect(queries.filter((q) => SCOPED_READS.includes(kindOf(q)) && q.started)).toEqual([]);
  });

  it('an all-warehouses member (0280) with no assignment row is NOT narrowed: hasAllAccess decides, not the list', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({ ...NONE, hasAllAccess: true } as never);
    mockContext(respondFor());
    const res = await GET(request());
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.items as unknown[]).length).toBe(2);
    expect(
      queries.find((q) => kindOf(q) === 'warehouses')!.calls.some((c) => c.method === 'in'),
    ).toBe(false);
  });
});

// ── 3. Byte-for-byte the same response, from the same queries ───────────

/**
 * Captured from the SERIAL route (origin/main a57e77e4) with the world above.
 * JSON.stringify keeps insertion order, so comparing text pins key order too.
 */
const GOLDEN_DELTA_BODY = JSON.stringify({
  serverTime: NOW,
  since: SINCE,
  enabledModules: ['inventory', 'purchasing', 'bundles'],
  permissions: ['inventory.read', 'purchasing.read'],
  warehouseScope: { hasAllAccess: false, warehouseNames: ['Main', 'Overflow'] },
  warehouses: [
    { id: 'wh1', name: 'Main' },
    { id: 'wh2', name: 'Overflow' },
  ],
  items: [
    {
      id: 'i-1',
      sku: 'SKU-1',
      name: 'Widget',
      barcode: '0123',
      quantityOnHand: 7,
      unitCost: 2.5,
      warehouseId: 'wh1',
      itemType: 'standard',
    },
    {
      id: 'i-2',
      sku: null,
      name: 'Loose part',
      barcode: null,
      quantityOnHand: 0,
      unitCost: 0,
      warehouseId: null,
      itemType: 'consumable',
    },
  ],
  openPOs: [
    {
      id: 'po-1',
      poNumber: 'PO-0001',
      status: 'ordered',
      expectedAt: '2026-10-01',
      warehouseId: 'wh1',
      lines: [{ id: 'pol-1', itemId: 'i-1', qtyOrdered: 10, qtyReceived: 3, unitCost: 2.5 }],
    },
    {
      id: 'po-2',
      poNumber: 'PO-0002',
      status: 'draft',
      expectedAt: null,
      warehouseId: 'wh2',
      lines: [],
    },
  ],
  openCycleCounts: [
    {
      id: 'cc-1',
      countNumber: 7,
      status: 'in_progress',
      warehouseId: 'wh1',
      startedAt: '2026-09-22T09:00:00.000Z',
      assignedTo: 'u-1',
      notes: 'aisle 3',
      lines: [
        { id: 'ccl-1', itemId: 'i-1', expected: 7, counted: null },
        { id: 'ccl-2', itemId: 'i-2', expected: 0, counted: 4 },
      ],
    },
  ],
  bundles: [
    {
      id: 'b-1',
      name: 'Starter kit',
      sku: 'KIT-1',
      preassemblyEnabled: true,
      phantomItemId: 'ph-1',
      phantomQty: 3,
      phantomWarehouseId: 'wh1',
      components: [
        { itemId: 'i-1', quantity: 2, isOptional: false },
        { itemId: 'i-2', quantity: 1, isOptional: true },
      ],
    },
    {
      id: 'b-2',
      name: 'Travel kit',
      sku: null,
      preassemblyEnabled: false,
      phantomItemId: null,
      phantomQty: 0,
      phantomWarehouseId: null,
      components: [],
    },
  ],
  removedItemIds: ['i-gone'],
  activeBundleIds: ['b-1', 'b-2', 'b-3'],
});

/**
 * Every query the serial route built for the same scoped delta pull: table,
 * select, and each filter in the order it was applied. Sorted, because the
 * point is WHICH queries run with WHICH filters, not the order they are sent.
 *
 * The two bundle follow-ups (components by bundle id, phantoms by id) now go
 * through fetchAllRowsByIds, 100 ids per request and paged, so each gains a
 * stable order and a range; the filters are unchanged.
 */
const GOLDEN_DELTA_QUERIES = [
  'bundle_components | bundle_id, item_id, quantity, is_optional | select("bundle_id, item_id, quantity, is_optional") in("bundle_id",["b-1","b-2"]) order("bundle_id",{"ascending":true}) order("item_id",{"ascending":true}) range(0,999)',
  'bundles | id | select("id") eq("organization_id","org-1") eq("is_active",true) is("archived_at",null) order("id",{"ascending":true}) range(0,999)',
  'bundles | id, name, sku, preassembly_enabled, phantom_item_id, updated_at | select("id, name, sku, preassembly_enabled, phantom_item_id, updated_at") eq("organization_id","org-1") eq("is_active",true) is("archived_at",null) order("name",{"ascending":true}) gte("updated_at","2026-09-22T11:00:00.000Z")',
  'cycle_counts | id, count_number, status, warehouse_id, started_at, assigned_to, notes, lines:cycle_count_lines ( id, item_id, expected_quantity, counted_quantity ) | select("id, count_number, status, warehouse_id, started_at, assigned_to, notes, lines:cycle_count_lines ( id, item_id, expected_quantity, counted_quantity )") eq("organization_id","org-1") eq("status","in_progress") order("started_at",{"ascending":false}) limit(50) or("warehouse_id.is.null,warehouse_id.in.(wh1,wh2)")',
  'inventory_items | id | select("id") eq("organization_id","org-1") eq("is_bundle",false) gte("updated_at","2026-09-22T11:00:00.000Z") order("id",{"ascending":true}) range(0,999)',
  'inventory_items | id, quantity_on_hand, warehouse_id | select("id, quantity_on_hand, warehouse_id") in("id",["ph-1"]) order("id",{"ascending":true}) range(0,999)',
  'inventory_items | id, sku, name, barcode, quantity_on_hand, unit_cost, warehouse_id, item_type, is_bundle, updated_at | select("id, sku, name, barcode, quantity_on_hand, unit_cost, warehouse_id, item_type, is_bundle, updated_at") eq("organization_id","org-1") is("deleted_at",null) eq("status","active") eq("is_bundle",false) order("id",{"ascending":true}) range(0,999) in("warehouse_id",["wh1","wh2"]) gte("updated_at","2026-09-22T11:00:00.000Z")',
  'purchase_orders | id, po_number, status, expected_at, destination_location_id, updated_at, destination:locations!destination_location_id!inner (warehouse_id), items:purchase_order_items ( id, item_id, quantity_ordered, quantity_received, unit_cost ) | select("id, po_number, status, expected_at, destination_location_id, updated_at, destination:locations!destination_location_id!inner (warehouse_id), items:purchase_order_items ( id, item_id, quantity_ordered, quantity_received, unit_cost )") eq("organization_id","org-1") in("status",["ordered","partially_received","draft"]) order("updated_at",{"ascending":false}) limit(200) in("destination.warehouse_id",["wh1","wh2"]) gte("updated_at","2026-09-22T11:00:00.000Z")',
  'warehouses | id, name, updated_at | select("id, name, updated_at") eq("organization_id","org-1") order("name",{"ascending":true}) in("id",["wh1","wh2"])',
];

const describeQuery = (q: Query) =>
  `${q.table} | ${norm(q.select)} | ${q.calls
    .map(
      (c) =>
        `${c.method}(${c.args.map((a) => JSON.stringify(typeof a === 'string' ? norm(a) : a)).join(',')})`,
    )
    .join(' ')}`;

describe('the response is the one the serial route sent', () => {
  it('is byte-for-byte identical for a scoped delta pull', async () => {
    mockContext(respondFor());
    const res = await GET(request(`?since=${SINCE}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(GOLDEN_DELTA_BODY);
  });

  it('builds the same queries, with the same filters, on the caller’s own client', async () => {
    mockContext(respondFor());
    await GET(request(`?since=${SINCE}`));
    expect(queries.map(describeQuery).sort()).toEqual(GOLDEN_DELTA_QUERIES);
  });

  it('omits removedItemIds on a full pull, exactly as before', async () => {
    mockContext(respondFor());
    const res = await GET(request());
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('removedItemIds');
    expect(body.since).toBeNull();
    expect(Object.keys(body)).toEqual([
      'serverTime',
      'since',
      'enabledModules',
      'permissions',
      'warehouseScope',
      'warehouses',
      'items',
      'openPOs',
      'openCycleCounts',
      'bundles',
      'activeBundleIds',
    ]);
    expect(queries.some((q) => kindOf(q) === 'removed_items')).toBe(false);
  });
});

// ── 4. A failing read fails exactly as it did ───────────────────────────

const boom = (tag: string) => ({ data: null, error: { message: `boom-${tag}`, code: 'PGRST999' } });

describe('an error in one read behaves as before', () => {
  for (const tag of [
    'warehouses',
    'items',
    'pos',
    'cycle_counts',
    'bundles',
    'bundle_components',
    'bundle_phantoms',
  ]) {
    it(`a failed ${tag} read answers the same 500 and reports once`, async () => {
      mockContext(respondFor({ [tag]: boom(tag) }));

      const res = await GET(request(`?since=${SINCE}`));

      expect(res.status).toBe(500);
      // fetchAllRows turns the items error into a thrown ServiceError, whose
      // message is the generic one; the route has always sent that one.
      const detail =
        tag === 'items' ? 'An internal error occurred. Please try again.' : `boom-${tag}`;
      expect(await res.text()).toBe(
        JSON.stringify({ error: 'internal_error', query: tag, detail }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reportError).mock.calls[0]?.[1]).toMatchObject({
        tag: `mobile.snapshot.${tag}`,
        organizationId: 'org-1',
      });
    });
  }

  it('reports the read the serial route would have hit FIRST when several fail', async () => {
    mockContext(
      respondFor({
        bundles: boom('bundles'),
        pos: boom('pos'),
        warehouses: boom('warehouses'),
      }),
    );
    const res = await GET(request(`?since=${SINCE}`));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { query: string }).query).toBe('warehouses');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('does not report a failed removal read when the snapshot itself failed', async () => {
    mockContext(
      respondFor({
        pos: boom('pos'),
        removed_items: boom('removed_items'),
        active_bundle_ids: boom('active_bundle_ids'),
      }),
    );
    const res = await GET(request(`?since=${SINCE}`));
    expect(((await res.json()) as { query: string }).query).toBe('pos');
    // The serial route never reached the removal reads; neither report fires.
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a read that THROWS is still the uncaught 500, and an earlier error still wins', async () => {
    mockContext(respondFor({ pos: { reject: new Error('socket hang up') } }));
    const res = await GET(request(`?since=${SINCE}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', code: 'snapshot_uncaught' });

    queries.length = 0;
    vi.mocked(reportError).mockClear();
    mockContext(
      respondFor({
        warehouses: boom('warehouses'),
        pos: { reject: new Error('socket hang up') },
      }),
    );
    const res2 = await GET(request(`?since=${SINCE}`));
    expect(((await res2.json()) as { query: string }).query).toBe('warehouses');
  });

  it('an items page that throws is reported as the items read, as before', async () => {
    mockContext(respondFor({ items: { reject: new Error('page 1 threw') } }));
    const res = await GET(request(`?since=${SINCE}`));
    expect(await res.text()).toBe(
      JSON.stringify({ error: 'internal_error', query: 'items', detail: 'page 1 threw' }),
    );
  });

  it('a failed removal read still OMITS its field on an otherwise good pull', async () => {
    mockContext(
      respondFor({
        removed_items: boom('removed_items'),
        active_bundle_ids: boom('active_bundle_ids'),
      }),
    );
    const res = await GET(request(`?since=${SINCE}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('removedItemIds');
    expect(body).not.toHaveProperty('activeBundleIds');
    expect(vi.mocked(reportError).mock.calls.map((c) => (c[1] as { tag: string }).tag)).toEqual([
      'mobile.snapshot.removed_items',
      'mobile.snapshot.active_bundle_ids',
    ]);
  });
});

describe('open cycle counts before migration 0358', () => {
  beforeEach(() => {
    queries.length = 0;
    vi.mocked(getWarehouseAccess).mockResolvedValue(SCOPED_ACCESS as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    } as never);
  });

  it('a missing count_number column reads the counts again without it, instead of failing every phone sync', async () => {
    const base = respondFor();
    mockContext((q) => {
      if (kindOf(q) !== 'cycle_counts') return base(q);
      if (q.select.includes('count_number')) {
        return { data: null, error: { message: 'column cycle_counts.count_number does not exist', code: '42703' } };
      }
      // A database without the column cannot return it.
      const rows = (ROWS.counts as Array<Record<string, unknown>>).map(({ count_number: _n, ...r }) => r);
      return { data: rows, error: null };
    });
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openCycleCounts).toHaveLength(1);
    expect(body.openCycleCounts[0]).toMatchObject({ id: 'cc-1', countNumber: null, notes: 'aisle 3' });
    const countReads = queries.filter((q) => kindOf(q) === 'cycle_counts');
    expect(countReads).toHaveLength(2);
    expect(countReads[1]!.select).not.toContain('count_number');
  });

  it('any other failure still fails the snapshot loudly', async () => {
    mockContext(respondFor({ cycle_counts: boom('cc') }));
    const res = await GET(request());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(queries.filter((q) => kindOf(q) === 'cycle_counts')).toHaveLength(1);
  });
});
