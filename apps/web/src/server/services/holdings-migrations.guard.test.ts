/**
 * MIGRATION GUARDS for the holdings scope (0371).
 *
 *   1. item_holdings_elsewhere's `placed_rack_locations` classifies a hidden
 *      placed location with the SAME kind/type lists the app classifies a
 *      visible one with (isRackShelfLocation, lib/locations/groups.ts). Bulk
 *      Set rack's split rule adds the two together, so if the lists drift the
 *      rule decides from two different definitions of "a rack": a Site on one
 *      side and not the other turned a single rack holding into a "split"
 *      that was never moved (review finding, 2026-09-25).
 *
 *   2. A migration that takes ACCESS EXCLUSIVE on item_stock_levels (a policy
 *      change, an ALTER TABLE) sets lock_timeout first and resets it at the
 *      end. Without it `supabase db push` queues behind any open transaction
 *      that read the table, and every API read and stock write queues behind
 *      the push until the 8 s statement_timeout fails them (0370's PROD PUSH
 *      NOTE; 0371 shipped without it and a review caught it).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLACEMENT_KINDS, PLACEMENT_TYPES, SYSTEM_KINDS } from '@/lib/locations/groups';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../supabase/migrations');

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') }));

/** SQL with `--` comments removed, so prose never counts as a statement. */
const code = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/** The quoted values of an `in ('a', 'b')` list, sorted. */
const listValues = (inner: string): string[] =>
  [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();

describe('item_holdings_elsewhere classifies a hidden placement like a visible one', () => {
  const defining = migrations.filter(({ sql }) =>
    /create\s+(or\s+replace\s+)?function\s+public\.item_holdings_elsewhere\s*\(/i.test(code(sql)),
  );
  const latest = defining.at(-1);

  it('is defined by a migration', () => {
    expect(latest?.file).toBeDefined();
  });

  const body = (() => {
    if (!latest) return '';
    const sql = code(latest.sql);
    const at = sql.search(
      /create\s+(or\s+replace\s+)?function\s+public\.item_holdings_elsewhere\s*\(/i,
    );
    const open = sql.indexOf('$$', at);
    return sql.slice(open, sql.indexOf('$$', open + 2));
  })();
  // The count expression: from its `count(distinct` to the column's cast.
  const count = (() => {
    const at = body.search(/count\s*\(\s*distinct\s+s\.location_id\s*\)/i);
    return at < 0 ? '' : body.slice(at, body.indexOf('::integer', at));
  })();

  it('counts distinct placed locations, excluding both system buckets', () => {
    expect(count).not.toBe('');
    const excluded = [...count.matchAll(/l\.kind\s+is\s+distinct\s+from\s+'([^']+)'/gi)]
      .map((m) => m[1]!)
      .sort();
    expect(excluded).toEqual([...SYSTEM_KINDS].sort());
  });

  it('a placement is exactly PLACEMENT_KINDS by kind or PLACEMENT_TYPES by type (groups.ts)', () => {
    const kinds = count.match(/l\.kind\s+in\s*\(([^)]*)\)/i);
    const types = count.match(/l\.type\s+in\s*\(([^)]*)\)/i);
    expect(kinds, 'the kind list').not.toBeNull();
    expect(types, 'the type list').not.toBeNull();
    expect(listValues(kinds![1]!)).toEqual([...PLACEMENT_KINDS].sort());
    expect(listValues(types![1]!)).toEqual([...PLACEMENT_TYPES].sort());
  });
});

describe('a migration that locks item_stock_levels sets lock_timeout', () => {
  // From 0370 on: the first migration that set it for this table. Earlier
  // files are history and are not edited.
  const LOCKING =
    /\b(drop|create|alter)\s+policy\s+[a-z_"]+\s+on\s+(public\.)?item_stock_levels\b|\balter\s+table\s+(if\s+exists\s+)?(public\.)?item_stock_levels\b/i;

  const checked = migrations.filter(({ file, sql }) => file >= '0370' && LOCKING.test(code(sql)));

  it('covers 0370 and 0371 (the check is not vacuous)', () => {
    const files = checked.map((m) => m.file.slice(0, 4));
    expect(files).toEqual(expect.arrayContaining(['0370', '0371']));
  });

  it.each(checked.map((m) => [m.file, m.sql] as const))(
    '%s: lock_timeout is set before the first locking statement and reset at the end',
    (_file, sql) => {
      const body = code(sql);
      const set = body.search(/^\s*set\s+lock_timeout\s*=\s*'[^']+'\s*;/im);
      const firstLock = body.search(LOCKING);
      expect(set, 'a top-level `set lock_timeout = ...;`').toBeGreaterThan(-1);
      expect(set).toBeLessThan(firstLock);
      expect(body.trimEnd()).toMatch(/reset\s+lock_timeout\s*;$/i);
    },
  );
});
