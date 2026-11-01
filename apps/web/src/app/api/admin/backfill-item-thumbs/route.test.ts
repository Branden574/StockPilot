import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const envHolder = vi.hoisted(() => ({
  env: { BACKFILL_ADMIN_SECRET: 'test-backfill-secret' as string | undefined },
}));
vi.mock('@/lib/env', () => envHolder);

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { reportError } from '@/lib/error-reporter';

import { GET, POST } from './route';

/**
 * The thumbnail backfill (B31): makes each missing thumbnail from its photo
 * the way the web uploader does (200 px WEBP, aspect kept), links one that is
 * already stored instead of replacing it, touches only the rows it is given,
 * and writes nothing on a dry run.
 *
 * The fake below is an in-memory bucket and item_images table implementing
 * the calls the route makes (storage exists/download/upload, and the row
 * reads and the guarded update).
 */

const ORG = '0a000000-0000-4000-8000-000000000001';
const ITEM_A = '0b000000-0000-4000-8000-00000000000a';
const ITEM_B = '0b000000-0000-4000-8000-00000000000b';
const ROW_A = '0c000000-0000-4000-8000-00000000000a';
const ROW_B = '0c000000-0000-4000-8000-00000000000b';
const ROW_C = '0c000000-0000-4000-8000-00000000000c';
const MASTER_A = `${ORG}/items/${ITEM_A}/k3x9q2m1a8zt.jpg`;
const THUMB_A = `${ORG}/items/${ITEM_A}/k3x9q2m1a8zt-thumb.webp`;
const MASTER_B = `${ORG}/items/${ITEM_B}/11111111-2222-4333-8444-555555555555.webp`;
const THUMB_B = `${ORG}/items/${ITEM_B}/11111111-2222-4333-8444-555555555555-thumb.webp`;

type Row = { id: string; storage_path: string | null; thumb_path: string | null };
type StoredObject = { bytes: Uint8Array; contentType: string };

interface FakeWorld {
  rows: Row[];
  objects: Map<string, StoredObject>;
  uploads: Array<{ path: string; contentType: string | undefined; upsert: boolean | undefined }>;
  updates: Array<{ id: string; thumb_path: string }>;
  /** Run before the guarded update: simulate a concurrent change. */
  beforeUpdate?: (id: string) => void;
}

function fakeAdmin(world: FakeWorld) {
  function rowsQuery() {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let head = false;
    const q = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        head = !!opts?.head;
        return q;
      },
      in(col: keyof Row, vals: string[]) {
        filters.push((r) => vals.includes(r[col] as string));
        return q;
      },
      is(col: keyof Row, val: null) {
        filters.push((r) => r[col] === val);
        return q;
      },
      not(col: keyof Row, op: string, val: null) {
        expect(op).toBe('is');
        filters.push((r) => r[col] !== val);
        return q;
      },
      order() {
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      then<A>(ok: (v: { data: Row[] | null; error: null; count: number | null }) => A) {
        let out = [...world.rows]
          .sort((a, b) => a.id.localeCompare(b.id))
          .filter((r) => filters.every((f) => f(r)));
        if (limitN !== null) out = out.slice(0, limitN);
        return Promise.resolve(
          head
            ? { data: null, error: null, count: out.length }
            : { data: out.map((r) => ({ ...r })), error: null, count: null },
        ).then(ok);
      },
    };
    return q;
  }

  function updateQuery(patch: { thumb_path: string }) {
    let id = '';
    let mustBeNull = false;
    const q = {
      eq(_col: 'id', v: string) {
        id = v;
        return q;
      },
      is(_col: 'thumb_path', _v: null) {
        mustBeNull = true;
        return q;
      },
      select() {
        return q;
      },
      async maybeSingle() {
        world.beforeUpdate?.(id);
        const row = world.rows.find((r) => r.id === id);
        if (!row || (mustBeNull && row.thumb_path !== null)) return { data: null, error: null };
        row.thumb_path = patch.thumb_path;
        world.updates.push({ id, thumb_path: patch.thumb_path });
        return { data: { id }, error: null };
      },
    };
    return q;
  }

  return {
    from(table: string) {
      expect(table).toBe('item_images');
      return {
        select: (cols: string, opts?: { count?: string; head?: boolean }) =>
          rowsQuery().select(cols, opts),
        update: (patch: { thumb_path: string }) => updateQuery(patch),
      };
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe('item-images');
        return {
          async exists(path: string) {
            return world.objects.has(path)
              ? { data: true, error: null }
              : { data: false, error: { message: 'Object not found', status: 400 } };
          },
          async download(path: string) {
            const o = world.objects.get(path);
            if (!o) return { data: null, error: { message: 'Object not found' } };
            return { data: { arrayBuffer: async () => o.bytes.slice().buffer }, error: null };
          },
          async upload(
            path: string,
            bytes: Uint8Array,
            opts: { contentType?: string; upsert?: boolean },
          ) {
            world.uploads.push({ path, contentType: opts.contentType, upsert: opts.upsert });
            if (world.objects.has(path) && !opts.upsert) {
              return { data: null, error: { message: 'The resource already exists' } };
            }
            world.objects.set(path, {
              bytes: new Uint8Array(bytes),
              contentType: opts.contentType ?? '',
            });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
}

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .jpeg()
      .toBuffer(),
  );
}

async function webp(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 160, g: 90, b: 30 } } })
      .webp()
      .toBuffer(),
  );
}

let world: FakeWorld;

function call(query: string, secret = 'test-backfill-secret') {
  return POST(
    new Request(`https://app.test/api/admin/backfill-item-thumbs${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    }),
  );
}

beforeEach(async () => {
  envHolder.env.BACKFILL_ADMIN_SECRET = 'test-backfill-secret';
  world = {
    rows: [
      { id: ROW_A, storage_path: MASTER_A, thumb_path: null },
      { id: ROW_B, storage_path: MASTER_B, thumb_path: null },
    ],
    objects: new Map([
      [MASTER_A, { bytes: await jpeg(1600, 1200), contentType: 'image/jpeg' }],
      [MASTER_B, { bytes: await webp(900, 1600), contentType: 'image/webp' }],
    ]),
    uploads: [],
    updates: [],
  };
  adminHolder.client = fakeAdmin(world);
});

describe('POST /api/admin/backfill-item-thumbs: the secret', () => {
  it('refuses every call while BACKFILL_ADMIN_SECRET is unset', async () => {
    envHolder.env.BACKFILL_ADMIN_SECRET = undefined;
    expect((await call(`?ids=${ROW_A}`)).status).toBe(401);
    expect(world.uploads).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    expect((await call(`?ids=${ROW_A}`, 'nope')).status).toBe(401);
    expect(world.uploads).toHaveLength(0);
  });
});

describe('GET /api/admin/backfill-item-thumbs: the probe the plan runs first', () => {
  // The build before B31 has no GET and ignores ids and dryRun, so every
  // authorized POST to it writes: the plan's caller asks this first and stops
  // unless it answers, and the answer must never cost a read or a write.
  function probe(secret = 'test-backfill-secret') {
    return GET(
      new Request('https://app.test/api/admin/backfill-item-thumbs', {
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
  }

  it('answers what this build accepts, and touches no row or object', async () => {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    vi.mocked(createAdminClient).mockClear();
    const res = await probe();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      backfill: 'item-thumbs',
      version: 2,
      accepts: ['ids', 'limit', 'dryRun'],
      maxIds: 60,
    });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(world.uploads).toHaveLength(0);
    expect(world.updates).toHaveLength(0);
  });

  it('refuses a wrong secret, and every probe while the secret is unset', async () => {
    expect((await probe('nope')).status).toBe(401);
    envHolder.env.BACKFILL_ADMIN_SECRET = undefined;
    expect((await probe()).status).toBe(401);
  });
});

describe('POST /api/admin/backfill-item-thumbs: making a thumbnail from its photo', () => {
  it("stores the web uploader's thumbnail beside the photo (200 px, aspect kept) and points the row at it", async () => {
    const res = await call(`?ids=${ROW_A}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ dryRun: false, processed: 1, created: 1, linked: 0, failed: 0 });
    expect(body.results).toEqual([{ id: ROW_A, outcome: 'created', thumbPath: THUMB_A }]);

    expect(world.uploads).toEqual([{ path: THUMB_A, contentType: 'image/webp', upsert: false }]);
    const meta = await sharp(Buffer.from(world.objects.get(THUMB_A)!.bytes)).metadata();
    // The old backfill asked Supabase for a 200 x 200 `cover` crop.
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 200, 150]);
    expect(world.rows.find((r) => r.id === ROW_A)!.thumb_path).toBe(THUMB_A);
    // The photo itself is untouched.
    expect(world.objects.get(MASTER_A)!.contentType).toBe('image/jpeg');
  });

  it('a portrait photo gets a portrait thumbnail', async () => {
    await call(`?ids=${ROW_B}`);
    const meta = await sharp(Buffer.from(world.objects.get(THUMB_B)!.bytes)).metadata();
    // 900 x 1600 fits 112.5 x 200: sharp rounds down, the browser's canvas to nearest.
    expect(meta.height).toBe(200);
    expect(Math.abs(meta.width! - 112.5)).toBeLessThanOrEqual(0.5);
  });

  it('touches only the rows it is given', async () => {
    await call(`?ids=${ROW_A}`);
    expect(world.updates.map((u) => u.id)).toEqual([ROW_A]);
    expect(world.rows.find((r) => r.id === ROW_B)!.thumb_path).toBeNull();
    expect(world.objects.has(THUMB_B)).toBe(false);
  });

  it('answers every id: one with a thumbnail already, and one that is no row', async () => {
    world.rows.push({ id: ROW_C, storage_path: MASTER_A, thumb_path: THUMB_A });
    const missing = '0c000000-0000-4000-8000-0000000000ff';
    const body = await (await call(`?ids=${ROW_C},${missing}`)).json();
    expect(body.results).toEqual(
      expect.arrayContaining([
        { id: missing, outcome: 'skipped', reason: 'no such row' },
        { id: ROW_C, outcome: 'skipped', reason: 'already has a thumbnail' },
      ]),
    );
    expect(world.uploads).toHaveLength(0);
    expect(world.updates).toHaveLength(0);
  });
});

describe('POST /api/admin/backfill-item-thumbs: a thumbnail already stored (the one-row fix)', () => {
  it('LINKS a thumbnail stored at the name whose row never pointed at it, and does not replace it', async () => {
    const existing = await webp(200, 150);
    world.objects.set(THUMB_A, { bytes: existing, contentType: 'image/webp' });
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results).toEqual([{ id: ROW_A, outcome: 'linked', thumbPath: THUMB_A }]);
    expect(body).toMatchObject({ created: 0, linked: 1 });
    expect(world.uploads).toHaveLength(0);
    expect(Buffer.from(world.objects.get(THUMB_A)!.bytes).equals(Buffer.from(existing))).toBe(true);
    expect(world.rows.find((r) => r.id === ROW_A)!.thumb_path).toBe(THUMB_A);
  });

  it('leaves the row alone when what sits at the name is not an image', async () => {
    world.objects.set(THUMB_A, {
      bytes: new TextEncoder().encode('<svg onload=x>'),
      contentType: 'image/webp',
    });
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({ id: ROW_A, outcome: 'failed' });
    expect(world.uploads).toHaveLength(0);
    expect(world.updates).toHaveLength(0);
  });
});

describe('POST /api/admin/backfill-item-thumbs: dry run', () => {
  it('reports what it would do and writes nothing', async () => {
    world.objects.set(THUMB_B, { bytes: await webp(113, 200), contentType: 'image/webp' });
    const body = await (await call(`?ids=${ROW_A},${ROW_B}&dryRun=1`)).json();
    expect(body).toMatchObject({
      dryRun: true,
      wouldCreate: 1,
      wouldLink: 1,
      created: 0,
      linked: 0,
    });
    expect(body.results).toEqual(
      expect.arrayContaining([
        { id: ROW_A, outcome: 'would-create', thumbPath: THUMB_A },
        { id: ROW_B, outcome: 'would-link', thumbPath: THUMB_B },
      ]),
    );
    expect(world.uploads).toHaveLength(0);
    expect(world.updates).toHaveLength(0);
    expect(world.objects.has(THUMB_A)).toBe(false);
  });
});

describe('POST /api/admin/backfill-item-thumbs: refusals', () => {
  it('a photo that is not an image is reported, and nothing is stored', async () => {
    world.objects.set(MASTER_A, {
      bytes: new TextEncoder().encode('%PDF-1.7 not a photo'),
      contentType: 'image/jpeg',
    });
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({
      id: ROW_A,
      outcome: 'failed',
      error: 'the photo is not an accepted image',
    });
    expect(world.uploads).toHaveLength(0);
    expect(world.updates).toHaveLength(0);
  });

  it('a photo that is missing is reported', async () => {
    world.objects.delete(MASTER_A);
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({
      id: ROW_A,
      outcome: 'failed',
      error: 'the photo could not be read',
    });
  });

  it('never hands storage a path that is not an item photo path', async () => {
    world.rows[0]!.storage_path = `${ORG}/items/${ITEM_A}/../../other-bucket/x.jpg`;
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({
      outcome: 'failed',
      error: 'the photo path is not an item photo path',
    });
    expect(world.uploads).toHaveLength(0);
  });

  it('never writes a thumbnail name that is not an item photo path itself', async () => {
    // A photo named with two dots passes the photo path shape, but its
    // thumbnail name would put the dash inside an extension, a name the web
    // never signs (item-images.ts isSignableItemImagePath): a row pointed at
    // it would show no photo at all in the Items list.
    const twoDots = `${ORG}/items/${ITEM_A}/k3x9q2m1a8zt.v2.jpg`;
    world.rows[0]!.storage_path = twoDots;
    world.objects.set(twoDots, { bytes: await jpeg(400, 300), contentType: 'image/jpeg' });
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({
      id: ROW_A,
      outcome: 'failed',
      error: 'the thumbnail name would not be an item photo path',
    });
    expect(world.uploads).toHaveLength(0);
    expect(world.updates).toHaveLength(0);
    expect(world.rows[0]!.thumb_path).toBeNull();
  });

  it('a row changed meanwhile is reported, not overwritten', async () => {
    world.beforeUpdate = (id) => {
      const row = world.rows.find((r) => r.id === id)!;
      row.thumb_path = `${ORG}/items/${ITEM_A}/someone-else-thumb.webp`;
    };
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({
      id: ROW_A,
      outcome: 'failed',
      error: 'the row changed or was removed meanwhile',
    });
    expect(world.rows[0]!.thumb_path).toBe(`${ORG}/items/${ITEM_A}/someone-else-thumb.webp`);
  });

  it('a thumbnail stored at the name since the check is not overwritten', async () => {
    // exists() says no, then the object appears before the upload: upsert false refuses it.
    const client = adminHolder.client as ReturnType<typeof fakeAdmin>;
    const realFrom = client.storage.from.bind(client.storage);
    client.storage.from = (bucket: string) => {
      const b = realFrom(bucket);
      return {
        ...b,
        async exists(path: string) {
          const r = await b.exists(path);
          if (path === THUMB_A)
            world.objects.set(THUMB_A, { bytes: new Uint8Array([1]), contentType: 'x' });
          return r;
        },
      };
    };
    const body = await (await call(`?ids=${ROW_A}`)).json();
    expect(body.results[0]).toMatchObject({ id: ROW_A, outcome: 'failed' });
    expect(world.uploads).toEqual([{ path: THUMB_A, contentType: 'image/webp', upsert: false }]);
    expect(Array.from(world.objects.get(THUMB_A)!.bytes)).toEqual([1]);
    expect(world.updates).toHaveLength(0);
  });

  it.each([
    ['not-a-uuid', 'every id must be a uuid'],
    ['', 'ids is empty'],
    [
      Array.from(
        { length: 61 },
        (_, i) => `0c000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ).join(','),
      'at most 60 ids per call',
    ],
  ])('refuses ids=%s with 400', async (ids, error) => {
    const res = await call(`?ids=${ids}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(world.uploads).toHaveLength(0);
  });
});

describe('POST /api/admin/backfill-item-thumbs: without ids', () => {
  it('takes the first rows by id that have a photo and no thumbnail, and says how many remain', async () => {
    world.rows.push({ id: ROW_C, storage_path: null, thumb_path: null });
    const body = await (await call('?limit=1')).json();
    expect(body).toMatchObject({ processed: 1, created: 1, remaining: 1 });
    expect(body.results).toEqual([{ id: ROW_A, outcome: 'created', thumbPath: THUMB_A }]);
  });
});

/** A client whose every item_images read answers `message` as its error. */
function failingReads(message: string) {
  const answer = { data: null, error: { message, code: '42501' }, count: null };
  const chain: object = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'then'
          ? (ok: (v: typeof answer) => unknown) => Promise.resolve(answer).then(ok)
          : () => chain,
    },
  );
  return { from: () => chain, storage: { from: () => ({}) } };
}

// S16: a failed read used to answer the database's own text and report
// nothing; the run's last catch answered the error's own text. The per-row
// results above keep theirs: they are the secret holder's diagnosis.
describe('POST /api/admin/backfill-item-thumbs: a failure of the run itself', () => {
  beforeEach(() => {
    vi.mocked(reportError).mockClear();
  });

  it.each([
    ['the candidate read', ''],
    ['the read of the rows asked for', `?ids=${ROW_A}`],
  ])(
    'a failed %s answers the fixed sentence, never the database text, and is reported',
    async (_label, query) => {
      adminHolder.client = failingReads('permission denied for table item_images');
      const res = await call(query);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'internal_error',
        message: 'Something went wrong. Please try again.',
      });
      expect(text).not.toContain('item_images');
      expect(reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
      expect((reported as Error).message).toBe('permission denied for table item_images');
      expect(context).toMatchObject({ tag: 'admin.backfill-item-thumbs' });
    },
  );

  it("a run that throws answers the fixed sentence, never the error's own text, and is reported", async () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'select')");
    adminHolder.client = {
      from: () => {
        throw err;
      },
    };
    const res = await call('');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('Cannot read');
    expect(reportError).toHaveBeenCalledWith(err, { tag: 'admin.backfill-item-thumbs' });
  });
});
