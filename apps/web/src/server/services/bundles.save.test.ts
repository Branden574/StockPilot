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

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

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

describe('BundlesService.update: components', () => {
  it('upserts the new set on (bundle_id, item_id), then deletes only the rows left out of it', async () => {
    const { stub, svc } = service({
      'bundle_components.insert': { data: null, error: null },
      'bundle_components.delete': { data: null, error: null },
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

describe('BundlesService.create: components', () => {
  it('removes the bundle it just made when its components cannot be saved', async () => {
    const { stub, svc } = service({
      'bundles.insert': { data: { id: 'b-new' }, error: null },
      'bundle_components.insert': { data: null, error: { message: 'connection lost' } },
      'bundles.delete': { data: null, error: null },
    });

    await expect(
      svc.create({ name: 'Kit', components: [{ itemId: A, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'internal_error' });

    const del = stub.chainsAll.get('bundles.delete')?.[0] ?? [];
    const delArgs = stub.chainArgsAll.get('bundles.delete')?.[0] ?? [];
    expect(del[0]).toBe('delete');
    expect(delArgs).toContainEqual(['id', 'b-new']);
    expect(delArgs).toContainEqual(['organization_id', 'org-test']);
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
