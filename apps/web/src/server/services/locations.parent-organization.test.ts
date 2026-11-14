// Security invariant (listed in scripts/security-test.sh): a parent location
// must belong to the active organization. LocationsService.create and update
// read the parent they are given in the active organization, with the
// caller's own client, before the write; a miss is not_found and nothing is
// written.

import { describe, expect, it } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type SupabaseStub } from '@/test/supabase-mock';

import type { ServiceContext } from './context';
import { LocationsService } from './locations';

// Made-up ids only.
const ORG_A = '0000000a-0000-4000-8000-000000000000';
const ORG_B = '0000000b-0000-4000-8000-000000000000';
const LOC_A = '0000000a-0000-4000-8000-0000000010a1';
const LOC_A_CHILD = '0000000a-0000-4000-8000-0000000010a2';
const LOC_B = '0000000b-0000-4000-8000-0000000010b1';

const LOCATIONS = [
  { id: LOC_A, organization_id: ORG_A, name: 'A site', kind: null, deleted_at: null },
  { id: LOC_A_CHILD, organization_id: ORG_A, name: 'A room', kind: null, deleted_at: null },
  { id: LOC_B, organization_id: ORG_B, name: 'B site', kind: null, deleted_at: null },
];

function service(): { svc: LocationsService; stub: SupabaseStub } {
  const stub = makeSupabaseStub({
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'locations.select': servedLikePostgrest(LOCATIONS),
    'locations.insert': { data: { id: 'loc-new' }, error: null },
    'locations.update': { data: { id: LOC_A_CHILD }, error: null },
  });
  const ctx = {
    supabase: stub.client,
    organizationId: ORG_A,
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ServiceContext;
  return { svc: new LocationsService(ctx), stub };
}

function parentRead(stub: SupabaseStub, parentId: string) {
  return (stub.chainArgsAll.get('locations.select') ?? []).find((args) =>
    args.some((a) => a[0] === 'id' && a[1] === parentId),
  );
}

describe('LocationsService.create: the parent must belong to the active organization', () => {
  it('a parent of another organization is not found and nothing is written', async () => {
    const { svc, stub } = service();
    await expect(svc.create({ name: 'Room', type: 'room', parentId: LOC_B })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Parent location not found.',
    });
    expect(parentRead(stub, LOC_B)).toContainEqual(['organization_id', ORG_A]);
    expect(stub.chainsAll.has('locations.insert')).toBe(false);
  });

  it('a parent of the active organization is filed under', async () => {
    const { svc, stub } = service();
    await svc.create({ name: 'Room', type: 'room', parentId: LOC_A });
    const inserted = stub.chainArgs.get('locations.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({ organization_id: ORG_A, parent_id: LOC_A });
  });

  it('no parent asks for no parent read', async () => {
    const { svc, stub } = service();
    await svc.create({ name: 'Room', type: 'room' });
    expect(stub.chainsAll.has('locations.insert')).toBe(true);
    expect(
      (stub.chainArgsAll.get('locations.select') ?? []).filter((args) =>
        args.some((a) => a[0] === 'id'),
      ),
    ).toEqual([]);
  });
});

describe('LocationsService.update: the parent must belong to the active organization', () => {
  it('a parent of another organization is not found and nothing is written', async () => {
    const { svc, stub } = service();
    await expect(svc.update(LOC_A_CHILD, { parentId: LOC_B })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Parent location not found.',
    });
    expect(stub.chainsAll.has('locations.update')).toBe(false);
  });

  it('a parent of the active organization is saved, and clearing the parent asks nothing', async () => {
    const { svc, stub } = service();
    await svc.update(LOC_A_CHILD, { parentId: LOC_A });
    expect(stub.chainArgs.get('locations.update')?.[0]?.[0]).toMatchObject({ parent_id: LOC_A });

    const cleared = service();
    await cleared.svc.update(LOC_A_CHILD, { parentId: null });
    expect(cleared.stub.chainArgs.get('locations.update')?.[0]?.[0]).toMatchObject({
      parent_id: null,
    });
    expect(cleared.stub.chainsAll.has('locations.select')).toBe(false);
  });
});
