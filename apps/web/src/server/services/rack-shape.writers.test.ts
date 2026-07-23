/**
 * GUARD — no writer may store a COMPOSITE rack number.
 *
 * Incident 2026-07-23: rack 22-B was created with the whole label in the
 * number column — locations = ("22-B", null) instead of ("22","B") — and
 * put-away stamped that pair onto every item it placed there. The Rack column
 * still printed "22-B" (display just joins), but the Items filter, which
 * requires number="22" AND row="B", returned "No items yet". Three racks and
 * eight items were invisible to their own rack filter.
 *
 * Every test below drives a REAL writer with a full label typed into the
 * rack-NUMBER field — the exact operator action that caused the incident — and
 * asserts the persisted number is bare. `isCompositeRackNumber` is the shared
 * predicate, so this file fails the moment any of these paths stops going
 * through the parser.
 */
import { isCompositeRackNumber } from '@stockpilot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composeBookCustomFields } from '@/components/inventory/book-custom-fields';
import { deriveLocationName } from '@/lib/locations/rack-name';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});

import { InventoryService } from './inventory';
import { LocationsService } from './locations';

beforeEach(() => vi.clearAllMocks());

describe('writer guard: locations.rack_number is never composite', () => {
  async function createRack(rackNumber: string, rackRow?: string | null) {
    const stub = makeSupabaseStub({
      'locations.insert': { data: { id: 'loc-1' }, error: null },
    });
    const svc = new LocationsService(makeServiceContext(stub.client));
    await svc.create({
      name: deriveLocationName({ rackNumber, rackRow: rackRow ?? null }),
      type: 'shelf',
      kind: 'rack',
      warehouseId: '00000000-0000-0000-0000-000000000001',
      rackNumber,
      rackRow: rackRow ?? null,
    });
    const insertArgs = stub.chainArgs.get('locations.insert')?.[0]?.[0] as {
      rack_number: string | null;
      rack_row: string | null;
      name: string;
    };
    return insertArgs;
  }

  it('splits a full label typed into the rack-number field (the incident)', async () => {
    const row = await createRack('22-B');
    expect(row.rack_number).toBe('22');
    expect(row.rack_row).toBe('B');
    expect(isCompositeRackNumber(row.rack_number)).toBe(false);
  });

  it('still shows the rack called "22-B" (display must not change)', async () => {
    const row = await createRack('22-B');
    expect(row.name).toBe('22-B');
  });

  it('leaves a number-only rack alone', async () => {
    const row = await createRack('20');
    expect(row.rack_number).toBe('20');
    expect(row.rack_row).toBeNull();
    expect(row.name).toBe('20');
  });

  it('keeps an already-decomposed pair intact', async () => {
    const row = await createRack('22', 'B');
    expect(row.rack_number).toBe('22');
    expect(row.rack_row).toBe('B');
  });

  it('does not split a dashed rack NAME that has its own row', async () => {
    const row = await createRack('E2E-RACK', '1');
    expect(row.rack_number).toBe('E2E-RACK');
    expect(row.rack_row).toBe('1');
    expect(row.name).toBe('E2E-RACK-1');
  });
});

describe('writer guard: put-away stamps a decomposed pair onto the item', () => {
  it('a LEGACY composite destination location is decomposed before stamping', async () => {
    // This is the actual propagation step of the incident: put-away read
    // ("22-B", null) off the locations row and copied it onto every item.
    const stub = makeSupabaseStub({ 'rpc:inventory_set_rack': { data: 1, error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.stampPlacementBin(['item-1'], {
      kind: 'rack',
      rackNumber: '22-B',
      rackRow: null,
      name: '22-B',
    });
    const args = stub.rpcCalls[0]!.args as {
      p_rack_number: string | null;
      p_rack_row: string | null;
      p_bin_location: string | null;
    };
    expect(args.p_rack_number).toBe('22');
    expect(args.p_rack_row).toBe('B');
    expect(args.p_bin_location).toBe('22-B');
    expect(isCompositeRackNumber(args.p_rack_number)).toBe(false);
  });

  it('a decomposed destination is unchanged (row still upper-cased)', async () => {
    const stub = makeSupabaseStub({ 'rpc:inventory_set_rack': { data: 1, error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.stampPlacementBin(['item-1'], {
      kind: 'rack',
      rackNumber: '1',
      rackRow: 'a',
      name: '1-A',
    });
    const args = stub.rpcCalls[0]!.args as Record<string, unknown>;
    expect(args.p_rack_number).toBe('1');
    expect(args.p_rack_row).toBe('A');
    expect(args.p_bin_location).toBe('1-A');
  });
});

describe('writer guard: bulk "Set rack"', () => {
  it('splits a full label typed into the bulk rack-number box', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'i1', bin_location: null }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    // bulkUpdate pre-filters ids it may touch; the stub returns i1 for every
    // select, which is enough to reach the set_rack branch.
    await svc.bulkUpdate({
      ids: ['i1'],
      op: { kind: 'set_rack', rackNumber: '100-A', rackRow: null },
    });
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_rack');
    const args = call!.args as Record<string, unknown>;
    expect(args.p_rack_number).toBe('100');
    expect(args.p_rack_row).toBe('A');
    expect(args.p_bin_location).toBe('100-A');
    expect(isCompositeRackNumber(args.p_rack_number as string)).toBe(false);
  });
});

describe('writer guard: the book edit form', () => {
  const base = {
    existing: {},
    customFieldDefKeys: [],
    customFieldValues: {},
    author: '',
    crateColor: '',
    crateNumber: '',
    grade: '',
  };

  it('splits a full label typed into the book rack-number field', () => {
    const cf = composeBookCustomFields({ ...base, rackNumber: '38-A', rackRow: '' });
    expect(cf.book_rack_number).toBe('38');
    expect(cf.book_rack_row).toBe('A');
    expect(isCompositeRackNumber(cf.book_rack_number as string)).toBe(false);
  });

  it('keeps an already-decomposed pair, uppercasing the row', () => {
    const cf = composeBookCustomFields({ ...base, rackNumber: '38', rackRow: 'a' });
    expect(cf.book_rack_number).toBe('38');
    expect(cf.book_rack_row).toBe('A');
  });

  it('clearing the rack still clears both keys', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: { book_rack_number: '38', book_rack_row: 'A' },
      rackNumber: '',
      rackRow: '',
    });
    expect(cf.book_rack_number).toBeUndefined();
    expect(cf.book_rack_row).toBeUndefined();
  });
});
