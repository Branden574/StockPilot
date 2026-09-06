import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { replacePrimaryPhoto } from './item-photo-replace';

/**
 * SP-078 — "Replace photo" on the mobile item screen used to run the
 * DESTRUCTIVE half first: it removed the old storage objects, deleted every
 * `item_images` row for the item, and only THEN inserted the new row, with no
 * check on either destructive result and no compensation if the insert failed.
 *
 * Two orders, both reachable by a warehouse phone on a flaky link:
 *   (a) remove + delete succeed, insert fails -> the item now has ZERO image
 *       rows, the old object is gone forever, and the freshly-uploaded object
 *       sits unreferenced in the bucket. The item shows no photo anywhere.
 *   (b) the storage remove succeeds but the row delete errors -> execution
 *       fell through to the insert, leaving OLD rows pointing at DELETED
 *       objects. Web's primary resolver orders `is_primary desc, sort_order`
 *       and the stale row ties, so a list thumbnail can pick a dangling path
 *       whose signed URL 404s.
 *
 * These tests pin the order that makes both impossible:
 *   INSERT (with row proof) -> on failure remove ONLY the new object ->
 *   on success delete the old PRIMARY rows -> only then remove their objects.
 * Deleting the rows before the objects is deliberate: a failure there leaves
 * an invisible orphan object, never a row pointing at nothing.
 */

type PgResult<T> = { data: T; error: { message: string } | null };

interface FakeConfig {
  insert?: PgResult<{ id: string } | null>;
  oldRows?: PgResult<{ id: string; storage_path: string | null }[] | null>;
  del?: { error: { message: string } | null };
  remove?: (paths: string[]) => { error: { message: string } | null };
}

interface LogEntry {
  op: 'insert' | 'select' | 'delete' | 'storage.remove';
  detail: Record<string, unknown>;
}

function makeFakeClient(cfg: FakeConfig) {
  const log: LogEntry[] = [];
  const tables: string[] = [];
  const buckets: string[] = [];

  const table = {
    insert(row: Record<string, unknown>) {
      return {
        select(cols: string) {
          return {
            async single() {
              log.push({ op: 'insert', detail: { row, cols } });
              return cfg.insert ?? { data: { id: 'new-row' }, error: null };
            },
          };
        },
      };
    },
    select(cols: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        eq(col: string, val: unknown) {
          filters[`eq:${col}`] = val;
          return chain;
        },
        neq(col: string, val: unknown) {
          filters[`neq:${col}`] = val;
          return chain;
        },
        then<A, B>(
          onOk: (v: PgResult<{ id: string; storage_path: string | null }[] | null>) => A,
          onErr?: (e: unknown) => B,
        ) {
          log.push({ op: 'select', detail: { cols, filters: { ...filters } } });
          return Promise.resolve(cfg.oldRows ?? { data: [], error: null }).then(onOk, onErr);
        },
      };
      return chain;
    },
    delete() {
      return {
        async in(col: string, vals: string[]) {
          log.push({ op: 'delete', detail: { col, vals } });
          return cfg.del ?? { error: null };
        },
      };
    },
  };

  const client = {
    from(name: string) {
      tables.push(name);
      return table;
    },
    storage: {
      from(bucket: string) {
        buckets.push(bucket);
        return {
          async remove(paths: string[]) {
            log.push({ op: 'storage.remove', detail: { bucket, paths } });
            return cfg.remove?.(paths) ?? { error: null };
          },
        };
      },
    },
  };

  return { client, log, tables, buckets };
}

// The helper is written against the real supabase-js surface; the fake only
// implements the handful of methods it actually touches.
const asClient = (c: unknown) => c as Parameters<typeof replacePrimaryPhoto>[0]['supabase'];

const ARGS = { orgId: 'org-1', itemId: 'item-1', newPath: 'org-1/items/item-1/new.jpg' };

describe('replacePrimaryPhoto — the new row is written before anything is destroyed', () => {
  it('order (a): a failed insert removes ONLY the new object and touches no existing row', async () => {
    const { client, log } = makeFakeClient({
      insert: { data: null, error: { message: 'new row violates row-level security policy' } },
      oldRows: {
        data: [{ id: 'old-1', storage_path: 'org-1/items/item-1/old.jpg' }],
        error: null,
      },
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('row-level security');

    // Exactly one destructive act: dropping the object we just uploaded.
    expect(log.filter((l) => l.op === 'delete')).toHaveLength(0);
    const removes = log.filter((l) => l.op === 'storage.remove');
    expect(removes).toHaveLength(1);
    expect(removes[0].detail.paths).toEqual([ARGS.newPath]);
  });

  it('inserts with row proof, then deletes only the OTHER primary rows, then their objects', async () => {
    const { client, log, tables, buckets } = makeFakeClient({
      insert: { data: { id: 'new-row' }, error: null },
      oldRows: {
        data: [
          { id: 'old-1', storage_path: 'org-1/items/item-1/old.jpg' },
          { id: 'old-2', storage_path: null },
        ],
        error: null,
      },
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res).toEqual({ ok: true, imageId: 'new-row', warnings: [] });
    expect(log.map((l) => l.op)).toEqual(['insert', 'select', 'delete', 'storage.remove']);

    // Row proof on the insert — a 0-row insert must not read as success.
    expect(log[0].detail.cols).toBe('id');
    expect(log[0].detail.row).toMatchObject({
      organization_id: 'org-1',
      item_id: 'item-1',
      storage_path: ARGS.newPath,
      is_primary: true,
    });

    // Only PRIMARY siblings are swept — a web gallery's extra images survive.
    expect(log[1].detail.filters).toMatchObject({
      'eq:item_id': 'item-1',
      'eq:is_primary': true,
      'neq:id': 'new-row',
    });
    expect(log[2].detail).toEqual({ col: 'id', vals: ['old-1', 'old-2'] });
    expect(log[3].detail).toEqual({
      bucket: 'item-images',
      paths: ['org-1/items/item-1/old.jpg'],
    });
    expect(tables).toEqual(['item_images', 'item_images', 'item_images']);
    expect(buckets).toEqual(['item-images']);
  });

  it('order (b): a failed row delete leaves the old OBJECTS alone — never a dangling row', async () => {
    const { client, log } = makeFakeClient({
      insert: { data: { id: 'new-row' }, error: null },
      oldRows: {
        data: [{ id: 'old-1', storage_path: 'org-1/items/item-1/old.jpg' }],
        error: null,
      },
      del: { error: { message: 'network request failed' } },
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.imageId).toBe('new-row');
    expect(res.warnings.join(' ')).toContain('network request failed');
    // The old row survives, so its object MUST survive with it.
    expect(log.filter((l) => l.op === 'storage.remove')).toHaveLength(0);
  });

  it('a failed old-object cleanup is a warning, never a lost photo', async () => {
    const { client } = makeFakeClient({
      insert: { data: { id: 'new-row' }, error: null },
      oldRows: {
        data: [{ id: 'old-1', storage_path: 'org-1/items/item-1/old.jpg' }],
        error: null,
      },
      remove: () => ({ error: { message: 'storage unreachable' } }),
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.imageId).toBe('new-row');
    expect(res.warnings.join(' ')).toContain('storage unreachable');
  });

  it('a failed lookup of the old rows still keeps the new photo', async () => {
    const { client, log } = makeFakeClient({
      insert: { data: { id: 'new-row' }, error: null },
      oldRows: { data: null, error: { message: 'timeout' } },
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res.ok).toBe(true);
    expect(log.filter((l) => l.op === 'delete')).toHaveLength(0);
    expect(log.filter((l) => l.op === 'storage.remove')).toHaveLength(0);
  });

  it('an item with no previous photo deletes and removes nothing', async () => {
    const { client, log } = makeFakeClient({
      insert: { data: { id: 'new-row' }, error: null },
      oldRows: { data: [], error: null },
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res).toEqual({ ok: true, imageId: 'new-row', warnings: [] });
    expect(log.map((l) => l.op)).toEqual(['insert', 'select']);
  });

  it('an insert that reports no error but returns no row is still a failure', async () => {
    // Pattern #2 in the recurring-bug reference: a 0-row write with a null
    // error reads as success. Here that would mean deleting the old photo to
    // make way for a row that does not exist.
    const { client, log } = makeFakeClient({
      insert: { data: null, error: null },
      oldRows: {
        data: [{ id: 'old-1', storage_path: 'org-1/items/item-1/old.jpg' }],
        error: null,
      },
    });

    const res = await replacePrimaryPhoto({ supabase: asClient(client), ...ARGS });

    expect(res.ok).toBe(false);
    expect(log.filter((l) => l.op === 'delete')).toHaveLength(0);
    expect(log.filter((l) => l.op === 'storage.remove')[0].detail.paths).toEqual([ARGS.newPath]);
  });
});

/**
 * WIRING PIN — the screen must actually USE the helper.
 *
 * vitest here cannot render `app/` screens (they load native modules at
 * import time; see vitest.config.ts), so the connection between the fixed
 * sequence and the screen that runs it is pinned at source level, the same
 * posture as account-disabled-wiring.test.ts.
 */
const screen = readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8');
const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('app/item/[id].tsx wiring', () => {
  it('routes the photo replace through replacePrimaryPhoto', () => {
    expect(code).toContain("from '@/lib/item-photo-replace'");
    expect(code).toContain('replacePrimaryPhoto(');
  });

  it('no longer deletes item_images rows or old objects inline', () => {
    // The exact statements that made SP-078 destructive. Asserted as booleans
    // so a failure names the offending pattern instead of dumping the screen.
    expect({
      deletesRows: code.includes(".from('item_images').delete()"),
      deletesByItem: /delete\(\)\s*\.eq\('item_id'/.test(code),
      removesObjects: /storage\s*\.from\('item-images'\)\s*\.remove\(/.test(code),
    }).toEqual({ deletesRows: false, deletesByItem: false, removesObjects: false });
  });
});
