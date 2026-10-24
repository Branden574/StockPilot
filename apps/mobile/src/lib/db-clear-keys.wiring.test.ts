import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CACHE_USER_META_KEY } from './cache-owner';
import { ENABLED_MODULES_META_KEY } from './enabled-modules';
import { EFFECTIVE_PERMISSIONS_META_KEY } from './use-effective-permissions';
import { WAREHOUSE_SCOPE_META_KEY } from './warehouse-scope';

// Both key-owning modules import './db' (expo-sqlite, native) and
// use-effective-permissions also imports './api' (supabase + expo-constants).
// vitest runs in node, so both are mocked wholesale — we only want the
// exported meta-key CONSTANTS, not any runtime behaviour. vi.mock is hoisted
// above the imports by vitest's transform, so declaring it after them keeps
// import order lint-clean (same shape as warehouse-scope.test.ts).
vi.mock('./db', () => ({ getMeta: vi.fn(), setMeta: vi.fn() }));
vi.mock('./api', () => ({ api: vi.fn() }));

/**
 * ORG-SCOPED META MUST BE CLEARED ON AN ORG SWITCH — WIRING PINS.
 *
 * `clearOrgScopedTables` (db.ts) is the single wipe shared by `deleteOrgData`
 * (org switch) and `wipeForSignOut` (sign-out). It dropped the cached data
 * TABLES and two meta keys, but not the other two org-scoped meta keys that
 * sync.ts persists on every pull: `effective_permissions` and
 * `warehouse_scope`. The forced post-switch pull is fire-and-forget, so with
 * no network the previous org's values simply stood: the Items banner read
 * "You're viewing <Org A warehouse> only" under Org B, and the drawer was
 * gated by Org A's permission set. Cosmetic (the API enforces both server
 * side) but false — and it survived app relaunches, because the values are
 * persisted, not in-memory.
 *
 * These are source-level pins because this repo has no SQLite harness in
 * vitest (db.ts loads expo-sqlite at import). Two pins:
 *
 *   1. every meta key sync.ts PERSISTS is a key clearOrgScopedTables CLEARS —
 *      derived from sync.ts itself, so a fifth org-scoped key added later is
 *      caught here rather than shipping as the same bug again;
 *   2. the literals in db.ts are the exported constants, so renaming a key at
 *      its source cannot silently un-pin the wipe.
 *
 * ONE PERSISTED KEY IS KEPT ON PURPOSE: `cache_user_id`, the record of whose
 * cache this is (cache-owner.ts). A pull that finds no record adopts the device
 * as it is, photos included, and deleteOrgData (a workspace switch, the
 * workspace repair, Settings > Offline cache > Clear) keeps the photos, so it
 * keeps the record too. Only the wipes of an account leaving the device, whose
 * callers clear the photos first, forget it (wipeForSignOut, wipeForEviction).
 * Pinned in (3) below; executed end to end in cache-owner.sqlite.test.ts.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const dbSrc = read('./db.ts');
const syncSrc = read('./sync.ts');

/** The code without comments. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** One db.ts function, comments stripped: from its declaration to the next
 *  `}` at column 0. */
function fnBody(declaration: string): string {
  const src = code(dbSrc);
  const start = src.indexOf(declaration);
  expect(start, declaration).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n}\n', start));
}

/** Keys sync.ts persists that a wipe keeps on purpose (see the header). */
const KEPT_BY_THE_WIPE = [CACHE_USER_META_KEY];

/** The body of clearOrgScopedTables — the delete block, comments stripped. */
function clearBody(src: string): string {
  const start = src.indexOf('async function clearOrgScopedTables(');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  // The function body is a single template literal passed to execAsync; the
  // next top-level `}` at column 0 ends it.
  const end = src.indexOf('\n}', open);
  expect(end).toBeGreaterThan(open);
  return src.slice(open, end);
}

/** Resolve `setMeta(X)` arguments in sync.ts to the literal meta key. */
const KEY_BY_CONSTANT: Record<string, string> = {
  CACHE_USER_META_KEY,
  ENABLED_MODULES_META_KEY,
  EFFECTIVE_PERMISSIONS_META_KEY,
  WAREHOUSE_SCOPE_META_KEY,
};

function persistedMetaKeys(src: string): string[] {
  const keys = new Set<string>();
  for (const m of src.matchAll(/setMeta\(\s*(?:'([^']+)'|([A-Z0-9_]+))\s*,/g)) {
    const literal = m[1];
    if (literal) {
      keys.add(literal);
      continue;
    }
    const constant = m[2] as string;
    const resolved = KEY_BY_CONSTANT[constant];
    // A new constant nobody taught this test about is itself a failure — the
    // whole point is that the clear list cannot fall behind sync.ts.
    expect(resolved, `unknown meta-key constant ${constant} in sync.ts`).toBeTruthy();
    keys.add(resolved as string);
  }
  return [...keys];
}

describe('clearOrgScopedTables clears every org-scoped meta key sync.ts persists', () => {
  const body = clearBody(dbSrc);
  const persisted = persistedMetaKeys(syncSrc);

  it('sync.ts persists the five keys we know about (guard on the guard)', () => {
    expect(persisted.sort()).toEqual(
      ['cache_user_id', 'effective_permissions', 'enabled_modules', 'last_synced_at', 'warehouse_scope'].sort(),
    );
  });

  it.each(['last_synced_at', 'enabled_modules', 'effective_permissions', 'warehouse_scope'])(
    'clears %s',
    (key) => {
      expect(body).toContain(`delete from meta where key = '${key}';`);
    },
  );

  it('clears every key sync.ts writes, including any added later, except the record of whose cache it is', () => {
    const missing = persisted.filter(
      (k) =>
        !KEPT_BY_THE_WIPE.includes(k) && !body.includes(`delete from meta where key = '${k}';`),
    );
    expect(missing).toEqual([]);
  });
});

describe('(3) the record of whose cache it is outlives a wipe that keeps the photos', () => {
  // Mutation caught: clearOrgScopedTables, or deleteOrgData on its own,
  // forgetting the record again (B18 review, 2026-10-24).
  it('clearOrgScopedTables, and so deleteOrgData, keeps it', () => {
    const body = clearBody(dbSrc);
    expect(body).not.toContain(CACHE_USER_META_KEY);
    expect(body).not.toContain('CACHE_USER_META_KEY');
    expect(fnBody('export async function deleteOrgData(')).not.toMatch(
      /forgetCacheOwner|cache_user_id|CACHE_USER_META_KEY/,
    );
  });

  it('only the sign-out and the eviction wipes forget it, inside their own transaction', () => {
    expect(fnBody('export async function wipeForSignOut(')).toContain(
      'await forgetCacheOwner(db);',
    );
    expect(fnBody('export async function wipeForEviction(')).toContain(
      'await forgetCacheOwner(db);',
    );
    expect([...code(dbSrc).matchAll(/forgetCacheOwner\(db\)/g)]).toHaveLength(2);
  });

  it('forgetCacheOwner and setCacheOwner use the constant sync.ts reads and stamps', () => {
    expect(fnBody('async function forgetCacheOwner(')).toContain(
      "'delete from meta where key = ?', [CACHE_USER_META_KEY]",
    );
    expect(fnBody('export async function setCacheOwner(')).toMatch(
      /\[\s*CACHE_USER_META_KEY,\s*userId,?\s*\]/,
    );
    expect(code(syncSrc)).toContain('await setMeta(CACHE_USER_META_KEY, liveUserId)');
    expect(code(syncSrc)).toContain('await setCacheOwner(liveUserId);');
  });

  // Mutation caught: any other module writing or deleting the record, which
  // would let a wipe elsewhere leave photos with no owner recorded.
  it('no other phone source reads, writes or deletes it', () => {
    const root = path.resolve(__dirname, '../..');
    const sources = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory())
          return e.name === 'node_modules' || e.name === '__fixtures__' ? [] : sources(rel);
        return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
      });
    const touching = [...sources('src'), ...sources('app')].filter((f) =>
      /cache_user_id|CACHE_USER_META_KEY/.test(code(readFileSync(path.join(root, f), 'utf8'))),
    );
    expect(touching.sort()).toEqual(
      ['src/lib/cache-owner.ts', 'src/lib/db.ts', 'src/lib/sync.ts'].map((f) => path.normalize(f)),
    );
  });
});

describe('the cleared literals are the exported constants', () => {
  const body = clearBody(dbSrc);

  it.each([
    ['enabled_modules', ENABLED_MODULES_META_KEY],
    ['effective_permissions', EFFECTIVE_PERMISSIONS_META_KEY],
    ['warehouse_scope', WAREHOUSE_SCOPE_META_KEY],
  ])('%s is still the constant the reader uses', (literal, constant) => {
    expect(constant).toBe(literal);
    expect(body).toContain(`delete from meta where key = '${constant}';`);
  });
});
