import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L10: saving a bundle's components was not atomic. update() deleted every
 * component row and then inserted the new set, so a failed insert left the
 * bundle with no components; create() inserted the bundle and then its
 * components, so a failed component insert left a bundle with none. update()
 * now upserts the new set first and only then deletes the rows dropped from
 * it; create() removes the bundle it just made when its components fail; a
 * set naming one item twice is refused before anything is written.
 */

const { createAdminClientMock, reportError } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  reportError: vi.fn(async () => undefined),
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: createAdminClientMock }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

import { BundlesService } from './bundles';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function service(results: Parameters<typeof makeSupabaseStub>[0]) {
  const stub = makeSupabaseStub({
    'bundles.select': { data: { id: 'b-1', phantom_item_id: null }, error: null },
    'bundle_components.select': { data: [], error: null },
    ...results,
  });
  return { stub, svc: new BundlesService(makeServiceContext(stub.client, { role: 'manager' })) };
}

beforeEach(() => vi.clearAllMocks());

/** The read-back of a save (select item_id), answered with `items`; every
 *  other read of bundle_components (get()'s) answers no rows. */
function readBack(items: string[]) {
  return (call: MockCall): QueryResult =>
    callArgs(call, 'select')?.[0] === 'item_id'
      ? { data: items.map((item_id) => ({ item_id })), error: null }
      : { data: [], error: null };
}

describe('BundlesService.update: components', () => {
  it('upserts the new set on (bundle_id, item_id), then deletes only the rows left out of it', async () => {
    const { stub, svc } = service({
      'bundle_components.insert': { data: null, error: null },
      'bundle_components.delete': { data: null, error: null },
      'bundle_components.select': readBack([A, B]),
    });

    await svc.update('b-1', {
      components: [
        { itemId: A, quantity: 2 },
        { itemId: B, quantity: 1, isOptional: true },
      ],
    });

    const upsert = stub.chainsAll.get('bundle_components.insert')?.[0] ?? [];
    const upsertArgs = stub.chainArgsAll.get('bundle_components.insert')?.[0] ?? [];
    expect(upsert[0]).toBe('upsert');
    expect(upsertArgs[0]?.[1]).toMatchObject({ onConflict: 'bundle_id,item_id' });
    expect(upsertArgs[0]?.[0]).toEqual([
      { bundle_id: 'b-1', item_id: A, quantity: 2, is_optional: false },
      { bundle_id: 'b-1', item_id: B, quantity: 1, is_optional: true },
    ]);

    const del = stub.chainsAll.get('bundle_components.delete')?.[0] ?? [];
    const delArgs = stub.chainArgsAll.get('bundle_components.delete')?.[0] ?? [];
    expect(del).toEqual(['delete', 'eq', 'not']);
    expect(delArgs[1]).toEqual(['bundle_id', 'b-1']);
    expect(delArgs[2]).toEqual(['item_id', 'in', `(${A},${B})`]);
    // The upsert went first.
    expect(stub.fromCalls.indexOf('bundle_components')).toBeGreaterThan(-1);
    // Then the set is read back, and with every item of it there nothing is
    // written again and nothing is reported.
    const reads = stub.chainArgsAll.get('bundle_components.select') ?? [];
    expect(reads[0]).toEqual([['item_id'], ['bundle_id', 'b-1']]);
    expect(stub.chainsAll.get('bundle_components.insert')).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a failed upsert deletes nothing, so the old set stays whole', async () => {
    const { stub, svc } = service({
      'bundle_components.insert': { data: null, error: { message: 'connection lost' } },
      'bundle_components.delete': { data: null, error: null },
    });

    await expect(svc.update('b-1', { components: [{ itemId: A, quantity: 2 }] })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(stub.chainsAll.get('bundle_components.delete')).toBeUndefined();
  });

  it('refuses a component id that is not a uuid before writing anything', async () => {
    const { stub, svc } = service({
      'bundle_components.insert': { data: null, error: null },
      'bundle_components.delete': { data: null, error: null },
    });

    await expect(
      svc.update('b-1', { components: [{ itemId: 'not-a-uuid', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chainsAll.get('bundle_components.insert')).toBeUndefined();
    expect(stub.chainsAll.get('bundle_components.delete')).toBeUndefined();
  });

  it('refuses a set that names one item twice, before writing anything', async () => {
    const { stub, svc } = service({});

    await expect(
      svc.update('b-1', {
        components: [
          { itemId: A, quantity: 2 },
          { itemId: A, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chainsAll.get('bundle_components.insert')).toBeUndefined();
    expect(stub.chainsAll.get('bundle_components.delete')).toBeUndefined();
  });
});

/**
 * Review (2026-10-05): update() writes in two statements, the upsert of the
 * new set and the delete of the rows left out of it. Two saves of one bundle
 * whose sets share no item, interleaved as
 *   A.upsert{a} -> B.upsert{b} -> A.delete(not a) -> B.delete(not b),
 * left NO components: a rolled-back probe as the QA manager under RLS on the
 * local stack returned 0, and assemble_bundle, which has no "no components"
 * refusal, then made kits from nothing. The old delete-then-insert gave the
 * union. A save now reads its set back after the delete and, unless every
 * item of it is there, writes the set again: an upsert only, never another
 * delete, so the last statement of the two saves is always one of them
 * writing its whole set and the bundle never ends empty.
 */
describe('BundlesService.update: a save that interleaves with another', () => {
  type Row = { bundle_id: string; item_id: string };

  /**
   * bundle_components as a table. An upsert adds its rows, a delete applies
   * its own filter, the read-back answers the rows, and `concurrent` runs
   * once, right after this save's delete: the other save's delete landing in
   * between.
   */
  function table(initial: Row[], concurrent?: (rows: Row[]) => Row[]) {
    let rows = [...initial];
    let interleaved = false;
    const stub = makeSupabaseStub({
      'bundles.select': { data: { id: 'b-1', phantom_item_id: null }, error: null },
      'bundle_components.insert': (call) => {
        const payload = (callArgs(call, 'upsert')?.[0] ?? []) as Row[];
        for (const p of payload) {
          if (!rows.some((r) => r.item_id === p.item_id)) rows.push({ bundle_id: p.bundle_id, item_id: p.item_id });
        }
        return { data: null, error: null };
      },
      'bundle_components.delete': (call) => {
        const list = String(callArgs(call, 'not')?.[2] ?? '()');
        const keep = list.replace(/[()]/g, '').split(',');
        rows = rows.filter((r) => keep.includes(r.item_id));
        if (concurrent && !interleaved) {
          interleaved = true;
          rows = concurrent(rows);
        }
        return { data: null, error: null };
      },
      'bundle_components.select': (call) => readBack(rows.map((r) => r.item_id))(call),
    });
    return {
      stub,
      rows: () => rows.map((r) => r.item_id).sort(),
      svc: new BundlesService(makeServiceContext(stub.client, { role: 'manager' })),
    };
  }

  it('writes its set again when a concurrent save dropped it, so the bundle is never left empty, and reports it', async () => {
    // B saved {B}: its upsert landed before this save's delete, and its
    // delete (everything but B) lands right after it.
    const { stub, rows, svc } = table([{ bundle_id: 'b-1', item_id: B }], (r) =>
      r.filter((x) => x.item_id === B),
    );

    await svc.update('b-1', { components: [{ itemId: A, quantity: 2 }] });

    // Not empty: this save's set is back.
    expect(rows()).toEqual([A]);
    const upserts = stub.chainArgsAll.get('bundle_components.insert') ?? [];
    expect(upserts).toHaveLength(2);
    // Upsert only: the second write never deletes, so it cannot empty the
    // bundle again.
    expect(stub.chainsAll.get('bundle_components.delete')).toHaveLength(1);
    expect(upserts[1]?.[0]).toEqual([
      [{ bundle_id: 'b-1', item_id: A, quantity: 2, is_optional: false }],
      { onConflict: 'bundle_id,item_id' },
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'bundles.update.rewritten',
        organizationId: 'org-test',
        extra: expect.objectContaining({ bundleId: 'b-1', missing: 1 }),
      }),
    );
  });

  it('with no concurrent save, nothing is written again', async () => {
    const { stub, rows, svc } = table([{ bundle_id: 'b-1', item_id: B }]);

    await svc.update('b-1', { components: [{ itemId: A, quantity: 2 }] });

    expect(rows()).toEqual([A]);
    expect(stub.chainsAll.get('bundle_components.insert')).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('writes its set again when the read-back fails (the upsert is idempotent), and reports the failed read', async () => {
    const { stub, svc } = service({
      'bundle_components.insert': { data: null, error: null },
      'bundle_components.delete': { data: null, error: null },
      'bundle_components.select': (call) =>
        callArgs(call, 'select')?.[0] === 'item_id'
          ? { data: null, error: { message: 'timeout' } }
          : { data: [], error: null },
    });

    await svc.update('b-1', { components: [{ itemId: A, quantity: 2 }] });

    expect(stub.chainsAll.get('bundle_components.insert')).toHaveLength(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'bundles.update.rewritten',
        extra: expect.objectContaining({ bundleId: 'b-1', readFailed: 'timeout' }),
      }),
    );
  });

  it('answers an error when writing the set again fails', async () => {
    let upserts = 0;
    const { svc } = service({
      'bundle_components.insert': () => {
        upserts += 1;
        return { data: null, error: upserts === 1 ? null : { message: 'connection lost' } };
      },
      'bundle_components.delete': { data: null, error: null },
      'bundle_components.select': readBack([]),
    });

    await expect(svc.update('b-1', { components: [{ itemId: A, quantity: 2 }] })).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

/**
 * The caller's client answers a bundles DELETE as RLS does: bundles_delete
 * (0140) admits admins only, so for a manager, who may create a bundle
 * (bundles_insert is manager; bundles:manage is a manager default), the
 * policy filters the row out and the DELETE answers 0 rows and NO error.
 */
function rlsBundlesDelete(role: 'owner' | 'admin' | 'manager') {
  return (call: MockCall) => {
    const visible = role === 'owner' || role === 'admin';
    const returning = call.methods.includes('select');
    return { data: returning ? (visible ? [{ id: 'b-new' }] : []) : null, error: null };
  };
}

type DeleteAnswer = QueryResult | ((call: MockCall) => QueryResult);

function createService(role: 'owner' | 'admin' | 'manager', adminDelete: DeleteAnswer) {
  const stub = makeSupabaseStub({
    'bundles.insert': { data: { id: 'b-new' }, error: null },
    'bundle_components.insert': { data: null, error: { message: 'connection lost' } },
    'bundles.delete': rlsBundlesDelete(role),
  });
  const admin = makeSupabaseStub({ 'bundles.delete': adminDelete });
  createAdminClientMock.mockReturnValue(admin.client);
  return {
    stub,
    admin,
    svc: new BundlesService(makeServiceContext(stub.client, { role, userId: 'user-test' })),
  };
}

describe('BundlesService.create: components', () => {
  it.each(['manager', 'admin', 'owner'] as const)(
    'removes the bundle it just made when its components cannot be saved, for a %s',
    async (role) => {
      const { stub, admin, svc } = createService(role, (call: MockCall) => ({
        data: call.methods.includes('select') ? [{ id: 'b-new' }] : null,
        error: null,
      }));

      await expect(
        svc.create({ name: 'Kit', components: [{ itemId: A, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'internal_error', internalDetail: 'connection lost' });

      // Not through the caller's client: for a manager RLS answers that delete
      // with 0 rows and no error, and the empty bundle would stay.
      expect(stub.chainsAll.get('bundles.delete')).toBeUndefined();
      // Through the service role, scoped to this org, the id this call just
      // inserted and its creator, and confirmed by the row it returns.
      const del = admin.chainsAll.get('bundles.delete')?.[0] ?? [];
      const delArgs = admin.chainArgsAll.get('bundles.delete')?.[0] ?? [];
      expect(del[0]).toBe('delete');
      expect(del).toContain('select');
      expect(delArgs).toContainEqual(['organization_id', 'org-test']);
      expect(delArgs).toContainEqual(['id', 'b-new']);
      expect(delArgs).toContainEqual(['created_by', 'user-test']);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it('reports when the undo removed no row, so an empty bundle never stays silently', async () => {
    const { svc } = createService('manager', (call: MockCall) => ({
      data: call.methods.includes('select') ? [] : null,
      error: null,
    }));

    await expect(
      svc.create({ name: 'Kit', components: [{ itemId: A, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'internal_error', internalDetail: 'connection lost' });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'bundles.create.undo',
        organizationId: 'org-test',
        extra: expect.objectContaining({ bundleId: 'b-new', removed: 0 }),
      }),
    );
  });

  it('reports when the undo itself fails, and still answers the components error', async () => {
    const { svc } = createService('manager', { data: null, error: { message: 'timeout' } });

    await expect(
      svc.create({ name: 'Kit', components: [{ itemId: A, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'internal_error', internalDetail: 'connection lost' });

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'bundles.create.undo',
        extra: expect.objectContaining({ bundleId: 'b-new', detail: 'timeout' }),
      }),
    );
  });

  it('touches nothing with the service role when the components save', async () => {
    const stub = makeSupabaseStub({
      'bundles.insert': { data: { id: 'b-new' }, error: null },
      'bundles.select': { data: { id: 'b-new', phantom_item_id: null }, error: null },
      'bundle_components.insert': { data: null, error: null },
      'bundle_components.select': { data: [], error: null },
    });
    const svc = new BundlesService(makeServiceContext(stub.client, { role: 'manager' }));

    await svc.create({ name: 'Kit', components: [{ itemId: A, quantity: 1 }] }).catch(() => undefined);

    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('bundles.delete')).toBeUndefined();
  });

  it('refuses a set that names one item twice, before writing anything', async () => {
    const { stub, svc } = service({});

    await expect(
      svc.create({
        name: 'Kit',
        components: [
          { itemId: A, quantity: 1 },
          { itemId: A, quantity: 3 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chainsAll.get('bundles.insert')).toBeUndefined();
  });
});
