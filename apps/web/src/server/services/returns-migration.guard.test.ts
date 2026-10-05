/**
 * MIGRATION GUARDS for returns RX-1 (0395, renumbered at push time; found by
 * its suffix).
 *
 *   1. ledger.return_line_sources classifies an original location with the
 *      SAME lists the app uses for "a rack" (core isRackShelfLocation:
 *      PLACEMENT_KINDS by kind or PLACEMENT_TYPES by type, never a system
 *      bucket). If they drift, the workbench and the close disagree about
 *      which racks may be offered (plan 3.5.2 rule 4, decision D12).
 *   2. The resolver never reads bin_location, primary_location_id or the
 *      custom_fields rack keys (brief 11, 13, 39; pgTAP H4 is the database
 *      twin).
 *   3. The file sets lock_timeout first and resets it at the end, and writes
 *      no data: no INSERT, UPDATE or DELETE outside a function body (plan:
 *      "no data written"; the data-safety script proves it on the stack).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLACEMENT_KINDS, PLACEMENT_TYPES, SYSTEM_KINDS } from '@stockpilot/core';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../supabase/migrations');
const file = readdirSync(MIGRATIONS_DIR).find((f) => /^\d{4}_returns_lifecycle_original_rack\.sql$/.test(f));
const sql = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : '';
const code = (s: string): string => s.replace(/--[^\n]*/g, '');

/** The body of one `create function <name>(` ... `$$;`. */
function body(name: string): string {
  const c = code(sql);
  const at = c.search(new RegExp(`create\\s+function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i'));
  if (at < 0) return '';
  const open = c.indexOf('$$', at);
  return c.slice(open, c.indexOf('$$', open + 2));
}

const listValues = (inner: string): string[] => [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();

describe('the RX-1 migration', () => {
  it('exists', () => {
    expect(file).toBeDefined();
  });

  const sources = body('ledger.return_line_sources');

  it('classifies a placement exactly as core isRackShelfLocation does', () => {
    const block = sources.slice(sources.indexOf('v_problem := case'), sources.indexOf('end;', sources.indexOf('v_problem := case')));
    expect(block).not.toBe('');
    const excluded = [...block.matchAll(/s\.l_kind\s+is\s+distinct\s+from\s+'([^']+)'/gi)].map((m) => m[1]!).sort();
    expect(excluded).toEqual([...SYSTEM_KINDS].sort());
    const kinds = block.match(/s\.l_kind\s+in\s*\(([^)]*)\)/i);
    const types = block.match(/s\.l_type\s+in\s*\(([^)]*)\)/i);
    expect(listValues(kinds![1]!)).toEqual([...PLACEMENT_KINDS].sort());
    expect(listValues(types![1]!)).toEqual([...PLACEMENT_TYPES].sort());
  });

  it('the Original rack helpers never read a free-text rack', () => {
    for (const name of ['ledger.return_line_sources', 'ledger.return_line_plans_original', 'ledger.return_line_restock_legs', 'ledger.return_restock_original']) {
      const b = body(name);
      expect(b, name).not.toBe('');
      expect(b, name).not.toMatch(/bin_location|primary_location_id|custom_fields/);
    }
  });

  it('sets lock_timeout first and resets it last', () => {
    const c = code(sql).trim();
    const first = c.split(';')[0]!.trim();
    expect(first).toMatch(/^set\s+lock_timeout\s*=\s*'5s'$/i);
    expect(c).toMatch(/reset\s+lock_timeout\s*;\s*$/i);
  });

  it('writes no data outside function bodies', () => {
    // Drop every dollar-quoted body; what is left is DDL, grants and policies.
    const outside = code(sql).replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, '');
    expect(outside).not.toMatch(/^\s*(insert\s+into|update\s+\w|delete\s+from|truncate)\b/gim);
  });
});
