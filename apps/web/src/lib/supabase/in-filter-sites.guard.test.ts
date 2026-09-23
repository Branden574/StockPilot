import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyInFilterSites, mayHoldInFilter } from '@/test/in-filter-sites';

/**
 * No new unbounded `.in()` list goes into a request URL.
 *
 * supabase-js puts every `.in(column, values)` value into the URL. Past about
 * 215 uuids the local gateway answers 414; past about 395 production fails as
 * a bare "fetch failed" (PostgREST echoes the path in Content-Location, which
 * overflows undici's 16 KB header limit) after ~7 s of retries. Where a
 * caller ignored `error`, that became a silent wrong answer: the storefront
 * showed a 401-item warehouse's reserved stock as available (PR #236).
 *
 * Every `.in()` / `.notIn()`, `.filter(col, 'in', …)` / `.not(col, 'in', …)`
 * and `in.(…` filter string (template, `+` or array join) in `src` must be
 * one of (the full rules are in `@/test/in-filter-sites`):
 *   - a list of literals, or built from a SCREAMING_CASE constant;
 *   - the `batch` parameter of a callback passed straight to
 *     fetchAllRowsByIds / mapIdBatches / writeInIdBatches
 *     (server/services/lib/fetch-by-ids.ts), or the loop variable of
 *     `for (const batch of chunkInFilterValues(…))` (lib/supabase/in-filter.ts);
 *   - annotated `// in-list-bound: <why it stays under 100 values>`;
 *   - or already recorded in in-filter-sites.baseline.json, which only ever
 *     shrinks. A new site fails here; a baseline entry that no longer exists
 *     fails too, so the baseline is a ratchet.
 *
 * Sites are matched by fingerprint (`in:<column> <- <values>`), not by line or
 * count, so swapping one site for another in the same file is still caught.
 * `UPDATE_IN_FILTER_BASELINE=1 npx vitest run <this file>` rewrites the
 * baseline; lower it, never raise it without a reason in review.
 */

const SRC = path.resolve(__dirname, '../..');
const BASELINE = path.join(__dirname, 'in-filter-sites.baseline.json');

type Baseline = Record<string, string[]>;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'test' || entry === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.test\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function currentSites(): { counted: Baseline; lines: Map<string, number[]> } {
  const counted: Baseline = {};
  const lines = new Map<string, number[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!mayHoldInFilter(text)) continue;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const site of classifyInFilterSites(file, text)) {
      if (site.exempt !== null) continue;
      (counted[rel] ??= []).push(site.fingerprint);
      const key = `${rel}\u0000${site.fingerprint}`;
      lines.set(key, [...(lines.get(key) ?? []), site.line]);
    }
  }
  for (const list of Object.values(counted)) list.sort();
  return { counted, lines };
}

/** a minus b, as multisets. */
function minus(a: string[], b: string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const x of a) {
    const i = left.indexOf(x);
    if (i === -1) out.push(x);
    else left.splice(i, 1);
  }
  return out;
}

describe('in-filter sites', () => {
  it('scans real source (the check would pass vacuously otherwise)', () => {
    expect(existsSync(path.join(SRC, 'server/services/lib/fetch-by-ids.ts'))).toBe(true);
    expect(sourceFiles(SRC).length).toBeGreaterThan(500);
  });

  it('adds no unbounded .in() list beyond the baseline, and the baseline has no stale entries', () => {
    const { counted, lines } = currentSites();
    const sorted: Baseline = Object.fromEntries(
      Object.entries(counted).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (process.env.UPDATE_IN_FILTER_BASELINE === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;

    const added: string[] = [];
    const stale: string[] = [];
    const files = new Set([...Object.keys(sorted), ...Object.keys(baseline)]);
    for (const file of files) {
      const now = sorted[file] ?? [];
      const was = baseline[file] ?? [];
      for (const fp of minus(now, was)) {
        const at = lines.get(`${file}\u0000${fp}`) ?? [];
        added.push(`${file}:${at.join(',')}  ${fp}`);
      }
      for (const fp of minus(was, now)) stale.push(`${file}  ${fp}`);
    }

    expect(
      added,
      'New .in() list that is not known to stay short. Route it through ' +
        'fetchAllRowsByIds / writeInIdBatches (server/services/lib/fetch-by-ids.ts), ' +
        'or annotate `// in-list-bound: <why it stays under 100 values>`.',
    ).toEqual([]);
    expect(
      stale,
      'Baseline is stale (a site was fixed or removed): lower it with ' +
        'UPDATE_IN_FILTER_BASELINE=1 npx vitest run src/lib/supabase/in-filter-sites.guard.test.ts',
    ).toEqual([]);
  });
});
