/**
 * PARITY GUARD: the database's module plan check and the module registry
 * name the same minimum plans.
 *
 * Turning a module on is decided in two places. The app's switch
 * (setModuleEnabledAction) reads `minPlan` from MODULE_REGISTRY
 * (packages/core/src/modules/registry.ts). Row level security on
 * organization_modules (org_modules_admin_insert / _update) asks
 * public.org_can_enable_module, which keeps its own copy of the list: a CASE
 * on the module key giving each one its plan rank, `else 0` for the rest. A
 * module that the registry prices but the CASE leaves out is therefore open
 * on every plan at the database, and a CASE arm the registry no longer has
 * holds a plan the app does not ask for.
 *
 * What this file checks, on the function's LAST definition across every
 * migration the CLI applies (MIGRATION_FILE, in version order; a later
 * CREATE OR REPLACE replaces an earlier one):
 *   1. The plan ranks in its `case public.org_effective_tier(...)` are the
 *      order of PLAN_IDS (free is 0, by `else 0`).
 *   2. Its `case p_module` names exactly the registry modules whose minPlan
 *      ranks above free, each at that rank, once, and nothing else.
 * A last definition whose body this file cannot read (not dollar-quoted:
 * BEGIN ATOMIC, a quoted string) fails; it never falls back to an older
 * one. Comments (`--` and `/* ... *\/`) are removed before anything is read.
 * The helpers are checked on made-up migrations too, so a parse that finds
 * nothing cannot pass for a match.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_REGISTRY, PLAN_IDS } from '@stockpilot/core';

import { MIGRATION_FILE } from './migration-grants';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');
const FUNCTION = 'org_can_enable_module';

/**
 * SQL with comments removed (`--` to the end of the line, and `/* ... *\/`,
 * nested as Postgres nests them), so prose never counts as code. A quoted
 * string is kept as it is.
 */
function code(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (sql.startsWith('/*', i)) {
      let depth = 0;
      while (i < sql.length) {
        if (sql.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      out += ' ';
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out;
}

const DEFINES = new RegExp(
  String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?"?${FUNCTION}"?\s*\(`,
  'gi',
);

interface MigrationText {
  file: string;
  text: string;
}

/** The last definition of the function: its file, and its body (null when it cannot be read). */
interface Definition {
  file: string;
  body: string | null;
}

/** The migrations the CLI applies, in the order it applies them. */
function applied(files: MigrationText[]): MigrationText[] {
  const version = (file: string): bigint => BigInt(MIGRATION_FILE.exec(file)![1]!);
  return files
    .filter(({ file }) => MIGRATION_FILE.test(file))
    .sort((a, b) => {
      const va = version(a.file);
      const vb = version(b.file);
      if (va !== vb) return va < vb ? -1 : 1;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    });
}

/** The last definition of the function across the migrations. */
function latestDefinition(files: MigrationText[]): Definition | null {
  let found: Definition | null = null;
  for (const { file, text } of applied(files)) {
    const sql = code(text);
    for (const m of sql.matchAll(DEFINES)) {
      const after = sql.slice((m.index ?? 0) + m[0].length);
      // The body starts where the header ends: `AS $tag$` is read; a quoted
      // string, BEGIN ATOMIC or the end of the statement is a body this guard
      // cannot read, and it still counts as the newest definition.
      const start = /\bas\s+(\$\w*\$)|\bas\s+[eE]?'|\bbegin\s+atomic\b|;/i.exec(after);
      const tag = start?.[1];
      const open = start && tag ? start.index + start[0].length : -1;
      const close = tag ? after.indexOf(tag, open) : -1;
      found = { file, body: tag && close !== -1 ? after.slice(open, close) : null };
    }
  }
  return found;
}

/** The `when '<key>' then <n>` arms of the CASE that opens with `head`, and its else value. */
function caseArms(
  body: string,
  head: RegExp,
): { arms: Map<string, number>; duplicates: string[]; elseValue: number | null } | null {
  const at = body.search(head);
  if (at < 0) return null;
  const end = body.slice(at).search(/\bend\b/i);
  if (end < 0) return null;
  const block = body.slice(at, at + end);
  const arms = new Map<string, number>();
  const duplicates: string[] = [];
  for (const m of block.matchAll(/\bwhen\s+'([^']+)'\s+then\s+(\d+)/gi)) {
    // Postgres takes the first arm that matches; a second one is reported.
    if (arms.has(m[1]!)) duplicates.push(m[1]!);
    else arms.set(m[1]!, Number(m[2]));
  }
  const elseMatch = /\belse\s+(\d+)/i.exec(block);
  return { arms, duplicates, elseValue: elseMatch ? Number(elseMatch[1]) : null };
}

const PLAN_CASE = /\bcase\s+public\.org_effective_tier\s*\(/i;
const MODULE_CASE = /\bcase\s+p_module\b/i;

type Registry = Record<string, { minPlan?: string }>;

/**
 * Every difference between the function body and the registry, as readable
 * lines; empty when they agree. Plan ranks follow PLAN_IDS order.
 */
function planCheckDrift(raw: string, registry: Registry, planIds: readonly string[]): string[] {
  const out: string[] = [];
  const body = code(raw);
  const plans = caseArms(body, PLAN_CASE);
  const modules = caseArms(body, MODULE_CASE);
  if (!plans) out.push('no `case public.org_effective_tier(...)` in the body');
  if (!modules) out.push('no `case p_module` in the body');
  if (!plans || !modules) return out;

  for (const key of plans.duplicates) out.push(`plan case names ${key} more than once`);
  for (const key of modules.duplicates) out.push(`module case names ${key} more than once`);
  if (plans.elseValue !== 0) {
    out.push(`plan case: else ${plans.elseValue ?? 'missing'}, want else 0`);
  }
  if (modules.elseValue !== 0) {
    out.push(`module case: else ${modules.elseValue ?? 'missing'}, want else 0`);
  }
  planIds.forEach((plan, rank) => {
    const sqlRank = plans.arms.get(plan) ?? plans.elseValue;
    if (sqlRank !== rank) out.push(`plan ${plan}: rank ${sqlRank} in SQL, ${rank} by PLAN_IDS`);
  });
  for (const key of plans.arms.keys()) {
    if (!planIds.includes(key)) out.push(`plan case names ${key}, which PLAN_IDS does not`);
  }

  const expected = new Map<string, number>();
  for (const [id, def] of Object.entries(registry)) {
    if (!def.minPlan) continue;
    const rank = planIds.indexOf(def.minPlan);
    if (rank < 0) out.push(`module ${id}: minPlan ${def.minPlan} is not in PLAN_IDS`);
    else if (rank > 0) expected.set(id, rank);
  }
  for (const [id, rank] of expected) {
    const sqlRank = modules.arms.get(id);
    if (sqlRank === undefined) {
      out.push(`module ${id}: minPlan rank ${rank} in the registry, no arm in SQL`);
    } else if (sqlRank !== rank) {
      out.push(`module ${id}: rank ${sqlRank} in SQL, ${rank} in the registry`);
    }
  }
  for (const [id, sqlRank] of modules.arms) {
    if (!expected.has(id)) {
      out.push(`module ${id}: rank ${sqlRank} in SQL, no minPlan above free in the registry`);
    }
  }
  return out;
}

/** planCheckDrift on the last definition; a definition it cannot read is a difference. */
function definitionDrift(
  def: Definition | null,
  registry: Registry,
  planIds: readonly string[],
): string[] {
  if (!def) return [`no migration defines ${FUNCTION}`];
  if (def.body === null) {
    return [`${def.file}: the last definition of ${FUNCTION} has a body this guard cannot read`];
  }
  return planCheckDrift(def.body, registry, planIds);
}

// ── made-up migrations ──────────────────────────────────────────────────────

const PLANS = ['free', 'pro', 'business', 'enterprise'] as const;
const registry: Registry = {
  alpha: { minPlan: 'business' },
  beta: { minPlan: 'enterprise' },
  gamma: {},
  delta: { minPlan: 'free' },
};
const sample = (moduleArms: string): string => `
  select coalesce((select all_modules_comp from public.organizations where id = org_id), false)
    or (case public.org_effective_tier(org_id)
          when 'pro' then 1 when 'business' then 2 when 'enterprise' then 3 else 0 end)
    >= (case p_module ${moduleArms} else 0 end);`;
const GOOD = `when 'alpha' then 2 when 'beta' then 3`;
const migration = (body: string): string => `
create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$${body}$$;
`;
/** Each made-up file set's drift, through the same path the real check takes. */
const driftOf = (files: MigrationText[]): string[] =>
  definitionDrift(latestDefinition(files), registry, PLANS);

describe('planCheckDrift reads both sides (made-up modules)', () => {
  it('agrees when every priced module has its arm', () => {
    expect(planCheckDrift(sample(GOOD), registry, PLANS)).toEqual([]);
  });

  it('reports a registry module with no arm', () => {
    expect(planCheckDrift(sample(`when 'beta' then 3`), registry, PLANS)).toEqual([
      'module alpha: minPlan rank 2 in the registry, no arm in SQL',
    ]);
  });

  it('reports an arm for a module the registry does not price', () => {
    expect(planCheckDrift(sample(`${GOOD} when 'gamma' then 1`), registry, PLANS)).toEqual([
      'module gamma: rank 1 in SQL, no minPlan above free in the registry',
    ]);
  });

  it('reports an arm at a different rank', () => {
    expect(
      planCheckDrift(sample(`when 'alpha' then 1 when 'beta' then 3`), registry, PLANS),
    ).toEqual(['module alpha: rank 1 in SQL, 2 in the registry']);
  });

  it('reports a module named twice (Postgres takes the first arm)', () => {
    expect(planCheckDrift(sample(`when 'alpha' then 1 ${GOOD}`), registry, PLANS)).toEqual([
      'module case names alpha more than once',
      'module alpha: rank 1 in SQL, 2 in the registry',
    ]);
  });

  it('does not read an arm inside a block comment', () => {
    expect(
      planCheckDrift(sample(`/* when 'alpha' then 2 */ when 'beta' then 3`), registry, PLANS),
    ).toEqual(['module alpha: minPlan rank 2 in the registry, no arm in SQL']);
  });

  it('reports a body with neither CASE', () => {
    expect(planCheckDrift('select true;', registry, PLANS)).toEqual([
      'no `case public.org_effective_tier(...)` in the body',
      'no `case p_module` in the body',
    ]);
  });
});

describe('the last definition is the one read (made-up migrations)', () => {
  it('reads the newest file that defines the function', () => {
    expect(
      driftOf([
        { file: '0002_newer.sql', text: migration(sample(GOOD)) },
        { file: '0001_older.sql', text: migration(sample(`when 'beta' then 3`)) },
      ]),
    ).toEqual([]);
  });

  it('reads a timestamp-named file after a four-digit one', () => {
    expect(
      driftOf([
        { file: '0001_older.sql', text: migration(sample(GOOD)) },
        { file: '20991231000000_newer.sql', text: migration(sample(`when 'beta' then 3`)) },
      ]),
    ).toEqual(['module alpha: minPlan rank 2 in the registry, no arm in SQL']);
  });

  it('skips a file the CLI does not apply', () => {
    expect(
      driftOf([
        { file: '0001_older.sql', text: migration(sample(GOOD)) },
        { file: 'notes_newer.sql', text: migration(sample(`when 'beta' then 3`)) },
      ]),
    ).toEqual([]);
  });

  it('fails on a newest definition with a BEGIN ATOMIC body', () => {
    const atomic = `
create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean language sql stable security definer set search_path = public
begin atomic
  select true;
end;
select $$ unrelated $$;`;
    expect(
      driftOf([
        { file: '0001_older.sql', text: migration(sample(GOOD)) },
        { file: '0002_newer.sql', text: atomic },
      ]),
    ).toEqual([
      `0002_newer.sql: the last definition of ${FUNCTION} has a body this guard cannot read`,
    ]);
  });

  it('fails on a newest definition with a single-quoted body', () => {
    const quoted = `
create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean language sql stable security definer set search_path = public
as 'select true';`;
    expect(
      driftOf([
        { file: '0001_older.sql', text: migration(sample(GOOD)) },
        { file: '0002_newer.sql', text: quoted },
      ]),
    ).toEqual([
      `0002_newer.sql: the last definition of ${FUNCTION} has a body this guard cannot read`,
    ]);
  });

  it('does not count a definition inside a block comment', () => {
    expect(
      driftOf([
        { file: '0001_older.sql', text: migration(sample(GOOD)) },
        { file: '0002_newer.sql', text: `/* ${migration(sample(`when 'beta' then 3`))} */` },
      ]),
    ).toEqual([]);
  });
});

describe('the database module plan check matches the module registry', () => {
  const files = readdirSync(MIGRATIONS_DIR).map((file) => ({
    file,
    text: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
  }));
  const latest = latestDefinition(files);

  it('names every module the registry gives a minimum plan, at that plan, once, and no other', () => {
    const drift = definitionDrift(latest, MODULE_REGISTRY as Registry, PLAN_IDS);
    expect(drift, `last definition: ${latest?.file}`).toEqual([]);
  });

  it('the registry prices at least one module (the check is not empty)', () => {
    const priced = Object.values(MODULE_REGISTRY).filter(
      (m) => m.minPlan && PLAN_IDS.indexOf(m.minPlan) > 0,
    );
    expect(priced.length).toBeGreaterThan(0);
  });
});
