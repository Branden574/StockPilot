import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const dbSrc = read('./db.ts');
const syncSrc = read('./sync.ts');

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

  it('sync.ts persists the four keys we know about (guard on the guard)', () => {
    expect(persisted.sort()).toEqual(
      ['effective_permissions', 'enabled_modules', 'last_synced_at', 'warehouse_scope'].sort(),
    );
  });

  it.each(['last_synced_at', 'enabled_modules', 'effective_permissions', 'warehouse_scope'])(
    'clears %s',
    (key) => {
      expect(body).toContain(`delete from meta where key = '${key}';`);
    },
  );

  it('clears every key sync.ts writes, including any added later', () => {
    const missing = persisted.filter(
      (k) => !body.includes(`delete from meta where key = '${k}';`),
    );
    expect(missing).toEqual([]);
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
