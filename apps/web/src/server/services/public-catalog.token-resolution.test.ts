import { beforeEach, describe, expect, it, vi } from 'vitest';

// Next builds its request stores on the global AsyncLocalStorage, which its
// server sets before anything else loads. Set here first, for the same reason.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
});

// Next's own request stores: the real unstable_cache reads them to find its
// cache and to decide between answering from an entry and reading again.
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';

/**
 * resolvePublicRequestToken: what a visitor of /r/<token> is answered, and
 * what is kept between visitors.
 *
 * The resolution is kept for 60 seconds by Next's unstable_cache. Three reads
 * decide it: the link, its organization, and the organization's
 * public_requests module (an explicit enabled row). supabase-js resolves a
 * failed read as `{ data: null, error }`, the shape of "no row", so each
 * read's error is checked. What this file holds:
 *
 *   1. With every read working, the answer is cached as before: a second
 *      visit inside the window reads nothing.
 *   2. A read that did not answer is never kept as an answer. The visitor
 *      gets PublicLinkUnavailableError (the page's error state with Try
 *      again), and the next visit reads again.
 *   3. A read that did not answer never serves an open link, a cached one
 *      included. An entry past its window, or one a link change expired, is
 *      not trusted: the request reads directly, and if that read does not
 *      answer either, the visitor gets the same error, never the earlier
 *      answer.
 *
 * unstable_cache here is the REAL one (next/cache), in its App Router branch:
 * it serves an entry that is past its window while it reads again in the
 * background, and keeps that entry when the new read throws. Only the store
 * under it is a stand-in, with the incremental cache's own rules for an
 * entry (stale past `revalidate` seconds or by a tag marked stale; gone when
 * a tag was expired).
 *
 * Made-up links and organizations only.
 */

const TAG = 'public-org-by-token';

/** The incremental cache under unstable_cache: entries, ages and tags. */
class StoreUnderTheCache {
  isOnDemandRevalidate = false;
  entries = new Map<string, { data: unknown; lastModified: number; tags: string[] }>();
  private expired = new Map<string, number>();
  private stale = new Map<string, number>();

  async generateSimpleCacheKey(key: string) {
    return key;
  }
  async get(key: string, ctx: { revalidate: number; tags: string[] }) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const after = (marks: Map<string, number>) =>
      ctx.tags.some((t) => (marks.get(t) ?? -Infinity) >= entry.lastModified);
    if (after(this.expired)) return null;
    const age = (Date.now() - entry.lastModified) / 1000;
    return {
      isStale: age > ctx.revalidate || after(this.stale),
      value: { kind: 'FETCH', data: entry.data, revalidate: ctx.revalidate },
    };
  }
  async set(key: string, value: { data: unknown }, ctx: { tags: string[] }) {
    this.entries.set(key, { data: value.data, lastModified: Date.now(), tags: ctx.tags });
  }
  /** revalidateTag(tag, { expire: 0 }): the next request is a miss. */
  expireTag(tag: string) {
    this.expired.set(tag, Date.now());
  }
  /** What is kept, as the cached function returned it. */
  kept(): unknown[] {
    return [...this.entries.values()].map((e) =>
      JSON.parse((e.data as { body: string }).body),
    );
  }
}

const store = { current: new StoreUnderTheCache() };

/** One request: its own work store, and the background work awaited after it. */
async function visit<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    incrementalCache: store.current,
    nextFetchId: 1,
    isOnDemandRevalidate: false,
    isDraftMode: false,
    route: '/r/[token]',
    pendingRevalidates: undefined as Record<string, Promise<unknown>> | undefined,
  };
  const workUnitStore = {
    type: 'request',
    url: { pathname: '/r/a-made-up-link-token-0001', search: '' },
    implicitTags: { tags: [] },
  };
  try {
    return await workAsyncStorage.run(workStore as never, () =>
      workUnitAsyncStorage.run(workUnitStore as never, fn),
    );
  } finally {
    // Next awaits these after the response: the write of a new entry, and
    // the read behind an entry that was served past its window.
    await Promise.allSettled(Object.values(workStore.pendingRevalidates ?? {}));
  }
}

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const adminRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { PublicLinkUnavailableError, resolvePublicRequestToken } from './public-catalog';

const TOKEN = 'a-made-up-link-token-0001';
const ORG = { id: 'org-1', name: 'Org One', logo_url: null, public_request_blurb: null };
const LINK_ROW = {
  id: 'link-1',
  organization_id: 'org-1',
  name: 'General',
  instructions: null,
  active: true,
  expires_at: null,
  available_from: null,
  available_until: null,
  availability_display: 'none',
  books_enabled: true,
  items_enabled: true,
  include_public_pool: false,
  default_max_qty: null,
};
type Answer = { data: unknown; error: unknown };
const FAILED: Answer = { data: null, error: { message: 'upstream timeout', code: '57014' } };
const NO_ROW: Answer = { data: null, error: null };
const MODULE_ON: Answer = { data: { module_id: 'public_requests' }, error: null };

/** What the three reads answer from now on. */
function database(over: { link?: Answer; org?: Answer; module?: Answer } = {}): SupabaseStub {
  const stub = makeSupabaseStub({
    'public_request_links.select': (over.link ?? { data: LINK_ROW, error: null }) as never,
    'organizations.select': (over.org ?? { data: ORG, error: null }) as never,
    'organization_modules.select': (over.module ?? MODULE_ON) as never,
  });
  adminRef.current = stub.client;
  return stub;
}

const resolve = () => visit(() => resolvePublicRequestToken(TOKEN));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
  store.current = new StoreUnderTheCache();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const seconds = (n: number) => vi.setSystemTime(Date.now() + n * 1000);

describe('every read works: the answer is cached as before', () => {
  it('an open link resolves, and a second visit inside the window reads nothing', async () => {
    const first = database();
    const resolved = await resolve();
    expect(resolved?.org).toEqual(ORG);
    expect(resolved?.link).toMatchObject({ id: 'link-1', active: true });
    expect(first.fromCalls).toEqual(['public_request_links', 'organizations', 'organization_modules']);

    seconds(30);
    const second = database();
    expect((await resolve())?.link?.id).toBe('link-1');
    expect(second.fromCalls).toEqual([]);
  });

  it('the module off is "no such page" (null), and that answer is cached', async () => {
    database({ module: NO_ROW });
    expect(await resolve()).toBeNull();
    const second = database({ module: NO_ROW });
    expect(await resolve()).toBeNull();
    expect(second.fromCalls).toEqual([]);
  });

  it('a token that names nothing is null, cached', async () => {
    database({ link: NO_ROW, org: NO_ROW });
    expect(await resolve()).toBeNull();
    const second = database({ link: NO_ROW, org: NO_ROW });
    expect(await resolve()).toBeNull();
    expect(second.fromCalls).toEqual([]);
  });

  it('an organization token with no links row resolves to the organization alone', async () => {
    database({ link: NO_ROW });
    expect(await resolve()).toEqual({ org: ORG, link: null });
  });
});

describe('a read that did not answer is never kept as an answer', () => {
  it.each([
    ['the link read', { link: FAILED }],
    ['the organization read', { org: FAILED }],
    ['the module read', { module: FAILED }],
    ['the organization-token read (no links row)', { link: NO_ROW, org: FAILED }],
    ['every read', { link: FAILED, org: FAILED, module: FAILED }],
  ] as Array<[string, { link?: Answer; org?: Answer; module?: Answer }]>)(
    '%s fails: the visitor gets the unavailable error, and no decided answer is kept',
    async (_name, failing) => {
      database(failing);
      await expect(resolve()).rejects.toBeInstanceOf(PublicLinkUnavailableError);
      // Nothing kept says "not found" or "open": only that the read did not answer.
      expect(store.current.kept()).toEqual([{ state: 'unread' }]);

      // The reads work again, inside the same 60 seconds: the link resolves.
      seconds(5);
      database();
      expect((await resolve())?.link?.id).toBe('link-1');
    },
  );

  it('while the reads keep failing every visit is the unavailable error, never "not found"', async () => {
    database({ link: FAILED, org: FAILED, module: FAILED });
    for (let i = 0; i < 3; i += 1) {
      await expect(resolve()).rejects.toBeInstanceOf(PublicLinkUnavailableError);
      seconds(10);
    }
  });
});

describe('a read that did not answer never serves an open link, a cached one included', () => {
  /** A visit that caches the open answer. */
  async function cachedOpen() {
    database();
    expect((await resolve())?.link?.active).toBe(true);
    expect(store.current.kept()).toMatchObject([{ state: 'resolved' }]);
  }

  it('the link is deactivated (its cache tag expired) and the module read fails: unavailable, never the cached open answer', async () => {
    await cachedOpen();
    seconds(10);
    // What the link's own actions do after a change.
    store.current.expireTag(TAG);
    database({ link: { data: { ...LINK_ROW, active: false }, error: null }, module: FAILED });

    for (let i = 0; i < 3; i += 1) {
      await expect(resolve()).rejects.toBeInstanceOf(PublicLinkUnavailableError);
      seconds(5);
    }

    // The module read answers again: the link as it now is, switched off.
    database({ link: { data: { ...LINK_ROW, active: false }, error: null } });
    expect((await resolve())?.link?.active).toBe(false);
  });

  it('the module is switched off, the entry is past its window and the module read fails: unavailable, never the entry the cache still holds', async () => {
    await cachedOpen();
    seconds(61);
    database({ module: FAILED });

    // The cache itself answers this request with the entry past its window
    // (and reads again behind it). The resolver does not trust that entry.
    await expect(resolve()).rejects.toBeInstanceOf(PublicLinkUnavailableError);
    seconds(5);
    await expect(resolve()).rejects.toBeInstanceOf(PublicLinkUnavailableError);

    // The module read answers again: off, so "no such page".
    database({ module: NO_ROW });
    expect(await resolve()).toBeNull();
  });

  it.each([
    ['the link read', { link: FAILED }],
    ['the organization read', { org: FAILED }],
  ] as Array<[string, { link?: Answer; org?: Answer }]>)(
    'an entry past its window and %s failing: unavailable, never the entry',
    async (_name, failing) => {
      await cachedOpen();
      seconds(61);
      database(failing);
      await expect(resolve()).rejects.toBeInstanceOf(PublicLinkUnavailableError);
    },
  );

  it('an entry past its window is not served even when every read works: the visitor gets what the reads say now', async () => {
    await cachedOpen();
    seconds(61);
    database({ link: { data: { ...LINK_ROW, active: false }, error: null } });
    expect((await resolve())?.link?.active).toBe(false);
  });

  it('an entry of a shape this code does not know is read again, never served', async () => {
    await cachedOpen();
    for (const entry of store.current.entries.values()) {
      entry.data = { ...(entry.data as object), body: JSON.stringify({ org: ORG, link: null }) };
    }
    const reads = database({ module: NO_ROW });
    expect(await resolve()).toBeNull();
    expect(reads.fromCalls.length).toBeGreaterThan(0);
  });
});

/**
 * Rule 3 depends on how the kept resolutions are dropped when a link
 * changes: expired at once, so the next request is a miss that reads. With
 * the 'max' profile the cache would answer that request with the entry from
 * before the change. Read from the source: every call that drops this tag.
 */
describe('a link change expires the kept resolutions at once', () => {
  it('every revalidateTag of the resolver tag passes { expire: 0 }, never a stale-while-revalidate profile', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

    const links = src('server/services/public-links.ts');
    expect(links).toMatch(/const TOKEN_RESOLUTION_GONE = \{ expire: 0 \} as const;/);
    const linkCalls = [...links.matchAll(/revalidateTag\(PUBLIC_TOKEN_RESOLVE_TAG,\s*([^)]+)\)/g)];
    expect(linkCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of linkCalls) expect(call[1]!.trim()).toBe('TOKEN_RESOLUTION_GONE');

    const profile = src('server/actions/profile.ts');
    const profileCalls = [
      ...profile.matchAll(/revalidateTag\(PUBLIC_TOKEN_RESOLVE_TAG,\s*([^)]+)\)/g),
    ];
    expect(profileCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of profileCalls) expect(call[1]!.trim()).toBe('{ expire: 0 }');

    // The tag the resolver is kept under is the one those calls drop.
    expect(links).toMatch(/export const PUBLIC_TOKEN_RESOLVE_TAG = 'public-org-by-token';/);
    expect(src('server/services/public-catalog.ts')).toMatch(/tags: \['public-org-by-token'\]/);
  });
});
