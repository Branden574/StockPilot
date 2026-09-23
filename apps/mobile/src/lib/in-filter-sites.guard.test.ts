import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: no unbounded id list in a PostgREST `in` filter.
 *
 * supabase-js puts every `.in()` value into the request URL. Past about 215
 * uuids the local gateway refuses the request, and past about 395 a production
 * response fails; where a screen ignored `{ error }` that became a silent wrong
 * answer (reserved stock shown as available, an order that looked short, an
 * empty member list). Long id lists go through fetchAllRowsByIds in
 * id-batches.ts, which batches them and throws on a failed batch.
 *
 * This scans app/ and src/ (tests and fixtures excluded) for every
 *   .in(col, values)          .not(col, 'in', values)
 *   .filter(col, 'in', values)   and `in.(` inside a filter string (.or())
 * and fails on any whose values are not provably short. A site passes when:
 *   - the values are an array literal (`['rack', 'crate']`), not a spread;
 *   - the values are a SCREAMING_CASE constant (`RECEIVABLE_STATUSES`);
 *   - the values are the identifier `batch` (a fetchAllRowsByIds builder);
 *   - or an `// in-list-bound: <reason>` comment sits on the same line or up
 *     to 3 lines above, saying why the list stays short.
 * Comments are stripped before the scan (prose in comments mentions `.in()`
 * all over), and line numbers are kept so a failure names the real line.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const ANNOTATION_REACH = 3;

/**
 * Blank out `//` and `/* *\/` comments, keeping every newline (so line numbers
 * hold) and every string's contents. Single- and double-quoted strings end at
 * a newline, so a quote misread inside a regex literal cannot swallow more
 * than its own line.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i]!;
        if (c === '\\') {
          out += c + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '\n' && quote !== '`') break;
        out += c;
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The top-level arguments of the call whose `(` is at `open`, split on
 * top-level commas. Brackets and strings nest; a template literal's `${}` is
 * treated as part of the string.
 */
function callArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let i = open + 1;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== quote) j += code[j] === '\\' ? 2 : 1;
      current += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
    i += 1;
  }
  args.push(current.trim());
  return args;
}

interface InSite {
  line: number; // 1-based
  kind: '.in(' | ".not(,'in')" | ".filter(,'in')" | 'in.(';
  values: string | null;
}

const IS_IN_OPERATOR = /^(['"`])in\1$/;

/** Every `in` filter site in one file's source. */
function findInSites(src: string): InSite[] {
  const code = stripComments(src);
  const lineAt = (idx: number) => code.slice(0, idx).split('\n').length;
  const sites: InSite[] = [];
  for (const m of code.matchAll(/\.in\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    sites.push({ line: lineAt(m.index), kind: '.in(', values: callArgs(code, open)[1] ?? null });
  }
  for (const m of code.matchAll(/\.(not|filter)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(code, open);
    if (args.length >= 3 && IS_IN_OPERATOR.test(args[1]!)) {
      sites.push({
        line: lineAt(m.index),
        kind: m[1] === 'not' ? ".not(,'in')" : ".filter(,'in')",
        values: args[2]!,
      });
    }
  }
  for (const m of code.matchAll(/(?<![A-Za-z0-9_$])in\.\(/g)) {
    sites.push({ line: lineAt(m.index), kind: 'in.(', values: null });
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** Why a site is allowed, or null when it is not. */
function siteAllowance(site: InSite, srcLines: readonly string[]): string | null {
  const v = site.values;
  if (v !== null) {
    // A spread (`[...ids]`) is an array literal of unbounded length.
    if (v.startsWith('[') && !v.includes('...')) return 'array literal';
    if (/^[A-Z][A-Z0-9_]*$/.test(v)) return 'constant';
    if (v === 'batch') return 'batched';
  }
  for (let l = site.line; l >= Math.max(1, site.line - ANNOTATION_REACH); l -= 1) {
    const m = /\/\/\s*in-list-bound:\s*(\S.*)$/.exec(srcLines[l - 1] ?? '');
    if (m) return `annotated: ${m[1]!.trim()}`;
  }
  return null;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(MOBILE_ROOT, 'app'));
  walk(path.join(MOBILE_ROOT, 'src'));
  return out.sort();
}

describe('in-filter guard: the scanner', () => {
  it('strips comments but keeps strings and line numbers', () => {
    const src = [
      "const a = 'https://x.test'; // .in('id', ids)",
      "/* .in('id', ids)",
      "   still a comment */ const b = 1;",
      "q.in('id', ids);",
    ].join('\n');
    const code = stripComments(src);
    expect(code.split('\n')).toHaveLength(4);
    expect(code).toContain("'https://x.test'");
    expect(code).not.toMatch(/\/\/ \.in/);
    expect(findInSites(src).map((s) => s.line)).toEqual([4]);
  });

  it('reads the values argument across lines and nested calls', () => {
    const src = "q.in(\n  'id',\n  previous.map((r) => r.id),\n);";
    expect(findInSites(src)).toEqual([{ line: 1, kind: '.in(', values: 'previous.map((r) => r.id)' }]);
  });

  it('flags an unbounded list and passes the four allowed shapes', () => {
    const src = [
      "q.in('id', ids);", // 1: flagged
      "q.in('kind', ['rack', 'crate']);", // 2: literal
      "q.in('status', RECEIVABLE_STATUSES);", // 3: constant
      "q.in('id', batch);", // 4: batched
      '// in-list-bound: one page of 50 rows',
      "q.in('id', pageIds);", // 6: annotated
      '',
      '',
      '',
      '// in-list-bound: too far above',
      '',
      '',
      '',
      "q.in('id', farIds);", // 14: annotation is 4 lines up, flagged
      "q.in('id', [...ids]);", // 15: a spread is not a short literal, flagged
    ].join('\n');
    const lines = src.split('\n');
    const verdicts = findInSites(src).map((s) => [s.line, siteAllowance(s, lines)]);
    expect(verdicts).toEqual([
      [1, null],
      [2, 'array literal'],
      [3, 'constant'],
      [4, 'batched'],
      [6, 'annotated: one page of 50 rows'],
      [14, null],
      [15, null],
    ]);
  });

  it('sees .not/.filter with the in operator, and in.( inside a filter string', () => {
    const src = [
      "q.not('event', 'in', `(${list.join(',')})`);",
      "q.filter('item_id', 'in', `(${ids})`);",
      "q.not('deleted_at', 'is', null);",
      'q.or(`charter_id.is.null,charter_id.in.(${real.join(\',\')})`);',
    ].join('\n');
    const sites = findInSites(src);
    expect(sites.map((s) => [s.line, s.kind])).toEqual([
      [1, ".not(,'in')"],
      [2, ".filter(,'in')"],
      [4, 'in.('],
    ]);
    const lines = src.split('\n');
    expect(sites.every((s) => siteAllowance(s, lines) === null)).toBe(true);
  });
});

describe('in-filter guard: the app', () => {
  const files = sourceFiles();
  const scanned = files.flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    return findInSites(src).map((site) => ({
      where: `${path.relative(MOBILE_ROOT, file)}:${site.line}`,
      site,
      allowance: siteAllowance(site, lines),
    }));
  });

  it('scans a real set of sites (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100);
    // The batched readers alone hold nine; the screens hold the rest.
    expect(scanned.filter((s) => s.allowance === 'batched').length).toBeGreaterThanOrEqual(9);
    expect(scanned.length).toBeGreaterThan(30);
  });

  it('every in filter is a literal, a constant, a batch, or annotated with why it stays short', () => {
    const offenders = scanned
      .filter((s) => s.allowance === null)
      .map((s) => `${s.where} ${s.site.kind} values=${s.site.values ?? '(in a filter string)'}`);
    expect(
      offenders,
      'Batch the list with fetchAllRowsByIds (src/lib/id-batches.ts), or add ' +
        '`// in-list-bound: <why it stays short>` on or up to 3 lines above the call.',
    ).toEqual([]);
  });
});
