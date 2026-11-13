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
 * migration (a later CREATE OR REPLACE replaces an earlier one):
 *   1. The plan ranks in its `case public.org_effective_tier(...)` are the
 *      order of PLAN_IDS (free is 0, by `else 0`).
 *   2. Its `case p_module` names exactly the registry modules whose minPlan
 *      ranks above free, each at that rank, and nothing else.
 * planCheckDrift is checked on made-up bodies too, so a parse that finds
 * nothing cannot pass for a match.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_REGISTRY, PLAN_IDS } from '@stockpilot/core';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');
const FUNCTION = 'org_can_enable_module';

/** SQL with `--` comments removed, so prose never counts as code. */
const code = (sql: string): string => sql.replace(/--[^\n]*/g, '');

const DEFINES = new RegExp(
  String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?"?${FUNCTION}"?\s*\(`,
  'i',
);

/** The body (between its dollar quotes) of the last migration that defines the function. */
function latestBody(): { file: string; body: string } | null {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = code(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    // A file could define it more than once; the last one in the file wins.
    const re = new RegExp(DEFINES.source, 'gi');
    for (const m of sql.matchAll(re)) {
      const after = sql.slice((m.index ?? 0) + m[0].length);
      const as = /\bas\s+(\$\w*\$)/i.exec(after);
      if (!as) continue;
      const open = as.index + as[0].length;
      const close = after.indexOf(as[1]!, open);
      if (close === -1) continue;
      found = { file, body: after.slice(open, close) };
    }
  }
  return found;
}

/** The `when '<key>' then <n>` arms of the CASE that opens with `head`, and its else value. */
function caseArms(
  body: string,
  head: RegExp,
): { arms: Map<string, number>; elseValue: number | null } | null {
  const at = body.search(head);
  if (at < 0) return null;
  const end = body.slice(at).search(/\bend\b/i);
  if (end < 0) return null;
  const block = body.slice(at, at + end);
  const arms = new Map<string, number>();
  for (const m of block.matchAll(/\bwhen\s+'([^']+)'\s+then\s+(\d+)/gi)) {
    arms.set(m[1]!, Number(m[2]));
  }
  const elseMatch = /\belse\s+(\d+)/i.exec(block);
  return { arms, elseValue: elseMatch ? Number(elseMatch[1]) : null };
}

const PLAN_CASE = /\bcase\s+public\.org_effective_tier\s*\(/i;
const MODULE_CASE = /\bcase\s+p_module\b/i;

type Registry = Record<string, { minPlan?: string }>;

/**
 * Every difference between the function body and the registry, as readable
 * lines; empty when they agree. Plan ranks follow PLAN_IDS order.
 */
function planCheckDrift(body: string, registry: Registry, planIds: readonly string[]): string[] {
  const out: string[] = [];
  const plans = caseArms(body, PLAN_CASE);
  const modules = caseArms(body, MODULE_CASE);
  if (!plans) out.push('no `case public.org_effective_tier(...)` in the body');
  if (!modules) out.push('no `case p_module` in the body');
  if (!plans || !modules) return out;

  if (plans.elseValue !== 0)
    out.push(`plan case: else ${plans.elseValue ?? 'missing'}, want else 0`);
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
    if (sqlRank === undefined)
      out.push(`module ${id}: minPlan rank ${rank} in the registry, no arm in SQL`);
    else if (sqlRank !== rank)
      out.push(`module ${id}: rank ${sqlRank} in SQL, ${rank} in the registry`);
  }
  for (const [id, sqlRank] of modules.arms) {
    if (!expected.has(id)) {
      out.push(`module ${id}: rank ${sqlRank} in SQL, no minPlan above free in the registry`);
    }
  }
  return out;
}

const PLANS = ['free', 'pro', 'business', 'enterprise'] as const;
const sample = (moduleArms: string): string => `
  select coalesce((select all_modules_comp from public.organizations where id = org_id), false)
    or (case public.org_effective_tier(org_id)
          when 'pro' then 1 when 'business' then 2 when 'enterprise' then 3 else 0 end)
    >= (case p_module ${moduleArms} else 0 end);`;

describe('planCheckDrift reads both sides (made-up modules)', () => {
  const registry: Registry = {
    alpha: { minPlan: 'business' },
    beta: { minPlan: 'enterprise' },
    gamma: {},
    delta: { minPlan: 'free' },
  };

  it('agrees when every priced module has its arm', () => {
    expect(
      planCheckDrift(sample(`when 'alpha' then 2 when 'beta' then 3`), registry, PLANS),
    ).toEqual([]);
  });

  it('reports a registry module with no arm', () => {
    expect(planCheckDrift(sample(`when 'beta' then 3`), registry, PLANS)).toEqual([
      'module alpha: minPlan rank 2 in the registry, no arm in SQL',
    ]);
  });

  it('reports an arm for a module the registry does not price', () => {
    expect(
      planCheckDrift(
        sample(`when 'alpha' then 2 when 'beta' then 3 when 'gamma' then 1`),
        registry,
        PLANS,
      ),
    ).toEqual(['module gamma: rank 1 in SQL, no minPlan above free in the registry']);
  });

  it('reports an arm at a different rank', () => {
    expect(
      planCheckDrift(sample(`when 'alpha' then 1 when 'beta' then 3`), registry, PLANS),
    ).toEqual(['module alpha: rank 1 in SQL, 2 in the registry']);
  });

  it('reports a body it cannot read', () => {
    expect(planCheckDrift('select true;', registry, PLANS)).toEqual([
      'no `case public.org_effective_tier(...)` in the body',
      'no `case p_module` in the body',
    ]);
  });
});

describe('the database module plan check matches the module registry', () => {
  const latest = latestBody();

  it('is defined by a migration', () => {
    expect(latest?.file).toBeDefined();
  });

  it('names every module the registry gives a minimum plan, at that plan, and no other', () => {
    expect(latest).not.toBeNull();
    const drift = planCheckDrift(latest!.body, MODULE_REGISTRY as Registry, PLAN_IDS);
    expect(drift, `last definition: ${latest!.file}`).toEqual([]);
  });

  it('the registry prices at least one module (the check is not empty)', () => {
    const priced = Object.values(MODULE_REGISTRY).filter(
      (m) => m.minPlan && PLAN_IDS.indexOf(m.minPlan) > 0,
    );
    expect(priced.length).toBeGreaterThan(0);
  });
});
