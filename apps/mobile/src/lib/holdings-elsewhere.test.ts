/**
 * The phone's one caller of item_holdings_elsewhere (0371), and the decisions
 * the move and remove sheets make from its answer.
 *
 * What must hold, each pinned below:
 *   • managers and above make NO call (decided by role);
 *   • a role that is not known yet DOES call (a manager's answer is empty);
 *   • ids travel in the RPC body, at most 500 per call, batches in parallel;
 *   • any failure (an error, PGRST202, a rejection, a payload the parser
 *     refuses) is 'unavailable', never "nothing elsewhere", and is not cached;
 *   • the sheets' copy is the web's, decided the same way;
 *   • the destination scope (owner decision Q4) is the member's assignment
 *     rows, and a failed read narrows AND says so.
 *
 * The live answers these fakes imitate were read off the local stack as QA
 * staff (QA Main DC) for the walk fixture's QA-CHROME: staged 5, unplaced 0,
 * placed 7 on one Annex rack; a 501-id call raised 22023 too_many_items; an
 * unknown function answered PGRST202.
 */
import {
  ELSEWHERE_UNAVAILABLE_NOTE,
  HOLDINGS_ELSEWHERE_MAX_IDS,
  type ItemElsewhere,
} from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESTINATION_ACCESS_UNREADABLE_NOTE,
  elsewhereSourcesCopy,
  SHEET_HOLDINGS_UNREADABLE_NOTE,
  readDestinationWarehouseScope,
  readHoldingsElsewhere,
  readItemElsewhere,
  seesEveryHolding,
  type AssignmentReadClient,
  type ElsewhereRpcClient,
} from './holdings-elsewhere';

const CHROME = '0a000000-0000-0000-0000-0000000000e1';
const RACK_QA2 = '0a000000-0000-0000-0000-0000000000b2';
const MAIN = '0a000000-0000-0000-0000-0000000000a1';

/** The live shape, verbatim (JSON numbers). */
const CHROME_ROW = {
  item_id: CHROME,
  staged: 5,
  unplaced: 0,
  placed: 7,
  placed_location_ids: [RACK_QA2],
};

type Answer = { data: unknown; error: { message: string; code?: string } | null };

/** A fake RPC client: records each call, answers through `handler`. */
function fakeRpc(handler: (fn: string, args: Record<string, unknown>) => Answer | Promise<Answer>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client: ElsewhereRpcClient & { calls: typeof calls } = {
    calls,
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args: args ?? {} });
      return Promise.resolve().then(() => handler(fn, args ?? {}));
    },
  };
  return client;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('seesEveryHolding — the skip is decided by ROLE', () => {
  it.each(['owner', 'admin', 'manager'])('%s skips', (role) => {
    expect(seesEveryHolding(role)).toBe(true);
  });

  it.each([['staff'], ['viewer'], [null], [undefined], [''], ['contractor']])(
    '%s calls',
    (role) => {
      expect(seesEveryHolding(role as string | null | undefined)).toBe(false);
    },
  );
});

describe('readHoldingsElsewhere — the call', () => {
  it('a MANAGER makes no call at all, and gets an empty answer', async () => {
    for (const role of ['owner', 'admin', 'manager']) {
      const client = fakeRpc(() => ({ data: [CHROME_ROW], error: null }));
      const read = await readHoldingsElsewhere(client, [CHROME], role);
      expect(client.calls).toHaveLength(0);
      expect(read).toEqual({ ok: true, byItem: new Map() });
    }
  });

  it('staff call item_holdings_elsewhere with the ids in the body', async () => {
    const client = fakeRpc(() => ({ data: [CHROME_ROW], error: null }));
    const read = await readHoldingsElsewhere(client, [CHROME], 'staff');
    expect(client.calls).toEqual([
      { fn: 'item_holdings_elsewhere', args: { p_item_ids: [CHROME] } },
    ]);
    expect(read.ok && read.byItem.get(CHROME)).toEqual({
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: [RACK_QA2],
    });
  });

  it('viewers call too', async () => {
    const client = fakeRpc(() => ({ data: [], error: null }));
    await readHoldingsElsewhere(client, [CHROME], 'viewer');
    expect(client.calls).toHaveLength(1);
  });

  it('a role NOT KNOWN YET calls (a manager is simply answered with nothing)', async () => {
    const client = fakeRpc(() => ({ data: [], error: null }));
    const read = await readHoldingsElsewhere(client, [CHROME], null);
    expect(client.calls).toHaveLength(1);
    expect(read).toEqual({ ok: true, byItem: new Map() });
  });

  it('no ids (or only blanks): no call', async () => {
    const client = fakeRpc(() => ({ data: [], error: null }));
    expect(await readHoldingsElsewhere(client, [], 'staff')).toEqual({
      ok: true,
      byItem: new Map(),
    });
    expect(await readHoldingsElsewhere(client, ['', null, undefined], 'staff')).toEqual({
      ok: true,
      byItem: new Map(),
    });
    expect(client.calls).toHaveLength(0);
  });

  it('501 ids go as 500 + 1, both in flight at once, never 501 in one call', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const release: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = fakeRpc(
      () =>
        new Promise<Answer>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve({ data: [], error: null });
          });
        }),
    );
    const pending = readHoldingsElsewhere(client, ids, 'staff');
    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(maxInFlight).toBe(2);
    release.forEach((r) => r());
    expect((await pending).ok).toBe(true);
    const sizes = client.calls.map((c) => (c.args.p_item_ids as string[]).length);
    expect(sizes).toEqual([HOLDINGS_ELSEWHERE_MAX_IDS, 1]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
  });

  it('numeric columns sent as strings are read as numbers', async () => {
    const client = fakeRpc(() => ({
      data: [{ ...CHROME_ROW, staged: '5.0000', placed: '7.0000' }],
      error: null,
    }));
    const read = await readHoldingsElsewhere(client, [CHROME], 'staff');
    expect(read.ok && read.byItem.get(CHROME)?.placed).toBe(7);
  });
});

describe('readHoldingsElsewhere — a failure is UNAVAILABLE, never empty', () => {
  it('an error answer', async () => {
    const client = fakeRpc(() => ({ data: null, error: { message: 'forbidden', code: '42501' } }));
    expect(await readHoldingsElsewhere(client, [CHROME], 'staff')).toEqual({ ok: false });
  });

  it('the function missing (the phone updated before the migration): PGRST202', async () => {
    const client = fakeRpc(() => ({
      data: null,
      error: { message: 'Could not find the function', code: 'PGRST202' },
    }));
    expect(await readHoldingsElsewhere(client, [CHROME], 'staff')).toEqual({ ok: false });
  });

  it('too many ids (22023), should a caller ever get past the batching', async () => {
    const client = fakeRpc(() => ({
      data: null,
      error: { message: 'too_many_items', code: '22023' },
    }));
    expect(await readHoldingsElsewhere(client, [CHROME], 'staff')).toEqual({ ok: false });
  });

  it('a rejected request (network down) does not throw out of the helper', async () => {
    const client: ElsewhereRpcClient = {
      rpc: () => Promise.reject(new Error('Network request failed')),
    };
    await expect(readHoldingsElsewhere(client, [CHROME], 'staff')).resolves.toEqual({ ok: false });
  });

  it('a client that throws synchronously does not throw out of the helper', async () => {
    const client: ElsewhereRpcClient = {
      rpc: () => {
        throw new Error('boom');
      },
    };
    await expect(readHoldingsElsewhere(client, [CHROME], 'staff')).resolves.toEqual({ ok: false });
  });

  it('no response at all', async () => {
    const client: ElsewhereRpcClient = { rpc: () => Promise.resolve(undefined) };
    expect(await readHoldingsElsewhere(client, [CHROME], 'staff')).toEqual({ ok: false });
  });

  it.each([
    ['a non-array payload', { rows: [CHROME_ROW] }],
    ['a row without an item id', [{ ...CHROME_ROW, item_id: null }]],
    ['a non-numeric quantity', [{ ...CHROME_ROW, placed: 'seven' }]],
  ])('a payload the parser refuses: %s', async (_label, data) => {
    const client = fakeRpc(() => ({ data, error: null }));
    expect(await readHoldingsElsewhere(client, [CHROME], 'staff')).toEqual({ ok: false });
  });

  it('ONE failed batch fails the whole answer: never a partial map', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => (i === 0 ? CHROME : `id-${i}`));
    const client = fakeRpc((_fn, args) =>
      (args.p_item_ids as string[]).length === 1
        ? { data: null, error: { message: 'timeout', code: '57014' } }
        : { data: [CHROME_ROW], error: null },
    );
    expect(await readHoldingsElsewhere(client, ids, 'staff')).toEqual({ ok: false });
  });

  it('a failure is not remembered: the next open asks again and gets the answer', async () => {
    let fail = true;
    const client = fakeRpc(() =>
      fail ? { data: null, error: { message: 'down' } } : { data: [CHROME_ROW], error: null },
    );
    expect((await readItemElsewhere(client, CHROME, 'staff')).status).toBe('unavailable');
    fail = false;
    expect((await readItemElsewhere(client, CHROME, 'staff')).status).toBe('some');
    expect(client.calls).toHaveLength(2);
  });
});

describe('readItemElsewhere — the state one screen renders', () => {
  it("'some' with the totals", async () => {
    const client = fakeRpc(() => ({ data: [CHROME_ROW], error: null }));
    expect(await readItemElsewhere(client, CHROME, 'staff')).toEqual({
      status: 'some',
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: [RACK_QA2],
    });
  });

  it("'none' when the item has no row (nothing hidden)", async () => {
    const client = fakeRpc(() => ({ data: [], error: null }));
    expect(await readItemElsewhere(client, CHROME, 'staff')).toEqual({ status: 'none' });
  });

  it("'none' for a manager, with no call", async () => {
    const client = fakeRpc(() => ({ data: [CHROME_ROW], error: null }));
    expect(await readItemElsewhere(client, CHROME, 'manager')).toEqual({ status: 'none' });
    expect(client.calls).toHaveLength(0);
  });

  it("'unavailable' on any failure", async () => {
    const client = fakeRpc(() => ({ data: null, error: { message: 'x' } }));
    expect(await readItemElsewhere(client, CHROME, 'staff')).toEqual({ status: 'unavailable' });
  });
});

// ── The sheets' copy ────────────────────────────────────────────────────────

const SOME: ItemElsewhere = {
  status: 'some',
  staged: 5,
  unplaced: 0,
  placed: 7,
  placedLocationIds: [RACK_QA2],
};
const MOVE_DEFAULT = 'This item has no stock in any location yet — receive or add stock first.';
const REMOVE_DEFAULT =
  'This item has no placed stock to remove. Anything on hand is still in staging or unplaced — put it away first, or adjust on-hand with a reason.';

describe('elsewhereSourcesCopy — Move stock', () => {
  it('a member who holds none of it here: the stock is in warehouses they do not manage', () => {
    expect(
      elsewhereSourcesCopy({ elsewhere: SOME, emptyDefault: MOVE_DEFAULT, holdsSomeHere: false }),
    ).toEqual({
      empty: "This item's stock (12) is in warehouses you don't manage.",
      note: "The rest of this item's stock (12) is in warehouses you don't manage.",
    });
  });

  it('a member who holds some here (QA-CHROME: 20 in Main Unplaced) gets the note', () => {
    expect(
      elsewhereSourcesCopy({ elsewhere: SOME, emptyDefault: MOVE_DEFAULT, holdsSomeHere: true })
        .note,
    ).toBe("The rest of this item's stock (12) is in warehouses you don't manage.");
  });

  it('nothing elsewhere: exactly what the sheet said before 0371, and no note', () => {
    expect(
      elsewhereSourcesCopy({
        elsewhere: { status: 'none' },
        emptyDefault: MOVE_DEFAULT,
        holdsSomeHere: false,
      }),
    ).toEqual({ empty: MOVE_DEFAULT, note: null });
    expect(
      elsewhereSourcesCopy({ elsewhere: null, emptyDefault: MOVE_DEFAULT, holdsSomeHere: false }),
    ).toEqual({ empty: MOVE_DEFAULT, note: null });
    expect(
      elsewhereSourcesCopy({
        elsewhere: { status: 'some', staged: 0, unplaced: 0, placed: 0, placedLocationIds: [] },
        emptyDefault: MOVE_DEFAULT,
        holdsSomeHere: false,
      }),
    ).toEqual({ empty: MOVE_DEFAULT, note: null });
  });

  it('a FAILED read never claims "no stock in any location"', () => {
    const copy = elsewhereSourcesCopy({
      elsewhere: { status: 'unavailable' },
      emptyDefault: MOVE_DEFAULT,
      holdsSomeHere: false,
    });
    expect(copy.empty).toBe(ELSEWHERE_UNAVAILABLE_NOTE);
    expect(copy.empty).not.toContain('no stock in any location');
    expect(copy.note).toBe(ELSEWHERE_UNAVAILABLE_NOTE);
  });
});

describe('a sheet whose own holdings read failed', () => {
  it('says it could not load the stock, and claims nothing about where it is', () => {
    expect(SHEET_HOLDINGS_UNREADABLE_NOTE).toBe(
      "Could not load this item's stock. Close this and try again.",
    );
    expect(SHEET_HOLDINGS_UNREADABLE_NOTE).not.toMatch(/warehouse|no stock|staging/i);
  });
});

describe('elsewhereSourcesCopy — Remove from rack', () => {
  it('no placed stock here, and none here at all: the stock is elsewhere', () => {
    expect(
      elsewhereSourcesCopy({ elsewhere: SOME, emptyDefault: REMOVE_DEFAULT, holdsSomeHere: false })
        .empty,
    ).toBe("This item's stock (12) is in warehouses you don't manage.");
  });

  it('no placed stock here, some in Staging here: both sentences, the parts named', () => {
    expect(
      elsewhereSourcesCopy({ elsewhere: SOME, emptyDefault: REMOVE_DEFAULT, holdsSomeHere: true })
        .empty,
    ).toBe(
      `${REMOVE_DEFAULT} The rest of this item's stock (12) is in warehouses you don't manage.`,
    );
  });

  it('a failed read with stock here keeps the sheet sentence and says what is unknown', () => {
    expect(
      elsewhereSourcesCopy({
        elsewhere: { status: 'unavailable' },
        emptyDefault: REMOVE_DEFAULT,
        holdsSomeHere: true,
      }).empty,
    ).toBe(`${REMOVE_DEFAULT} ${ELSEWHERE_UNAVAILABLE_NOTE}`);
  });

  it('a failed read with nothing here says only what is unknown', () => {
    expect(
      elsewhereSourcesCopy({
        elsewhere: { status: 'unavailable' },
        emptyDefault: REMOVE_DEFAULT,
        holdsSomeHere: false,
      }).empty,
    ).toBe(ELSEWHERE_UNAVAILABLE_NOTE);
  });

  it('nothing elsewhere: the sheet sentence, unchanged', () => {
    expect(
      elsewhereSourcesCopy({
        elsewhere: { status: 'none' },
        emptyDefault: REMOVE_DEFAULT,
        holdsSomeHere: true,
      }).empty,
    ).toBe(REMOVE_DEFAULT);
  });
});

// ── Owner decision Q4: where a scoped member may move stock TO ──────────────

type Filter = [string, string];

function fakeAssignments(answer: () => unknown) {
  const reads: { table: string; select: string; filters: Filter[] }[] = [];
  const client: AssignmentReadClient & { reads: typeof reads } = {
    reads,
    from(table: string) {
      const rec = { table, select: '', filters: [] as Filter[] };
      reads.push(rec);
      const chain = {
        select(cols: string) {
          rec.select = cols;
          return chain;
        },
        eq(col: string, val: string) {
          rec.filters.push([col, val]);
          return chain;
        },
        then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
          return Promise.resolve().then(answer).then(onOk, onErr);
        },
      };
      return chain;
    },
  };
  return client;
}

describe('readDestinationWarehouseScope', () => {
  const base = { organizationId: 'org-1', userId: 'user-1' };

  it('managers and above: unrestricted, no read', async () => {
    for (const role of ['owner', 'admin', 'manager']) {
      const client = fakeAssignments(() => ({ data: [], error: null }));
      expect(await readDestinationWarehouseScope(client, { ...base, role })).toEqual({
        writableIds: null,
        unreadable: false,
      });
      expect(client.reads).toHaveLength(0);
    }
  });

  it('a role not known yet: unrestricted (UI only; the server decides), no read', async () => {
    const client = fakeAssignments(() => ({ data: [], error: null }));
    expect(await readDestinationWarehouseScope(client, { ...base, role: null })).toEqual({
      writableIds: null,
      unreadable: false,
    });
    expect(client.reads).toHaveLength(0);
  });

  it('viewers write nowhere: no warehouse, no read', async () => {
    const client = fakeAssignments(() => ({ data: [{ warehouse_id: MAIN }], error: null }));
    expect(await readDestinationWarehouseScope(client, { ...base, role: 'viewer' })).toEqual({
      writableIds: [],
      unreadable: false,
    });
    expect(client.reads).toHaveLength(0);
  });

  it('staff: their own assignment rows in this org, the server write rule', async () => {
    const client = fakeAssignments(() => ({
      data: [{ warehouse_id: MAIN }, { warehouse_id: MAIN }, { warehouse_id: null }],
      error: null,
    }));
    expect(await readDestinationWarehouseScope(client, { ...base, role: 'staff' })).toEqual({
      writableIds: [MAIN],
      unreadable: false,
    });
    expect(client.reads).toEqual([
      {
        table: 'user_warehouse_assignments',
        select: 'warehouse_id',
        filters: [
          ['organization_id', 'org-1'],
          ['user_id', 'user-1'],
        ],
      },
    ]);
  });

  it('staff with no assignment rows: no warehouse (not unrestricted)', async () => {
    const client = fakeAssignments(() => ({ data: [], error: null }));
    expect(await readDestinationWarehouseScope(client, { ...base, role: 'staff' })).toEqual({
      writableIds: [],
      unreadable: false,
    });
  });

  it.each([
    ['an error answer', () => ({ data: null, error: { message: 'x' } })],
    ['a non-array payload', () => ({ data: { warehouse_id: MAIN }, error: null })],
    ['no response', () => undefined],
    [
      'a rejected request',
      () => {
        throw new Error('Network request failed');
      },
    ],
  ])('a failed read narrows to NO warehouse and says so: %s', async (_label, answer) => {
    const client = fakeAssignments(answer);
    expect(await readDestinationWarehouseScope(client, { ...base, role: 'staff' })).toEqual({
      writableIds: [],
      unreadable: true,
    });
  });

  it('no signed-in user id: unreadable, and no read', async () => {
    const client = fakeAssignments(() => ({ data: [{ warehouse_id: MAIN }], error: null }));
    expect(
      await readDestinationWarehouseScope(client, { ...base, userId: null, role: 'staff' }),
    ).toEqual({ writableIds: [], unreadable: true });
    expect(client.reads).toHaveLength(0);
  });

  it('the unreadable note says what is missing and what to do', () => {
    expect(DESTINATION_ACCESS_UNREADABLE_NOTE).toBe(
      'Could not load your warehouse access, so racks in your warehouses may be missing here. Close this and try again.',
    );
  });
});
