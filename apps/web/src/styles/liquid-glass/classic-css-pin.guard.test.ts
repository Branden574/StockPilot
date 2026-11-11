// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';

import { glassSourceFiles, splitSelectors } from './glass-css';

/**
 * WHAT STAYS OF THE CLASSIC CSS PIN (defence (g); liquid-glass DECISIONS.md,
 * 2026-11-09, "CLASSIC CSS PIN AFTER RELEASE": retired at the release).
 *
 * While Liquid Glass lived on its branch, the pin held every Classic stylesheet
 * to main's text at the merge base: a text check (a) and a compiled comparison
 * of globals.css with the glass dropped (c), both against a copy of main's
 * text kept in the repository and tied to main by git history. Once the
 * branch is on main, main is both sides of that comparison, and the first
 * ordinary Classic CSS change would fail it. So (a), (c), main's text copy,
 * its tie to git history (this guard no longer calls git; the CI Test job
 * keeps its full history for appearance-server-surface.guard.test.ts)
 * and the CSS toolchain record (which only made "main's compile" mean what main
 * shipped) are gone: a Classic CSS change on main is ordinary reviewed work.
 *
 * What stays guards the line between Classic and the glass, not Classic's text:
 *
 *   (b) every stylesheet under apps/web/src is either a glass sheet (a .css
 *       file in styles/liquid-glass or its pages/, exactly what
 *       glassSourceFiles() reads, so every one is under the glass guards) or a
 *       Classic stylesheet listed in classic-css-pin/manifest.json (a glass
 *       subfolder is Classic); no Classic stylesheet brings in anything
 *       (@import, @plugin, @source, @config, @reference) beyond its recorded
 *       list, and globals.css's one addition is the glass @import; and no
 *       source file imports a stylesheet, other than a glass sheet, that is
 *       not on the recorded list. A new Classic stylesheet or import is a
 *       reviewed change that adds it to manifest.json in the same commit.
 *   (d) globals.css compiled from the app's whole source (Tailwind's automatic
 *       scan of apps/web, as the app builds it), without the glass @import,
 *       differs from the same text compiled with only Classic's class list
 *       (classic-css-pin/candidates.dat, the class tokens of Classic's source
 *       when the glass was built) by nothing but utilities for classes not on
 *       that list and theme variables nothing Classic reads with var(). So
 *       class names in the glass markup cannot change what Classic's classes
 *       and custom properties compile to. Both sides are HEAD's own text, so a
 *       Classic change does not trip it.
 *
 * The glass at-rule guard (glass-at-rules.guard.test.ts) stays as it was: no
 * glass stylesheet may hold an at-rule that acts outside the glass root.
 */

const SRC = join(__dirname, '..', '..');
const WEB = join(SRC, '..');
const APP = join(SRC, 'app');
const PIN = join(__dirname, 'classic-css-pin');
const GLASS_PREFIX = 'styles/liquid-glass/';
const STYLESHEET = /\.(css|scss|sass|less|pcss|postcss)$/;

interface Manifest {
  /** The commit candidates.dat and these lists were taken at (the merge base the glass was built on). */
  source: string;
  /** Every Classic stylesheet, by its path under apps/web/src. */
  files: string[];
  /** What each Classic stylesheet brings in (a file not named brings in nothing). */
  imports: Record<string, string[]>;
  /** Every stylesheet a source file imports, other than a glass sheet. */
  stylesheetImports: string[];
  /** How many tokens candidates.dat holds. */
  candidates: number;
}
const MANIFEST = JSON.parse(readFileSync(join(PIN, 'manifest.json'), 'utf8')) as Manifest;
const CANDIDATES = readFileSync(join(PIN, 'candidates.dat'), 'utf8').split('\n').filter(Boolean);

/** The glass @import of globals.css (the line; its comment compiles to nothing). */
const GLASS_IMPORT = "@import '../styles/liquid-glass/index.css';";

/** The one import a Classic stylesheet may add to its recorded list. */
const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  'app/globals.css': ["@import '../styles/liquid-glass/index.css'"],
};

type Sheets = Map<string, string>;

/**
 * A glass stylesheet: exactly what glassSourceFiles() reads (a .css file in
 * styles/liquid-glass or its pages/), so every one is under the glass guards.
 * Any other stylesheet there (a subfolder, another extension) is Classic.
 */
const isGlassSheet = (file: string) => /^styles\/liquid-glass\/(pages\/)?[^/]+\.css$/.test(file);
const isClassic = (file: string) => STYLESHEET.test(file) && !isGlassSheet(file);

/** Every stylesheet under apps/web/src, by its path there (glass ones too). */
function readStylesheets(dir = SRC, out: Sheets = new Map()): Sheets {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) readStylesheets(full, out);
    else if (STYLESHEET.test(e.name)) {
      out.set(relative(SRC, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/** (b) No Classic stylesheet that manifest.json does not list. */
function newFileFindings(sheets: Sheets): string[] {
  return [...sheets.keys()]
    .filter((f) => isClassic(f) && !MANIFEST.files.includes(f))
    .map(
      (f) =>
        `${f}: a new Classic stylesheet (not a glass sheet the glass guards read, and not listed in classic-css-pin/manifest.json)`,
    );
}

/** The at-rules that bring something into a stylesheet. */
function importsOf(text: string, file: string): string[] {
  const out: string[] = [];
  postcss
    .parse(text, { from: file })
    .walkAtRules(/^(import|plugin|source|config|reference)$/, (at) => {
      out.push(`@${at.name} ${at.params.replace(/"/g, "'")}`);
    });
  return out;
}

/** (b) No Classic stylesheet brings in anything beyond its recorded list and ALLOWED_IMPORTS. */
function importFindings(sheets: Sheets): string[] {
  const out: string[] = [];
  for (const [file, text] of sheets) {
    if (!isClassic(file)) continue;
    const known = [...(MANIFEST.imports[file] ?? []), ...(ALLOWED_IMPORTS[file] ?? [])];
    for (const imp of importsOf(text, file)) {
      const at = known.indexOf(imp);
      if (at === -1) out.push(`${file}: imports something new: ${imp}`);
      else known.splice(at, 1);
    }
  }
  return out;
}

/** import './x.css', import x from '@/x.css', import('pkg/x.css'), require('x.css'). */
const IMPORT_STYLESHEET =
  /\b(?:import|require)\s*\(?\s*(?:[^'"();]*?\bfrom\s*)?['"]([^'"]+\.(?:css|scss|sass|less|pcss|postcss))['"]/g;

/** Every non-test source file under apps/web/src, by its path there. */
function readSources(dir = SRC, out = new Map<string, string>()): Map<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) readSources(full, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) {
      out.set(relative(SRC, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/** Every stylesheet a non-test source file under apps/web/src imports, other than a glass sheet. */
function stylesheetImports(sources = readSources()): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, text] of sources) {
    for (const m of text.matchAll(IMPORT_STYLESHEET)) {
      const spec = m[1]!;
      const target = spec.startsWith('.')
        ? posix.join(posix.dirname(rel), spec)
        : spec.startsWith('@/')
          ? spec.slice(2)
          : spec;
      // A glass sheet is under the glass guards; anything else (a glass subfolder) counts as Classic.
      if (!isGlassSheet(target) && !out.has(target)) out.set(target, rel);
    }
  }
  return out;
}

/** (b) Every stylesheet a source file imports that is not on the recorded list. */
function importedFindings(sources?: Map<string, string>): string[] {
  return [...stylesheetImports(sources)]
    .filter(([target]) => !MANIFEST.stylesheetImports.includes(target))
    .map(
      ([target, by]) =>
        `${by}: imports ${target}, which is not a glass sheet and not listed in classic-css-pin/manifest.json`,
    );
}

// ── (d) the compiled comparison ─────────────────────────────────────────────

/** Tailwind's own scanner and compiler, the copies @tailwindcss/postcss runs. */
const fromTailwind = createRequire(
  createRequire(join(WEB, 'package.json')).resolve('@tailwindcss/postcss'),
);
type Source = { base: string; pattern: string; negated: boolean };
const { Scanner } = fromTailwind('@tailwindcss/oxide') as {
  Scanner: new (o: { sources: Source[] }) => { scan(): string[] };
};
const tailwindNode = fromTailwind('@tailwindcss/node') as {
  compile(
    css: string,
    o: { base: string; onDependency: (path: string) => void },
  ): Promise<{ build(candidates: string[]): string }>;
};
const scan = (sources: Source[]) => new Scanner({ sources }).scan();

const TMP = mkdtempSync(join(tmpdir(), 'classic-css-pin-'));
const CANDIDATE_FILE = join(TMP, 'candidates.txt');
writeFileSync(CANDIDATE_FILE, `${CANDIDATES.join('\n')}\n`);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** globals.css without the glass @import line (it must be there exactly once). */
function withoutGlassImport(text: string): string {
  const parts = text.split(`${GLASS_IMPORT}\n`);
  if (parts.length !== 2)
    throw new Error('globals.css does not import the glass index exactly once');
  return parts.join('');
}

let compiles = 0;
/**
 * globals.css through Tailwind as compiled-css.guard.test.ts compiles it, with
 * no automatic sources and Classic's fixed candidate list as the one source.
 */
async function compileClassic(text: string) {
  const importLine = "@import 'tailwindcss';";
  if (!text.includes(importLine)) throw new Error('globals.css no longer imports Tailwind');
  const input = `${text.replace(importLine, "@import 'tailwindcss' source(none);")}\n@source "${CANDIDATE_FILE}";\n`;
  compiles += 1;
  // A path of its own each time: the plugin caches its compiler by file.
  return postcss([tailwindcss({ optimize: false })]).process(input, {
    from: join(APP, `classic-css-pin-${compiles}.css`),
  });
}

/**
 * globals.css through Tailwind with the app's whole source as the class list:
 * Tailwind's automatic scan of apps/web, as the app builds it (its PostCSS
 * plugin runs from apps/web, the base of that scan), and nothing else.
 */
async function compileFullScan(text: string) {
  const importLine = "@import 'tailwindcss';";
  if (!text.includes(importLine)) throw new Error('globals.css no longer imports Tailwind');
  const web = posix.relative(APP.split(sep).join('/'), WEB.split(sep).join('/'));
  compiles += 1;
  return postcss([tailwindcss({ optimize: false })]).process(
    text.replace(importLine, `@import 'tailwindcss' source('${web}');`),
    { from: join(APP, `classic-css-pin-${compiles}.css`) },
  );
}

interface Entry {
  /** The at-rules around it, outermost first. */
  where: string;
  /** The selector, or "@keyframes name", "@property --x", "@font-face". */
  what: string;
  decls: [string, string][];
  /** The selectors of the rules it is nested in, outermost first. */
  inside: string[];
  /** A whole at-rule's body (keyframes): frame -> declarations. */
  frames?: [string, string][];
}

const BODY_AT_RULES =
  /^(keyframes|-webkit-keyframes|property|font-face|counter-style|page|font-feature-values|font-palette-values)$/;

/** A value with its whitespace outside quotes collapsed (and just inside parentheses dropped). */
const squashValue = (value: string) =>
  value
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
    )
    .join('')
    .trim();
const declsOf = (node: Container): [string, string][] => {
  const out: [string, string][] = [];
  node.each((child) => {
    if (child.type === 'decl')
      out.push([child.prop, `${squashValue(child.value)}${child.important ? ' !important' : ''}`]);
  });
  return out;
};
const declText = (decls: [string, string][]) => decls.map(([p, v]) => `${p}: ${v}`).join('; ');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Every rule and body at-rule in document order, and the layer order. */
function entriesOf(css: string): { entries: Entry[]; layers: string[] } {
  const entries: Entry[] = [];
  const layers: string[] = [];
  const addLayers = (params: string) => {
    for (const name of params
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)) {
      if (!layers.includes(name)) layers.push(name);
    }
  };
  const visit = (node: ChildNode, where: string[], inside: string[]) => {
    if (node.type === 'rule') {
      const selector = squash((node as Rule).selector);
      entries.push({
        where: where.join(' > '),
        what: selector,
        decls: declsOf(node as Rule),
        inside,
      });
      (node as Rule).each((child) => {
        if (child.type !== 'decl') visit(child, [...where, selector], [...inside, selector]);
      });
      return;
    }
    if (node.type !== 'atrule') return;
    const at = node as AtRule;
    const label = squash(`@${at.name} ${at.params}`);
    if (at.name === 'layer') addLayers(at.params);
    if (!at.nodes) {
      entries.push({ where: where.join(' > '), what: label, decls: [], inside });
      return;
    }
    if (BODY_AT_RULES.test(at.name)) {
      const frames: [string, string][] = [];
      at.each((child) => {
        if (child.type === 'rule') frames.push([squash(child.selector), declText(declsOf(child))]);
      });
      entries.push({ where: where.join(' > '), what: label, decls: declsOf(at), inside, frames });
      return;
    }
    if (at.nodes.some((n) => n.type === 'decl')) {
      entries.push({ where: where.join(' > '), what: label, decls: declsOf(at), inside });
    }
    at.each((child) => visit(child, [...where, label], inside));
  };
  postcss.parse(css).each((node) => visit(node, [], []));
  return { entries, layers };
}

/** "where what", numbered when the same pair repeats. */
function keyed(entries: Entry[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const seen = new Map<string, number>();
  for (const e of entries) {
    const base = e.where ? `${e.where} > ${e.what}` : e.what;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base} #${n}`, e);
  }
  return out;
}

/** Where two texts first differ, as one line a reader can act on. */
function lineDiff(file: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= i && eb >= i && a[ea] === b[eb]) {
    ea -= 1;
    eb -= 1;
  }
  const show = (lines: string[]) =>
    lines.length === 0
      ? '(nothing)'
      : lines
          .slice(0, 3)
          .map((l) => JSON.stringify(l))
          .join(' / ');
  return (
    `${file}:${i + 1}: Classic's compile ${show(a.slice(i, ea + 1))}, the whole source's ${show(b.slice(i, eb + 1))}` +
    ` (${ea - i + 1} line(s) against ${eb - i + 1})`
  );
}

/** What (d) may let through on the whole source's side, and nothing else. */
interface Allow {
  /** An entry Classic's compile does not have that is not a finding: a utility for a class Classic never had. */
  newEntry?(e: Entry): boolean;
  /** A declaration Classic's entry does not have that is not a finding: an unread theme variable. */
  newDecl?(key: string, prop: string): boolean;
}

/** (d) Every way the whole source's compile differs from Classic's compile, by kind. */
function compiledFindings(classicCss: string, fullCss: string, allow: Allow = {}): string[] {
  if (classicCss === fullCss) return [];
  const out: string[] = [];
  const main = entriesOf(classicCss);
  const branch = entriesOf(fullCss);
  // Whether an allowance let something through: then the texts differ by it.
  let allowed = false;
  if (main.layers.join(', ') !== branch.layers.join(', ')) {
    out.push(
      `layer order: Classic ${main.layers.join(', ')}, whole source ${branch.layers.join(', ')}`,
    );
  }
  const a = keyed(main.entries);
  const b = keyed(branch.entries);
  for (const [key, e] of b) {
    if (!a.has(key) && allow.newEntry?.(e)) allowed = true;
    else if (!a.has(key)) {
      const body = [declText(e.decls), ...(e.frames ?? []).map(([f, d]) => `${f} { ${d} }`)]
        .filter(Boolean)
        .join(' ');
      out.push(`new in the whole source: ${key} { ${body} }`);
    }
  }
  for (const key of a.keys()) if (!b.has(key)) out.push(`missing from the whole source: ${key}`);
  for (const [key, was] of a) {
    const now = b.get(key);
    if (!now) continue;
    if (was.frames || now.frames) {
      const before = new Map(was.frames ?? []);
      const after = new Map(now.frames ?? []);
      for (const frame of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(frame) !== after.get(frame)) {
          out.push(
            `${key} ${frame}: Classic { ${before.get(frame) ?? '(none)'} }, whole source { ${after.get(frame) ?? '(none)'} }`,
          );
        }
      }
    }
    const before = new Map(was.decls);
    const after = new Map(now.decls);
    for (const prop of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(prop) === after.get(prop)) continue;
      if (!before.has(prop) && allow.newDecl?.(key, prop)) {
        after.delete(prop);
        allowed = true;
        continue;
      }
      const kind = prop.startsWith('--') ? 'custom property ' : '';
      out.push(
        `${kind}${prop} in ${key}: Classic ${before.get(prop) ?? '(none)'}, whole source ${after.get(prop) ?? '(none)'}`,
      );
    }
    const nowDecls = now.decls.filter(([p]) => before.has(p) || after.has(p));
    if (
      declText(was.decls) !== declText(nowDecls) &&
      before.size === after.size &&
      [...before].every(([p, v]) => after.get(p) === v)
    ) {
      out.push(
        `declaration order in ${key}: Classic ${declText(was.decls)}, whole source ${declText(nowDecls)}`,
      );
    }
  }
  // The cascade order of what both have.
  const order = (from: Map<string, Entry>, other: Map<string, Entry>) =>
    [...from.keys()].filter((k) => other.has(k));
  const oa = order(a, b);
  const ob = order(b, a);
  const at = oa.findIndex((k, i) => ob[i] !== k);
  if (at !== -1) {
    out.push(
      `cascade order: at rule ${at + 1} Classic has ${oa[at]}, the whole source has ${ob[at]}`,
    );
  }
  // Every kind the entries hold is compared above; a text difference beyond
  // them, with nothing allowed, is still reported.
  if (out.length === 0 && !allowed) out.push(lineDiff('compiled globals.css', classicCss, fullCss));
  return out;
}

const CANDIDATE_SET = new Set(CANDIDATES);
/** The first class of a selector, unescaped: a backslash escape becomes its character. */
const firstClass = (selector: string) =>
  /\.((?:\\.|[^\s.#:[\]>+~,()\\])+)/.exec(selector)?.[1]?.replace(/\\(.)/g, '$1');

/** Every custom property a stylesheet reads with var(). */
const varReads = (css: string) => [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);

const SHEETS = readStylesheets();
const HEAD_GLOBALS = SHEETS.get('app/globals.css')!;
const CLASSIC_GLOBALS = withoutGlassImport(HEAD_GLOBALS);
const classicSheets = (sheets: Sheets = SHEETS) =>
  [...sheets].filter(([f]) => isClassic(f)).map(([, text]) => text);

/**
 * (d) What the app's whole source may add to Classic's compile: a utility for a
 * class not on Classic's list (its first class is not in candidates.dat), and a
 * theme variable on :root that nothing Classic reads (Classic's compiled
 * globals.css and the other Classic stylesheets name it in no var()).
 */
function fullScanAllow(classicCss: string, sheets: Sheets = SHEETS): Allow {
  const reads = new Set([classicCss, ...classicSheets(sheets)].flatMap(varReads));
  return {
    newEntry(e) {
      if (!e.where.startsWith('@layer utilities')) return false;
      if (e.what.startsWith('@') && e.inside.length === 0) return false;
      return splitSelectors(e.inside[0] ?? e.what).every((sel) => {
        const cls = firstClass(sel);
        return cls !== undefined && !CANDIDATE_SET.has(cls);
      });
    },
    newDecl: (key, prop) =>
      key === '@layer theme > :root, :host' && prop.startsWith('--') && !reads.has(prop),
  };
}

/** (d) for a globals.css text (with the glass @import) and the Classic sheets around it. */
async function fullScanFindings(globals: string, sheets: Sheets = SHEETS): Promise<string[]> {
  const classic = withoutGlassImport(globals);
  const { css: classicCss } = await compileClassic(classic);
  const { css: fullCss } = await compileFullScan(classic);
  return compiledFindings(classicCss, fullCss, fullScanAllow(classicCss, sheets));
}

let classicCompiled: Promise<string> | undefined;
const compiledClassic = () =>
  (classicCompiled ??= compileClassic(CLASSIC_GLOBALS).then((r) => r.css));

// ── the guard ───────────────────────────────────────────────────────────────

describe('what stays of the Classic CSS pin (defence g, retired at the release)', () => {
  it('the recorded lists are whole: globals.css among the files, every import list for a listed file', () => {
    expect(MANIFEST.source).toMatch(/^[0-9a-f]{40}$/);
    expect(MANIFEST.files).toContain('app/globals.css');
    expect([...MANIFEST.files].sort()).toEqual(MANIFEST.files);
    for (const file of Object.keys(MANIFEST.imports)) expect(MANIFEST.files).toContain(file);
    for (const file of Object.keys(ALLOWED_IMPORTS)) expect(MANIFEST.files).toContain(file);
  });

  it('the candidate list is sorted and unique, and Tailwind’s scanner reads it back whole', () => {
    expect(CANDIDATES.length).toBe(MANIFEST.candidates);
    expect(CANDIDATES.length).toBeGreaterThan(1000);
    expect([...new Set(CANDIDATES)].sort()).toEqual(CANDIDATES);
    const read = new Set(scan([{ base: TMP, pattern: 'candidates.txt', negated: false }]));
    expect(CANDIDATES.filter((c) => !read.has(c))).toEqual([]);
  });

  it('the guard’s own files (this test and classic-css-pin/) add nothing to the stylesheet the app builds', async () => {
    // The app's build scans every file of apps/web for class names, tests too.
    const own = [
      { base: __dirname, pattern: 'classic-css-pin.guard.test.ts', negated: false },
      { base: PIN, pattern: '**/*', negated: false },
    ];
    const rest = scan([
      { base: WEB, pattern: '**/*', negated: false },
      ...own.map((s) => ({ ...s, negated: true })),
    ]);
    const mine = scan(own);
    expect(mine.length).toBeGreaterThan(0);
    const input = HEAD_GLOBALS.replace(
      "@import 'tailwindcss';",
      "@import 'tailwindcss' source(none);",
    );
    const build = async (list: string[]) =>
      (await tailwindNode.compile(input, { base: APP, onDependency: () => {} })).build(list);
    const without = await build(rest);
    const withOwn = await build([...rest, ...mine]);
    const seen = new Set(without.split('\n'));
    expect(withOwn.split('\n').filter((line) => !seen.has(line))).toEqual([]);
    expect(withOwn.length).toBe(without.length);
  });

  it('(b) there is no Classic stylesheet manifest.json does not list', () => {
    expect([...SHEETS.keys()].filter(isClassic).sort()).toEqual(
      expect.arrayContaining(MANIFEST.files),
    );
    expect(newFileFindings(SHEETS)).toEqual([]);
  });

  it('(b) no Classic stylesheet imports anything new; the glass @import is the one allowlisted', () => {
    expect(importFindings(SHEETS)).toEqual([]);
    expect(importsOf(HEAD_GLOBALS, 'app/globals.css')).toEqual([
      "@import 'tailwindcss'",
      "@plugin 'tailwindcss-animate'",
      "@import '../styles/liquid-glass/index.css'",
    ]);
  });

  it('(b) no source file imports a stylesheet that is not listed, other than a glass sheet', () => {
    expect(importedFindings()).toEqual([]);
    expect([...stylesheetImports().keys()]).toEqual(expect.arrayContaining(['app/globals.css']));
  });

  it('(d) globals.css compiled from the whole source adds only utilities for classes not on Classic’s list and theme variables nothing Classic reads', async () => {
    const classic = await compiledClassic();
    expect(classic).toContain('@layer utilities');
    expect(classic).toContain('@property --tw-');
    const { css } = await compileFullScan(CLASSIC_GLOBALS);
    expect(css.length).toBeGreaterThan(classic.length);
    expect(compiledFindings(classic, css, fullScanAllow(classic))).toEqual([]);
  });
});

// ── controls ────────────────────────────────────────────────────────────────

/** Replace text that occurs exactly once (so a control never silently misses). */
function once(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2)
    throw new Error(`expected one ${JSON.stringify(from)}, found ${parts.length - 1}`);
  return parts.join(to);
}

// Built from parts, so this file names no new whole class for Tailwind to build.
const PULSE = ['animate', 'pulse'].join('-');
const PULSE_VAR = `--${PULSE}`;

/** The sheets with globals.css replaced. */
const withGlobals = (css: string): Sheets => new Map([...SHEETS, ['app/globals.css', css]]);

describe('controls', () => {
  it('the retirement: an ordinary edit to Classic stylesheets’ text (keyframes, a theme variable, a new rule, another file) trips none of the kept checks', async () => {
    // The kinds of edit check 4 found (N-A1 keyframes and a theme variable, N-A3
    // a new rule for a class Classic uses), which (a) and (c) used to fail.
    // Appended, so this control holds whatever Classic's text becomes.
    const edited =
      `${HEAD_GLOBALS}\n@theme {\n  ${PULSE_VAR}: pulse 0.4s linear infinite;\n}\n` +
      '@keyframes nav-progress-probe {\n  100% { transform: scaleX(0.58); opacity: 1; }\n}\n' +
      `@layer utilities {\n  @media (prefers-reduced-motion: no-preference) {\n    .${PULSE} {\n      opacity: 0.6;\n    }\n  }\n}\n`;
    const sheets = withGlobals(edited);
    sheets.set(
      'components/po/po-list.css',
      `${SHEETS.get('components/po/po-list.css')!}\n.x { color: red; }\n`,
    );
    expect(newFileFindings(sheets)).toEqual([]);
    expect(importFindings(sheets)).toEqual([]);
    expect(importedFindings()).toEqual([]);
    expect(await fullScanFindings(edited, sheets)).toEqual([]);
  });

  it('a change inside styles/liquid-glass passes (b); a new Classic file fails it', () => {
    const glass = new Map(SHEETS);
    const shell = 'styles/liquid-glass/shell.css';
    expect(glass.has(shell)).toBe(true);
    const rule =
      "\n@layer lg { @media screen { :root[data-appearance='liquid-glass'] .sp-mark-spath { stroke-dashoffset: 115; } } }\n";
    glass.set(shell, glass.get(shell)! + rule);
    glass.set('styles/liquid-glass/pages/control.css', rule);
    expect(newFileFindings(glass)).toEqual([]);
    expect(importFindings(glass)).toEqual([]);
    const classic = new Map(SHEETS);
    classic.set('components/po/control.css', rule);
    expect(newFileFindings(classic)).toEqual([
      'components/po/control.css: a new Classic stylesheet (not a glass sheet the glass guards read, and not listed in classic-css-pin/manifest.json)',
    ]);
  });

  it('a new import in a Classic stylesheet fails (b)', () => {
    const css = once(
      HEAD_GLOBALS,
      "@plugin 'tailwindcss-animate';\n",
      "@plugin 'tailwindcss-animate';\n@import './extra.css';\n",
    );
    expect(importFindings(withGlobals(css))).toEqual([
      "app/globals.css: imports something new: @import './extra.css'",
    ]);
  });

  it('a stylesheet in a subfolder of styles/liquid-glass, imported from the root layout, fails (b) twice', () => {
    const sub = 'styles/liquid-glass/extra/x.css';
    const sheets = new Map([...SHEETS, [sub, `.${PULSE} { animation-duration: 0.4s; }\n`]]);
    expect(newFileFindings(sheets)).toEqual([
      `${sub}: a new Classic stylesheet (not a glass sheet the glass guards read, and not listed in classic-css-pin/manifest.json)`,
    ]);
    const sources = readSources();
    const layout = sources.get('app/layout.tsx')!;
    sources.set('app/layout.tsx', `import '../styles/liquid-glass/extra/x.css';\n${layout}`);
    expect(importedFindings(sources)).toEqual([
      `app/layout.tsx: imports ${sub}, which is not a glass sheet and not listed in classic-css-pin/manifest.json`,
    ]);
  });

  it('isGlassSheet names exactly the files glassSourceFiles() reads', () => {
    const onDisk = [...SHEETS.keys()].filter((f) => f.startsWith(GLASS_PREFIX) && isGlassSheet(f));
    expect(onDisk.sort()).toEqual(
      glassSourceFiles()
        .map((f) => GLASS_PREFIX + f.file)
        .sort(),
    );
  });

  describe('(d) lets through only unread theme variables and utilities for classes not on Classic’s list', () => {
    const THEME_OPEN = /(@layer theme \{\s*:root, :host \{\n)/;
    const withTheme = (css: string, decl: string) => {
      expect(css).toMatch(THEME_OPEN);
      return css.replace(THEME_OPEN, `$1    ${decl}\n`);
    };
    const withUtility = (css: string, rule: string) => {
      const at = css.lastIndexOf('@layer utilities {');
      expect(at).toBeGreaterThan(-1);
      const open = at + '@layer utilities {'.length;
      return `${css.slice(0, open)}\n  ${rule}${css.slice(open)}`;
    };

    it('a new theme variable nothing Classic reads passes; one Classic reads fails', async () => {
      const classic = await compiledClassic();
      // A variable Classic reads that the theme block does not set.
      const theme = THEME_OPEN.exec(classic);
      const themeBody = classic.slice(theme!.index, classic.indexOf('\n  }', theme!.index));
      const read = varReads(classic).find(
        (v) => !v.startsWith('--tw-') && !themeBody.includes(`${v}:`),
      );
      expect(read).toBeDefined();
      const unread = '--lgx-unread-zz';
      expect(
        compiledFindings(classic, withTheme(classic, `${unread}: 1px;`), fullScanAllow(classic)),
      ).toEqual([]);
      expect(
        compiledFindings(classic, withTheme(classic, `${read}: red;`), fullScanAllow(classic)),
      ).toEqual([
        `custom property ${read} in @layer theme > :root, :host: Classic (none), whole source red`,
      ]);
    });

    it('a changed theme value, a new @property and a new rule for a Classic class fail; a utility for a new class passes', async () => {
      const classic = await compiledClassic();
      const allow = fullScanAllow(classic);
      const changed = classic.replace(
        `${PULSE_VAR}: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;`,
        `${PULSE_VAR}: pulse 0.4s linear infinite;`,
      );
      expect(changed).not.toBe(classic);
      expect(compiledFindings(classic, changed, allow)).toEqual([
        `custom property ${PULSE_VAR} in @layer theme > :root, :host: Classic pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite, whole source pulse 0.4s linear infinite`,
      ]);
      const property = `${classic}\n@property --tw-lgx-zz { syntax: '*'; inherits: false; initial-value: 6px; }\n`;
      expect(compiledFindings(classic, property, allow)).toEqual([
        "new in the whole source: @property --tw-lgx-zz { syntax: '*'; inherits: false; initial-value: 6px }",
      ]);
      const classicRule = withUtility(
        classic,
        `@media (prefers-reduced-motion: no-preference) { .${PULSE} { opacity: 0.6; } }`,
      );
      expect(compiledFindings(classic, classicRule, allow)).toEqual([
        `new in the whole source: @layer utilities > @media (prefers-reduced-motion: no-preference) > .${PULSE} { opacity: 0.6 }`,
      ]);
      const fresh = withUtility(classic, '.lgx-new-zz { opacity: 0.6; }');
      expect(compiledFindings(classic, fresh, allow)).toEqual([]);
    });
  });
});
