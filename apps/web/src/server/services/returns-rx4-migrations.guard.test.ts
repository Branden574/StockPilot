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
 *   5. No pgTAP suite writes returns or return_lines through an API role
 *      unless it puts back, inside its own transaction, the grant 0398
 *      revoked (RX-4 fix round 1, desk checks stock S1 and complete C1: the
 *      0158 suite did, and would have aborted the whole run). The contract
 *      suite itself is the one exception: it proves those writes refused.
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

// ── 5. pgTAP suites under the contract ─────────────────────────────────────
const TESTS_DIR = path.resolve(__dirname, '../../../../../supabase/tests');
const RETURN_WRITE = /\binsert\s+into\s+(?:public\.)?(returns|return_lines)\b|\bupdate\s+(?:public\.)?(returns)\s+set\b/gi;
const API_ROLES = new Set(['authenticated', 'anon']);

/** The text of the call whose `(` is at `open`, up to its matching `)`
 *  (quotes and dollar quotes skipped while counting). */
function callText(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) {
        if (sql[i] === "'") i++;
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = /^\$([a-z_]*)\$/i.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end > 0) {
          i = end + tag[0].length - 1;
          continue;
        }
      }
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return sql.slice(open, i + 1);
  }
  return sql.slice(open);
}

/**
 * Every write of returns or return_lines (an INSERT into either, an UPDATE of
 * returns) a pgTAP file makes as an API role: a statement run while the file's
 * role is authenticated or anon (`set [local] role`, `reset role` and a literal
 * `set_config('role', ...)`, in file order), or the SQL text handed to a
 * pg_temp helper called with the role 'authenticated' or 'anon' (the 0387
 * helpers switch role inside). As "<line>:<insert|update> <table>".
 */
export function apiRoleReturnWrites(raw: string): string[] {
  const sql = raw
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  const lineOf = (at: number) => sql.slice(0, at).split('\n').length;
  const label = (w: RegExpMatchArray) => `${/^insert/i.test(w[0]) ? 'insert' : 'update'} ${w[1] ?? w[2]}`;
  const out: string[] = [];
  const re =
    /\bset\s+(?:local\s+)?role\s+(?:to\s+)?'?(\w+)'?|\breset\s+role\b|set_config\(\s*'role'\s*,\s*'(\w+)'|\binsert\s+into\s+(?:public\.)?(?:returns|return_lines)\b|\bupdate\s+(?:public\.)?returns\s+set\b/gi;
  let role = 'owner';
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    if (/^reset/i.test(m[0])) role = 'owner';
    else if (m[1] ?? m[2]) role = (m[1] ?? m[2])!.toLowerCase();
    else if (API_ROLES.has(role)) {
      const w = [...m[0].matchAll(RETURN_WRITE)][0]!;
      out.push(`${lineOf(m.index)}:${label(w)}`);
    }
  }
  const helper = /pg_temp\.\w+\(\s*'(authenticated|anon)'/gi;
  for (let m = helper.exec(sql); m; m = helper.exec(sql)) {
    for (const w of callText(sql, sql.indexOf('(', m.index)).matchAll(RETURN_WRITE)) out.push(`${lineOf(m.index)}:${label(w)}`);
  }
  return [...new Set(out)];
}

/** The grants a suite must put back (inside its transaction) for its API-role writes. */
const PREAMBLE_INSERT = /^grant\s+insert\s+on\s+public\.returns\s*,\s*public\.return_lines\s+to\s+authenticated\s*;/im;
const PREAMBLE_UPDATE =
  /^grant\s+update\s*\(\s*status\s*,\s*approved_by\s*,\s*approved_at\s*,\s*received_by\s*,\s*received_at\s*,\s*denied_by\s*,\s*denied_at\s*,\s*denial_reason\s*\)\s+on\s+public\.returns\s+to\s+authenticated\s*;/im;

describe('pgTAP suites under the returns contract (0398)', () => {
  const suites = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.sql'));
  const contractSuite = /^\d{4}_returns_contract\.test\.sql$/;

  it('scans the real suites (the contract suite and RX-1\'s are there)', () => {
    expect(suites.length).toBeGreaterThan(100);
    expect(suites.some((f) => contractSuite.test(f))).toBe(true);
    expect(suites).toContain('0158_returns_invariants.test.sql');
  });

  it('finds the API-role writes it is meant to judge (the scan is not empty)', () => {
    const rx1 = suites.find((f) => /^\d{4}_returns_lifecycle_original_rack\.test\.sql$/.test(f))!;
    expect(apiRoleReturnWrites(readFileSync(path.join(TESTS_DIR, rx1), 'utf8')).length).toBeGreaterThan(5);
  });

  it('no suite but the contract suite writes the return tables as an API role without putting the revoked grant back', () => {
    const bad: string[] = [];
    for (const f of suites) {
      if (contractSuite.test(f)) continue;
      const raw = readFileSync(path.join(TESTS_DIR, f), 'utf8');
      const sql = raw
        .split('\n')
        .map((l) => l.replace(/--.*$/, ''))
        .join('\n');
      for (const w of apiRoleReturnWrites(raw)) {
        const needs = / insert /.test(` ${w.split(':')[1]} `) ? PREAMBLE_INSERT : PREAMBLE_UPDATE;
        if (!needs.test(sql)) bad.push(`${f}:${w}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the scanner follows the role and the helpers (its own control)', () => {
    const planted = [
      "set local role to 'authenticated';",
      "insert into public.returns (id) values ('x');",
      'reset role;',
      "insert into public.return_lines (id) values ('y');",
      "set local role authenticated;",
      "update public.returns set status = 'closed';",
      'reset role;',
      "select pg_temp.attempt('anon', null, $q$insert into public.return_lines (id) values ('z')$q$);",
      "select pg_temp.attempt('postgres', null, $q$insert into public.returns (id) values ('w')$q$);",
    ].join('\n');
    expect(apiRoleReturnWrites(planted)).toEqual(['2:insert returns', '6:update returns', '8:insert return_lines']);
  });
});
