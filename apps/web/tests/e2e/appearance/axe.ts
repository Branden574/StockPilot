import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

/**
 * axe-core for the stage 5 accessibility run (plan 8.3-1: "axe-core on every
 * route in Dark, Light, Day glass and Night glass").
 *
 * @axe-core/playwright is not in the pnpm store (no network installs), so the
 * engine comes from the `axe-core` package itself (a direct devDependency of
 * apps/web at 4.13.0, already in the store through eslint-plugin-jsx-a11y): its
 * axe.min.js is injected with page.addScriptTag and `axe.run` is called in the
 * page, which is all @axe-core/playwright does for a single frame.
 *
 * The verdict rule (pure, unit tested in src/test/stage5-axe.test.ts):
 *  - Liquid Glass adds no violation Classic of the same theme does not have on
 *    the same route (same rule, same node), so a glass change can never ship
 *    a new axe failure;
 *  - and, separately, every look is held to no "serious" or "critical"
 *    violation at all, Classic included: a Classic one is a pre-existing
 *    defect the run REPORTS (classic is not changed by this work) and the
 *    glass one fails.
 */

export interface AxeNode {
  target: string[];
  html?: string;
}
export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: AxeNode[];
}

/** One violation on one node: the unit the comparison counts. */
export interface Finding {
  rule: string;
  impact: string;
  target: string;
}

/** WCAG 2.0/2.1/2.2 A and AA plus best practice, as the plan asks for AA. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Resolved from apps/web (Playwright and vitest both run there), whatever the module format. */
const requireHere = createRequire(join(process.cwd(), 'package.json'));

/** The axe-core source, read once. */
let axeSource: string | null = null;
function source(): string {
  axeSource ??= readFileSync(requireHere.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

/** Runs axe on the page as it is now (the whole document, every rule of AXE_TAGS). */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  const loaded = await page.evaluate(() => typeof (window as { axe?: unknown }).axe === 'object');
  if (!loaded) await page.addScriptTag({ content: source() });
  return page.evaluate(async (tags) => {
    const axe = (
      window as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations'],
    });
    return result.violations as never;
  }, AXE_TAGS);
}

/** Flattens violations to one finding per node, sorted, with no HTML (no record data leaves the page). */
export function findings(violations: readonly AxeViolation[]): Finding[] {
  const out: Finding[] = [];
  for (const v of violations) {
    for (const node of v.nodes) {
      out.push({ rule: v.id, impact: v.impact ?? 'unknown', target: node.target.join(' >> ') });
    }
  }
  return out.sort((a, b) =>
    a.rule === b.rule ? a.target.localeCompare(b.target) : a.rule.localeCompare(b.rule),
  );
}

const key = (f: Finding) => `${f.rule}|${f.target}`;

/** Findings in `glass` that `classic` (same route, same theme) does not have. */
export function addedByGlass(classic: readonly Finding[], glass: readonly Finding[]): Finding[] {
  const had = new Set(classic.map(key));
  return glass.filter((f) => !had.has(key(f)));
}

/** Rules where only the rule (not the node) is compared: glass restyles nodes, so their selectors move. */
export function addedRules(classic: readonly Finding[], glass: readonly Finding[]): string[] {
  const had = new Set(classic.map((f) => f.rule));
  return [...new Set(glass.filter((f) => !had.has(f.rule)).map((f) => f.rule))].sort();
}

/** Findings of impact serious or critical. */
export function severe(list: readonly Finding[]): Finding[] {
  return list.filter((f) => f.impact === 'serious' || f.impact === 'critical');
}
