/**
 * MIGRATION GUARDS for returns RX-4 (0397 the follow-ups, 0398 the contract;
 * numbers renumbered at push time, so each file is found by its suffix).
 *
 *   1. Both files set lock_timeout first and reset it at the end, and write
 *      no data: no INSERT, UPDATE or DELETE outside a function body.
 *   2. 0397 restates two 0396 bodies by ADDING lines only: each restated body
 *      minus its `-- RX-4` lines is 0396's body, character for character
 *      (pgTAP A2 proves the same on the database by md5).
 *   3. 0397 takes its only table lock in the NOWAIT prelude (return_decisions)
 *      and never creates or alters a policy (supautils would then lock every
 *      policy_grants table at push time).
 *   4. 0398 changes no function, policy or trigger: it only revokes, and it
 *      revokes exactly INSERT on both tables and the eight returns columns.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../supabase/migrations');
const read = (suffix: RegExp): { file: string | undefined; sql: string } => {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => suffix.test(f));
  return { file, sql: file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : '' };
};
const followups = read(/^\d{4}_returns_followups\.sql$/);
const contract = read(/^\d{4}_returns_contract\.sql$/);
const rx2 = read(/^\d{4}_returns_exchange_staff\.sql$/);

const code = (s: string): string => s.replace(/--[^\n]*/g, '');

/** The text between the dollar quotes of `create [or replace] function <name>(`. */
function body(sql: string, name: string): string {
  const at = sql.search(new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i'));
  if (at < 0) return '';
  const open = sql.indexOf('as $$', at);
  if (open < 0) return '';
  const start = open + 'as $$'.length;
  return sql.slice(start, sql.indexOf('$$', start));
}

describe.each([
  ['0397 (the follow-ups)', followups],
  ['0398 (the contract)', contract],
])('the RX-4 migration %s', (_label, m) => {
  it('exists', () => {
    expect(m.file).toBeDefined();
  });

  it('sets lock_timeout first and resets it last', () => {
    const c = code(m.sql).trim();
    expect(c.split(';')[0]!.trim()).toMatch(/^set\s+lock_timeout\s*=\s*'5s'$/i);
    expect(c).toMatch(/reset\s+lock_timeout\s*;\s*$/i);
  });

  it('writes no data outside function bodies', () => {
    const outside = code(m.sql).replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, '');
    expect(outside).not.toMatch(/^\s*(insert\s+into|update\s+\w|delete\s+from|truncate)\b/gim);
  });
});

describe('0397 restates 0396 bodies by adding lines only', () => {
  it.each(['public._return_exchange_create', 'public.return_exchange_options'])('%s minus its RX-4 lines is 0396\'s', (name) => {
    const restated = body(followups.sql, name);
    const original = body(rx2.sql, name);
    expect(restated).not.toBe('');
    expect(original).not.toBe('');
    expect(restated).toMatch(/-- RX-4/);
    expect(restated.replace(/\n[^\n]*-- RX-4[^\n]*/g, '')).toBe(original);
  });

  it('takes its only table lock in the prelude and touches no policy', () => {
    const c = code(followups.sql);
    const locks = [...c.matchAll(/lock\s+table\s+(only\s+)?([\w.]+)/gi)].map((x) => x[2]);
    expect(locks).toEqual(['public.return_decisions']);
    expect(c).not.toMatch(/\b(create|alter|drop)\s+policy\b/i);
    const alters = [...c.matchAll(/alter\s+table\s+(only\s+)?([\w.]+)/gi)].map((x) => x[2]);
    expect(alters).toEqual(['public.return_decisions']);
    // The prelude comes before the ALTER TABLE.
    expect(c.search(/do\s+\$lock\$/i)).toBeLessThan(c.search(/alter\s+table/i));
  });
});

describe('0398 only revokes', () => {
  const c = code(contract.sql).replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, '');

  it('creates or replaces no function, policy, trigger or table, and grants nothing', () => {
    expect(c).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(function|policy|trigger|table|view|index)\b/i);
    expect(c).not.toMatch(/\b(alter|drop)\s+(function|policy|trigger|table|view)\b/i);
    expect(c).not.toMatch(/^\s*grant\b/im);
  });

  it('revokes exactly INSERT on both return tables and UPDATE on the eight returns columns, from authenticated', () => {
    const revokes = [...c.matchAll(/revoke\s+([\s\S]*?);/gi)].map((x) => x[1]!.replace(/\s+/g, ' ').trim());
    expect(revokes).toEqual([
      'insert on public.returns, public.return_lines from authenticated',
      'update (status, approved_by, approved_at, received_by, received_at, denied_by, denied_at, denial_reason) on public.returns from authenticated',
    ]);
  });
});
