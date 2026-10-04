import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

const { createAdminClientMock, unstableCacheMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  unstableCacheMock: vi.fn((fn: unknown, _keys?: unknown, _opts?: unknown) => fn),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ unstable_cache: unstableCacheMock, revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: createAdminClientMock }));

import {
  loadPhoneThumbMapCached,
  PHONE_SIGN_PATHS_PER_CALL,
  prewarmPhoneThumbMap,
} from './orders-phone-catalog';

// unstable_cache ran once, when the module loaded (before any clearAllMocks).
const CACHE_CALL = unstableCacheMock.mock.calls.find(([, keys]) =>
  JSON.stringify(keys).includes('orders-phone-thumbmap-v1'),
);

/**
 * The phone storefront's photo map (phone ordering PO-3, plan 3.1): its own
 * cached loader with its own key, the thumbnail before the master, every
 * image row, signed in calls of at most 1,000 paths one at a time (memory
 * reference_storage_signed_urls_1000_cap), and a map that is never cached
 * photo-less (it throws instead).
 */

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000ff';
const WH = '00000000-0000-4000-8000-0000000000b1';
const WH2 = '00000000-0000-4000-8000-0000000000b2';
const pad = (i: number) => String(i).padStart(4, '0');

function imageRow(
  itemId: string,
  over: {
    id?: string;
    primary?: boolean;
    sortOrder?: number;
    org?: string;
    warehouse?: string;
    deletedAt?: string | null;
    thumb?: string | null;
    master?: string | null;
  } = {},
): Record<string, unknown> {
  const primary = over.primary ?? true;
  return {
    id: over.id ?? `img-${itemId}-${primary ? 'p' : 'o'}`,
    organization_id: over.org ?? ORG,
    'item.warehouse_id': over.warehouse ?? WH,
    'item.deleted_at': over.deletedAt ?? null,
    item_id: itemId,
    thumb_path:
      over.thumb === undefined ? `${ORG}/items/${itemId}/thumb-${primary ? 'p' : 'o'}.webp` : over.thumb,
    storage_path:
      over.master === undefined ? `${ORG}/items/${itemId}/${primary ? 'p' : 'o'}.webp` : over.master,
    is_primary: primary,
    sort_order: over.sortOrder ?? 0,
  };
}

type SignAnswer = {
  data: Array<{ path: string; signedUrl: string | null; error: string | null }> | null;
  error: { message: string } | null;
};
const signAll = (paths: string[]): SignAnswer => ({
  data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}`, error: null })),
  error: null,
});

function mapClient(
  rows: ReadonlyArray<Record<string, unknown>>,
  sign: (paths: string[], call: number) => SignAnswer = (paths) => signAll(paths),
) {
  const stub = makeSupabaseStub({ 'item_images.select': servedLikePostgrest(rows) });
  const signCalls: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const createSignedUrls = vi.fn(async (paths: string[], ttl: number) => {
    signCalls.push(paths);
    expect(ttl).toBe(30 * 24 * 60 * 60);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 0));
    inFlight -= 1;
    if (paths.length > 1000) {
      return { data: null, error: { message: 'body/paths must NOT have more than 1000 items' } };
    }
    return sign(paths, signCalls.length - 1);
  });
  (stub.client.storage as unknown as { from: unknown }).from = vi.fn(() => ({ createSignedUrls }));
  createAdminClientMock.mockReturnValue(stub.client);
  return { stub, signCalls, maxInFlight: () => maxInFlight };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('loadPhoneThumbMapCached', () => {
  it('is its own cache: key orders-phone-thumbmap-v1, tag orders-phone-thumbmap, 4 hours', () => {
    const call = CACHE_CALL;
    expect(call).toBeDefined();
    expect(call![1]).toEqual(['orders-phone-thumbmap-v1']);
    expect(call![2]).toEqual({ revalidate: 4 * 60 * 60, tags: ['orders-phone-thumbmap'] });
  });

  it('signs the thumbnail first, the master only when there is no thumbnail', async () => {
    const { signCalls } = mapClient([
      imageRow('with-thumb'),
      imageRow('master-only', { thumb: null }),
      imageRow('no-file', { thumb: null, master: null }),
    ]);
    const map = await loadPhoneThumbMapCached(ORG, WH);
    expect(map.photos).toEqual({
      'with-thumb': `https://signed/${ORG}/items/with-thumb/thumb-p.webp`,
      'master-only': `https://signed/${ORG}/items/master-only/p.webp`,
    });
    expect(signCalls.flat()).toHaveLength(2);
    expect(Date.parse(map.signedAt)).not.toBeNaN();
  });

  it('the primary photo wins, then sort_order, then id; every page in that one order', async () => {
    const { stub } = mapClient([
      imageRow('a', { primary: false, sortOrder: 0, id: 'img-a-1' }),
      imageRow('a', { primary: true, sortOrder: 5, id: 'img-a-2' }),
      imageRow('b', { primary: false, sortOrder: 2, id: 'img-b-2' }),
      imageRow('b', { primary: false, sortOrder: 1, id: 'img-b-9', thumb: `${ORG}/items/b/first.webp` }),
    ]);
    const map = await loadPhoneThumbMapCached(ORG, WH);
    expect(map.photos.a).toBe(`https://signed/${ORG}/items/a/thumb-p.webp`);
    expect(map.photos.b).toBe(`https://signed/${ORG}/items/b/first.webp`);
    const chain = stub.chainsAll.get('item_images.select')![0]!;
    const args = stub.chainArgsAll.get('item_images.select')![0]!;
    expect(chain.flatMap((m, i) => (m === 'order' ? [args[i]] : []))).toEqual([
      ['is_primary', { ascending: false }],
      ['sort_order', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it("reads only this organization's, this warehouse's, not-deleted items, past the 1000-row cap", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const kept: string[] = [];
    for (let i = 0; i < 2600; i += 1) {
      const id = `item-${pad(i)}`;
      const kind = i % 4;
      if (kind === 0) rows.push(imageRow(id, { warehouse: WH2 }));
      else if (kind === 1) rows.push(imageRow(id, { org: OTHER_ORG }));
      else if (kind === 2) rows.push(imageRow(id, { deletedAt: '2026-09-01T00:00:00Z' }));
      else {
        rows.push(imageRow(id));
        kept.push(id);
      }
    }
    mapClient(rows);
    const map = await loadPhoneThumbMapCached(ORG, WH);
    expect(Object.keys(map.photos).sort()).toEqual(kept);
  });

  it('2,345 photographed items: three sign calls of at most 1,000 paths, one at a time', async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => imageRow(`item-${pad(i)}`));
    const { signCalls, maxInFlight } = mapClient(rows);
    const map = await loadPhoneThumbMapCached(ORG, WH);
    expect(PHONE_SIGN_PATHS_PER_CALL).toBe(1000);
    expect(signCalls.map((c) => c.length)).toEqual([1000, 1000, 345]);
    expect(maxInFlight()).toBe(1);
    expect(Object.keys(map.photos)).toHaveLength(2345);
  });

  it('a failed sign call THROWS (never a partly photo-less map cached for 4 h) and signs nothing after it', async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => imageRow(`item-${pad(i)}`));
    const { signCalls } = mapClient(rows, (paths, call) =>
      call === 1 ? { data: null, error: { message: 'storage 503' } } : signAll(paths),
    );
    await expect(loadPhoneThumbMapCached(ORG, WH)).rejects.toThrow(
      /photo sign failed \(paths 1001-2000 of 2345\): storage 503/,
    );
    expect(signCalls).toHaveLength(2);
  });

  it('more than 10% of signs failing throws; 10% or fewer leaves those items out', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => imageRow(`item-${pad(i)}`));
    const failFirst = (n: number) => (paths: string[]) => ({
      data: paths.map((p, i) => ({
        path: p,
        signedUrl: i < n ? null : `https://signed/${p}`,
        error: i < n ? 'not found' : null,
      })),
      error: null,
    });
    mapClient(rows, failFirst(11));
    await expect(loadPhoneThumbMapCached(ORG, WH)).rejects.toThrow(/failure ratio too high \(11\/100\)/);
    mapClient(rows, failFirst(10));
    const map = await loadPhoneThumbMapCached(ORG, WH);
    expect(Object.keys(map.photos)).toHaveLength(90);
    expect(map.photos['item-0000']).toBeUndefined();
  });

  it('a failed image-rows read throws and signs nothing', async () => {
    const stub = makeSupabaseStub({
      'item_images.select': { data: null, error: { message: 'timeout' } },
    });
    const createSignedUrls = vi.fn();
    (stub.client.storage as unknown as { from: unknown }).from = vi.fn(() => ({ createSignedUrls }));
    createAdminClientMock.mockReturnValue(stub.client);
    await expect(loadPhoneThumbMapCached(ORG, WH)).rejects.toThrow(/image rows read failed/);
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it('warns past 1.5 MB serialized, with the warehouse and the count, and not below', async () => {
    const long = 'x'.repeat(600);
    const big = Array.from({ length: 2700 }, (_, i) => imageRow(`item-${pad(i)}`));
    mapClient(big, (paths) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}?token=${long}`, error: null })),
      error: null,
    }));
    await loadPhoneThumbMapCached(ORG, WH);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${WH}: 2700 entries`)));
    vi.mocked(console.warn).mockClear();
    mapClient(big.slice(0, 100));
    await loadPhoneThumbMapCached(ORG, WH);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('prewarmPhoneThumbMap', () => {
  it('warms the map and reports the count; a failure is reported, never thrown', async () => {
    mapClient([imageRow('a'), imageRow('b')]);
    await expect(prewarmPhoneThumbMap(ORG, WH)).resolves.toMatchObject({
      organizationId: ORG,
      warehouseId: WH,
      photoCount: 2,
      error: null,
    });
    mapClient([imageRow('a')], () => ({ data: null, error: { message: 'down' } }));
    const failed = await prewarmPhoneThumbMap(ORG, WH);
    expect(failed.photoCount).toBe(0);
    expect(failed.error).toMatch(/photo sign failed/);
  });
});

// The source rules of this file (plan 3.1 and 3.8; patterns #13 and #23).
describe('orders-phone-catalog.ts source', () => {
  const FILE = path.resolve(__dirname, 'orders-phone-catalog.ts');
  const src = readFileSync(FILE, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('names no cookie-session or page-only helper (Bearer-safe)', () => {
    for (const banned of ['createClient(', 'withContext(', 'requireOrgContext(', 'getModulesForRequest(']) {
      expect(code).not.toContain(banned);
    }
  });

  it('the cached callback calls no other cached helper (a cache inside a cache)', () => {
    const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);
    let callback = '';
    const visit = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'loadPhoneThumbMapCached' &&
        n.initializer &&
        ts.isCallExpression(n.initializer)
      ) {
        callback = n.initializer.arguments[0]!.getText(sf);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(callback).toContain('createSignedUrls');
    expect(callback).not.toMatch(/Cached\(|unstable_cache\(|loadCatalog|loadCharters/);
  });

  it('the cached initializer is pinned: an edit to it is a deliberate key change in the same commit', () => {
    const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);
    let text = '';
    const visit = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'loadPhoneThumbMapCached' &&
        n.initializer
      ) {
        text = n.initializer.getText(sf);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(createHash('sha256').update(text).digest('hex')).toBe(PHONE_THUMB_MAP_PIN);
  });
});

const PHONE_THUMB_MAP_PIN = 'd089d854441af6658e55afe04df6b58c7e9f65d65dbdc123ff03233138610a3f';
