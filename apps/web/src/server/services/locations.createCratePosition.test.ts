/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CRATE CANNOT BE CREATED HAVING ALREADY LOST ITS POSITION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The invariant is the one `locations.renameCratePosition.test.ts` pins from
 * the other side: a crate's rack travels in its NAME ("Gray #BIN on rack
 * 43-B"), because migration 0270's `lower(name)` index is what keeps five
 * physically distinct "gray BIN" bins as five rows, and because nothing that
 * renders a placement reads `rack_number`/`rack_row` — a holding reaches every
 * formatter as `{ name, quantity, kind }`.
 *
 * It was enforced on RENAME only. `create()` inserted `input.name` verbatim
 * beside whatever rack columns arrived with it, so `createLocationAction` — a
 * live authenticated server action taking the whole `createLocationSchema` —
 * could mint `{ name: 'Gray BIN', kind: 'crate', rackNumber: '43', rackRow:
 * 'B' }`: a row whose columns say 43-B while its name says nothing, mis-rendered
 * everywhere at once AND permanently unrenameable, because the rename guard
 * reads those same columns and refuses every future name.
 *
 * Nothing in production carries that shape (no shipped UI sends it — the
 * Locations manager form posts name/type/notes only, and every put-away path
 * composes through `planNewLocation`), so this is a hole closed before it was
 * ever fallen into. "No caller does this today" is a coincidence, not an
 * invariant; the gate now sits at the single insert every caller shares.
 *
 * TWO HALVES, and the second is the one that could break something:
 *   1. `create()` itself normalises (or refuses) the bad shape.
 *   2. Every shipped caller comes out BYTE-IDENTICAL — they already compose,
 *      and a second composition would name a crate "…on rack 43-B on rack 43-B"
 *      and mint a duplicate `locations` row for a crate that already exists.
 */
import {
  locationNameSitsOnRack,
  planNewLocation,
  type NewLocationFields,
} from '@stockpilot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});

import { ServiceError } from './context';
import { createLocationSchema, LocationsService, type CreateLocationInput } from './locations';

const WAREHOUSE = '00000000-0000-0000-0000-000000000001';

type Insert = {
  name: string;
  kind: string | null;
  rack_number: string | null;
  rack_row: string | null;
  crate_color: string | null;
  crate_number: string | null;
};

/** Run the REAL `create` against a stub and hand back what it tried to insert. */
async function create(input: CreateLocationInput) {
  const stub = makeSupabaseStub({
    'locations.insert': { data: { id: 'loc-new' }, error: null },
  });
  const svc = new LocationsService(makeServiceContext(stub.client));
  const result = await svc
    .create(input)
    .then((data) => ({ ok: true as const, data }))
    .catch((error: unknown) => ({ ok: false as const, error }));
  return {
    result,
    inserted: stub.chainArgs.get('locations.insert')?.[0]?.[0] as Insert | undefined,
  };
}

/**
 * The bad shape, exactly as `createLocationAction` would forward it: a crate
 * carrying a rack in its COLUMNS and nothing in its NAME.
 */
const STRIPPED: CreateLocationInput = {
  name: 'Gray BIN',
  type: 'bin',
  kind: 'crate',
  warehouseId: WAREHOUSE,
  rackNumber: '43',
  rackRow: 'B',
  crateColor: 'gray',
  crateNumber: 'BIN',
};

beforeEach(() => vi.clearAllMocks());

describe('create() is the gate — the schema never was', () => {
  it('createLocationSchema still ACCEPTS the stripped shape (so the service must not)', () => {
    // Pinning this on purpose: the hole was reachable precisely because the
    // schema takes `name` and the rack columns as unrelated optional fields.
    // If someone later tightens the schema this stays green; if they rely on
    // the schema INSTEAD of the service guard, the tests below fail.
    expect(createLocationSchema.safeParse(STRIPPED).success).toBe(true);
  });

  it('NORMALISES the stripped crate — the position goes back into the name', async () => {
    const { result, inserted } = await create(STRIPPED);
    expect(result.ok).toBe(true);
    expect(inserted?.name).toBe('Gray #BIN on rack 43-B');
    // The columns are untouched — they were never the broken half.
    expect(inserted?.rack_number).toBe('43');
    expect(inserted?.rack_row).toBe('B');
    expect(inserted?.crate_number).toBe('BIN');
  });

  it('the row it writes is one every reader resolves onto rack 43-B', async () => {
    const { inserted } = await create(STRIPPED);
    // `locationNameSitsOnRack` is the ONE reader of the suffix — placement
    // resolution calls it to decide whether a holding contradicts the item's
    // own rack summary. Before the fix this was false and the row read as a
    // contradiction of itself.
    expect(locationNameSitsOnRack(inserted!.name, '43-B')).toBe(true);
  });

  it('and that row can still be RENAMED — the create and rename guards agree', async () => {
    // The sharpest consequence of the hole: a stripped row could never be
    // renamed again, because `assertRenameKeepsCratePosition` reads the columns
    // and refuses every name that does not carry 43-B. Feed what create() wrote
    // straight into update() and it must be accepted.
    const { inserted } = await create(STRIPPED);
    const stub = makeSupabaseStub({
      'locations.select': { data: { kind: 'crate', rack_number: '43', rack_row: 'B' }, error: null },
      'locations.update': { data: { id: 'loc-new' }, error: null },
    });
    const svc = new LocationsService(makeServiceContext(stub.client));
    await expect(svc.update('loc-new', { name: inserted!.name })).resolves.toBeDefined();
    expect(stub.chainArgs.get('locations.update')?.[0]?.[0]).toEqual({
      name: 'Gray #BIN on rack 43-B',
    });
  });

  it('splits a whole rack label typed into the position, then names it once', async () => {
    // The 2026-07-23 shape applies to a crate's position too: "43-B" parked in
    // the number field must decompose AND must not name "…on rack 43-B-".
    const { inserted } = await create({ ...STRIPPED, rackNumber: '43-B', rackRow: null });
    expect(inserted?.name).toBe('Gray #BIN on rack 43-B');
    expect(inserted?.rack_number).toBe('43');
    expect(inserted?.rack_row).toBe('B');
  });

  it('the COLUMNS win when the name claims a different rack', async () => {
    // The rename guard refuses this pairing because there the columns are
    // already committed and the name is what the operator just typed. At CREATE
    // both arrive together, and the columns are what every downstream reader
    // (rename guard, put-away stamp, placement resolution) keys on — so a name
    // disagreeing with them is the defect, not the intent.
    const { inserted } = await create({ ...STRIPPED, name: 'Gray #BIN on rack 41-C' });
    expect(inserted?.name).toBe('Gray #BIN on rack 43-B');
  });

  it('REFUSES a positioned crate it cannot name, and writes NOTHING', async () => {
    // A colour alone does not name a crate, so there is nothing to compose the
    // position into. Refuse rather than insert it position-less — that would be
    // the very row this guard exists to prevent.
    const { result, inserted } = await create({
      ...STRIPPED,
      name: 'Gray BIN',
      crateNumber: null,
    });
    expect(result.ok).toBe(false);
    const error = (result as { error: unknown }).error;
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('validation_error');
    expect((error as ServiceError).message).toContain('43-B');
    // Fails CLOSED: the guard runs BEFORE the insert, not beside it.
    expect(inserted).toBeUndefined();
  });
});

describe('everything that is not a positioned crate keeps its name verbatim', () => {
  it('a POSITION-LESS crate is left exactly as named (the permanent legacy shape)', async () => {
    // Every crate row in production today was created this way — "Blue #Shelf",
    // no rack at all. Never normalised, never backfilled.
    const { inserted } = await create({
      name: 'Blue #Shelf',
      type: 'bin',
      kind: 'crate',
      warehouseId: WAREHOUSE,
      crateColor: 'blue',
      crateNumber: 'Shelf',
    });
    expect(inserted?.name).toBe('Blue #Shelf');
  });

  it('a RACK is untouched — its name IS its label', async () => {
    const { inserted } = await create({
      name: '22-B',
      type: 'shelf',
      kind: 'rack',
      warehouseId: WAREHOUSE,
      rackNumber: '22',
      rackRow: 'B',
    });
    expect(inserted?.name).toBe('22-B');
  });

  it('a SITE (kind NULL — never backfill it) is untouched', async () => {
    const { inserted } = await create({ name: 'DC4 North', type: 'warehouse' });
    expect(inserted?.name).toBe('DC4 North');
  });
});

/**
 * ═══ THE SHIPPED CALLERS COME OUT BYTE-IDENTICAL ═══
 *
 * Every put-away/transfer surface builds its create input from ONE
 * `planNewLocation` verdict (web actions' `newLocationInput`, the mobile
 * /api/v1 transfer route, InventoryService's auto-place). This drives the real
 * planner exactly the way they do and pins the inserted name to a LITERAL —
 * asserting `inserted.name === plan.name` alone would pass for an
 * implementation that re-composed both sides identically, which is the
 * tautology that hides a double-composition.
 */
describe('a caller that already composed is not composed again', () => {
  const CASES: Array<[string, NewLocationFields, string]> = [
    // The five real L4L "gray BIN" bins — the reason the position is in the name.
    ['positioned crate', { crateColor: 'gray', crateNumber: 'BIN', rackNumber: '43', rackRow: 'B' }, 'Gray #BIN on rack 43-B'],
    ['positioned crate, other row', { crateColor: 'gray', crateNumber: 'BIN', rackNumber: '41', rackRow: 'C' }, 'Gray #BIN on rack 41-C'],
    // A whole label typed into the "On rack" box.
    ['whole label as position', { crateColor: 'blue', crateNumber: '13', rackNumber: '38-B' }, 'Blue #13 on rack 38-B'],
    // Mixed-case colour: the registry LABEL wins, one spelling for 0270.
    ['mixed-case colour', { crateColor: 'BLUE', crateNumber: 'Bin', rackNumber: '39', rackRow: 'C' }, 'Blue #Bin on rack 39-C'],
    // An unrecognised colour is kept verbatim — the name must stay
    // reconstructible from what the operator typed.
    ['unknown colour', { crateColor: 'taupe', crateNumber: '4', rackNumber: '40', rackRow: 'B' }, 'taupe #4 on rack 40-B'],
    // A number alone IS a crate.
    ['colourless crate', { crateNumber: '9', rackNumber: 'A1' }, 'Crate #9 on rack A1'],
    // Position-less — the backward-compatible shape.
    ['position-less crate', { crateColor: 'blue', crateNumber: 'Shelf' }, 'Blue #Shelf'],
    // Racks, for completeness: the guard must not touch them.
    ['rack', { rackNumber: '22', rackRow: 'B' }, '22-B'],
    ['rack named with a dash', { rackNumber: 'E2E-RACK', rackRow: '1' }, 'E2E-RACK-1'],
  ];

  it.each(CASES)('%s → %o names %o, unchanged', async (_label, fields, expected) => {
    const plan = planNewLocation(fields);
    if (plan.kind === 'invalid') throw new Error('fixture names no destination');
    const isCrate = plan.kind === 'crate';
    // Exactly what `newLocationInput` (server/actions/inventory.ts) and the
    // mobile transfer route hand to the service.
    const { result, inserted } = await create({
      name: plan.name,
      type: isCrate ? 'bin' : 'shelf',
      kind: isCrate ? 'crate' : 'rack',
      warehouseId: WAREHOUSE,
      rackNumber: plan.rackNumber,
      rackRow: plan.rackRow,
      crateColor: plan.crateColor,
      crateNumber: plan.crateNumber,
    });
    expect(result.ok).toBe(true);
    expect(inserted?.name).toBe(expected);
    // ...and it is still the string the client's confirmation showed, which is
    // the string migration 0270's dedupe index matches.
    expect(inserted?.name).toBe(plan.name);
  });

  it('never doubles the suffix', async () => {
    for (const [, fields] of CASES) {
      const plan = planNewLocation(fields);
      if (plan.kind === 'invalid') continue;
      const { inserted } = await create({
        name: plan.name,
        type: plan.kind === 'crate' ? 'bin' : 'shelf',
        kind: plan.kind,
        warehouseId: WAREHOUSE,
        rackNumber: plan.rackNumber,
        rackRow: plan.rackRow,
        crateColor: plan.crateColor,
        crateNumber: plan.crateNumber,
      });
      expect(
        inserted!.name.toLowerCase().split(' on rack ').length - 1,
        `${plan.name} was composed twice`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The dedupe lookup has to resolve against the name `create` WOULD write, or a
 * normalised crate is created once and then missed forever — the second call
 * falls through to a second insert and 0270's unique index answers with a 23505
 * the caller reads as an internal error.
 */
describe('find-or-create resolves against the name create() actually writes', () => {
  async function findOrCreate(existing: Array<Record<string, unknown>>, input: CreateLocationInput) {
    const stub = makeSupabaseStub({
      'locations.select': { data: existing, error: null },
      'locations.insert': { data: { id: 'loc-new' }, error: null },
    });
    const svc = new LocationsService(makeServiceContext(stub.client));
    const row = (await svc.findOrCreateRackOrCrate(input)) as { id: string };
    return { row, created: stub.chainArgs.get('locations.insert') !== undefined };
  }

  it('REUSES the normalised row when handed the stripped shape a second time', async () => {
    const first = await create(STRIPPED);
    expect(first.inserted?.name).toBe('Gray #BIN on rack 43-B');
    const existing = [
      {
        id: 'loc-existing',
        name: first.inserted!.name,
        kind: 'crate',
        warehouse_id: WAREHOUSE,
        deleted_at: null,
      },
    ];
    const { row, created } = await findOrCreate(existing, STRIPPED);
    expect(created, 'a second stripped create minted a duplicate crate row').toBe(false);
    expect(row.id).toBe('loc-existing');
  });

  it('still reuses a POSITION-LESS crate by its own name (backward compatibility)', async () => {
    const existing = [
      {
        id: 'loc-legacy',
        name: 'Blue #Shelf',
        kind: 'crate',
        warehouse_id: WAREHOUSE,
        deleted_at: null,
      },
    ];
    const { row, created } = await findOrCreate(existing, {
      name: 'Blue #Shelf',
      type: 'bin',
      kind: 'crate',
      warehouseId: WAREHOUSE,
      crateColor: 'blue',
      crateNumber: 'Shelf',
    });
    expect(created).toBe(false);
    expect(row.id).toBe('loc-legacy');
  });
});
