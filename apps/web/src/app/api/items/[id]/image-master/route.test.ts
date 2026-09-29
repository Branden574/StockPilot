import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: GET /api/items/:id/image-master signs a photo only for an
 * item the CALLER can read (2026-09-28).
 *
 * The route used to hand any id straight to ItemImagesService, whose only gate
 * was item_images_select, and that policy is org-member wide. So any member,
 * however narrowly scoped, got a working service-role signed URL for the photo
 * of any item in the org. Reproduced on the local stack through the real route:
 * a category-scoped viewer and a warehouse-scoped staff member both got 200 and
 * a URL whose image downloaded, for items their own item list never shows.
 *
 * These tests run the REAL route and the REAL ItemImagesService against a stub
 * that answers like PostgREST under RLS (test/item-read-scope.ts): items only
 * when the caller's scope covers them, image rows for the whole org unless the
 * query joins them to their item. Only the service-role storage client, the
 * request context and the Data Cache wrapper are mocked.
 */

const { createSignedUrlMock, createSignedUrlsMock, withApiContextMock } = vi.hoisted(() => ({
  createSignedUrlMock: vi.fn(),
  createSignedUrlsMock: vi.fn(),
  withApiContextMock: vi.fn(),
}));

vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: withApiContextMock }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({ createSignedUrl: createSignedUrlMock, createSignedUrls: createSignedUrlsMock }),
    },
  }),
}));

import {
  itemReadScopeResults,
  type ScopedCaller,
  type WorldImage,
  type WorldItem,
} from '@/test/item-read-scope';
import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { GET } from './route';

const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const WH_MAIN = '0a0a0a0a-0000-4000-8000-0000000000a1';
const WH_ANNEX = '0a0a0a0a-0000-4000-8000-0000000000a2';
const WH_B = '0b0b0b0b-0000-4000-8000-0000000000b1';
const CAT_IN = '0a0a0a0a-0000-4000-8000-0000000000c1';
const CAT_OUT = '0a0a0a0a-0000-4000-8000-0000000000c2';

const VIEWER: ScopedCaller = { organizationId: ORG_A, warehouseIds: [WH_MAIN], categoryIds: [CAT_IN] };
const STAFF: ScopedCaller = { organizationId: ORG_A, warehouseIds: [WH_MAIN], categoryIds: 'all' };
const MANAGER: ScopedCaller = { organizationId: ORG_A, warehouseIds: 'all', categoryIds: 'all' };

/**
 * A fresh world per test: the service keeps an in-process memo of signed
 * paths, so reusing a path across tests would let one test's sign satisfy
 * another's without a storage call.
 */
let seq = 0;
function world() {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  const id = (tag: string) => `${tag}-0000-4000-8000-00000000${n}`;
  const items = {
    inScope: { id: id('11111111'), organization_id: ORG_A, warehouse_id: WH_MAIN, category_id: CAT_IN },
    otherCategory: { id: id('22222222'), organization_id: ORG_A, warehouse_id: WH_MAIN, category_id: CAT_OUT },
    otherWarehouse: { id: id('33333333'), organization_id: ORG_A, warehouse_id: WH_ANNEX, category_id: CAT_IN },
    otherOrg: { id: id('44444444'), organization_id: ORG_B, warehouse_id: WH_B, category_id: null },
    noPhoto: { id: id('55555555'), organization_id: ORG_A, warehouse_id: WH_MAIN, category_id: CAT_IN },
  } satisfies Record<string, WorldItem>;
  const images: WorldImage[] = [items.inScope, items.otherCategory, items.otherWarehouse, items.otherOrg].map(
    (item, i) => ({
      id: id(`9999999${i}`),
      organization_id: item.organization_id,
      item_id: item.id,
      storage_path: `${item.organization_id}/items/${item.id}/master.webp`,
      is_primary: true,
      sort_order: 0,
    }),
  );
  const pathOf = (itemId: string) => images.find((r) => r.item_id === itemId)?.storage_path;
  return { items, images, pathOf };
}

type World = ReturnType<typeof world>;

function signIn(caller: ScopedCaller, w: World, overrides: Record<string, QueryResult> = {}) {
  const stub = makeSupabaseStub({
    ...itemReadScopeResults(caller, { items: Object.values(w.items), images: w.images }),
    ...overrides,
  });
  withApiContextMock.mockResolvedValue(
    makeServiceContext(stub.client, { organizationId: caller.organizationId, role: 'viewer' }),
  );
  return stub;
}

/** Every storage path the service-role client was asked to sign. */
function signedPaths(): string[] {
  return [
    ...createSignedUrlsMock.mock.calls.flatMap((c) => c[0] as string[]),
    ...createSignedUrlMock.mock.calls.map((c) => c[0] as string),
  ];
}

function get(itemId: string) {
  return GET(new Request(`https://test.local/api/items/${itemId}/image-master`), {
    params: Promise.resolve({ id: itemId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
    data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}`, error: null })),
    error: null,
  }));
  createSignedUrlMock.mockImplementation(async (p: string) => ({
    data: { signedUrl: `https://signed.test/${p}` },
    error: null,
  }));
});

describe('GET /api/items/:id/image-master — the item is authorized before anything is signed', () => {
  it('a category-scoped viewer gets 404, and no URL is signed, for an item outside their categories', async () => {
    const w = world();
    signIn(VIEWER, w);

    const res = await get(w.items.otherCategory.id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(signedPaths()).not.toContain(w.pathOf(w.items.otherCategory.id));
    expect(signedPaths()).toEqual([]);
  });

  it('a warehouse-scoped staff member gets 404, and no URL is signed, for an item in another warehouse', async () => {
    const w = world();
    signIn(STAFF, w);

    const res = await get(w.items.otherWarehouse.id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(signedPaths()).toEqual([]);
  });

  it('the category-scoped viewer is refused the other-warehouse item too (both scopes apply)', async () => {
    const w = world();
    signIn(VIEWER, w);

    const res = await get(w.items.otherWarehouse.id);

    expect(res.status).toBe(404);
    expect(signedPaths()).toEqual([]);
  });

  it('an in-scope member still gets the signed master URL', async () => {
    const w = world();
    signIn(VIEWER, w);

    const res = await get(w.items.inScope.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `https://signed.test/${w.pathOf(w.items.inScope.id)}`,
    });
    expect(signedPaths()).toEqual([w.pathOf(w.items.inScope.id)]);
  });

  it('staff still get the other-category item in their own warehouse (only a viewer is category-restricted)', async () => {
    const w = world();
    signIn(STAFF, w);

    const res = await get(w.items.otherCategory.id);

    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe(`https://signed.test/${w.pathOf(w.items.otherCategory.id)}`);
  });

  it('a manager (no scope) still gets every item of the org', async () => {
    const w = world();
    signIn(MANAGER, w);

    for (const item of [w.items.inScope, w.items.otherCategory, w.items.otherWarehouse]) {
      const res = await get(item.id);
      expect(res.status).toBe(200);
      expect((await res.json()).url).toBe(`https://signed.test/${w.pathOf(item.id)}`);
    }
  });

  it("another org's item is 404, even for a manager, and nothing is signed", async () => {
    const w = world();
    signIn(MANAGER, w);

    const res = await get(w.items.otherOrg.id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(signedPaths()).toEqual([]);
  });

  it('an unreadable item answers exactly like an id that does not exist, so existence is not revealed', async () => {
    const w = world();
    signIn(VIEWER, w);

    const unreadable = await get(w.items.otherCategory.id);
    const missing = await get('00000000-0000-4000-8000-00000000dead');

    expect(unreadable.status).toBe(missing.status);
    expect(await unreadable.json()).toEqual(await missing.json());
  });

  it('a readable item with no photo is 200 with a null url (the client shows no preview)', async () => {
    const w = world();
    signIn(VIEWER, w);

    const res = await get(w.items.noPhoto.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
    expect(signedPaths()).toEqual([]);
  });

  it('unauthenticated is 401 and reads and signs nothing', async () => {
    const w = world();
    const stub = signIn(MANAGER, w);
    withApiContextMock.mockResolvedValue(null);

    const res = await get(w.items.inScope.id);

    expect(res.status).toBe(401);
    expect(stub.fromCalls).toEqual([]);
    expect(signedPaths()).toEqual([]);
  });

  it('a failed authorization read is a 500 with no URL, never "readable"', async () => {
    const w = world();
    signIn(MANAGER, w, {
      'inventory_items.select': { data: null, error: { message: 'fetch failed' } },
    });

    const res = await get(w.items.inScope.id);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(signedPaths()).toEqual([]);
  });

  it('the authorization read is scoped to the caller org and the requested id', async () => {
    const w = world();
    const stub = signIn(VIEWER, w);

    await get(w.items.inScope.id);

    const [itemRead] = stub.chainArgsAll.get('inventory_items.select') ?? [];
    const methods = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const eqs = methods
      .map((m, i) => [m, itemRead?.[i]] as const)
      .filter(([m]) => m === 'eq')
      .map(([, a]) => a);
    expect(eqs).toEqual([
      ['organization_id', ORG_A],
      ['id', w.items.inScope.id],
    ]);
  });

  it('not a uuid is 400, before any read', async () => {
    const w = world();
    const stub = signIn(MANAGER, w);

    const res = await get('not-a-uuid');

    expect(res.status).toBe(400);
    expect(stub.fromCalls).toEqual([]);
  });
});
