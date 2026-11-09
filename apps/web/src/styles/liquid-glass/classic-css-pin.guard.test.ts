// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CLASSIC_HIDE_RULE,
  GLASS_ROOT,
  glassSourceFiles,
  normaliseQuotes,
  splitSelectors,
} from './glass-css';

/**
 * THE CLASSIC CSS PIN (defence (g); liquid-glass DECISIONS.md, 2026-11-09).
 * Classic Dark and Light must look exactly as on main. Check 4 of the parity
 * tool showed that a capture cannot see Classic CSS whose element is absent at
 * shot time (N-A1 keyframes, @property and custom property values; N-A2 the
 * cascade order of unmatched rules; N-A3 a new rule for a class Classic uses,
 * in a new context). This guard closes that class at the source:
 *
 *   (a) every Classic stylesheet (every stylesheet under apps/web/src except
 *       the glass sheets: a .css file in styles/liquid-glass or its pages/,
 *       exactly what glassSourceFiles() reads, so every one is under the
 *       glass guards) equals main's text at the merge base, held in
 *       classic-css-pin/files, except the hunks named in ALLOWED_HUNKS, each
 *       with its reason;
 *   (b) there is no new Classic stylesheet (a glass subfolder is Classic), no
 *       Classic stylesheet imports anything new (the glass @import is the one
 *       allowlisted), and no source file imports a stylesheet other than a
 *       glass sheet that main did not import (the fixture copies included);
 *   (c) globals.css compiled through Tailwind (as compiled-css.guard.test.ts
 *       compiles it) at main's text, and at HEAD WITH the glass @import and
 *       the glass files the app loads beside it (the unlayered companions and
 *       the page compositions), with ONE fixed candidate list
 *       (classic-css-pin/candidates.dat: the class tokens of Classic's source
 *       at the merge base), is the same once the glass entries are dropped
 *       (rules every selector of which starts with the glass root, the two
 *       allowed visibility and print rules, @keyframes lg-*, @property --lg-*
 *       and layer lg): layer order, rule order, every rule's declarations,
 *       every custom property value, and every @keyframes, @property,
 *       @font-face and other at-rule. So a global at-rule a glass file brings
 *       in (@property, @font-face, @config, @page...) fails here as well as in
 *       glass-at-rules.guard.test.ts;
 *   (d) globals.css compiled at HEAD without the glass @import from HEAD's
 *       whole source (Tailwind's automatic scan of apps/web, as the app
 *       builds it) differs from (c)'s compile of main only by new utilities
 *       for classes Classic's source never had (not in candidates.dat) and
 *       new theme variables nothing Classic reads with var(); and the CSS
 *       toolchain (tailwindcss, @tailwindcss/postcss and its node and oxide
 *       halves, postcss, tailwindcss-animate, postcss.config.mjs) is the merge
 *       base's (manifest.json toolchain).
 * The fixture is tied to main (the provenance test): its text is the recorded
 * commit's, that commit is on origin/main and is the merge base of the branch;
 * in CI a missing commit or origin/main FAILS (the Test job fetches with
 * fetch-depth: 0), it is never skipped.
 *
 * When main is merged in, refresh the fixture from the new merge base:
 *   git fetch origin && node apps/web/src/styles/liquid-glass/classic-css-pin/refresh.mjs
 * The script takes origin/main's text at the merge base and refuses anything
 * else. A new allowlisted hunk needs a reason and the compiled proof of (c).
 */

const SRC = join(__dirname, '..', '..');
const WEB = join(SRC, '..');
const APP = join(SRC, 'app');
const PIN = join(__dirname, 'classic-css-pin');
const GLASS_PREFIX = 'styles/liquid-glass/';
const PIN_PREFIX = `${GLASS_PREFIX}classic-css-pin/`;
const STYLESHEET = /\.(css|scss|sass|less|pcss|postcss)$/;

interface Manifest {
  mergeBase: string;
  files: string[];
  stylesheetImports: string[];
  candidates: number;
  /** The CSS toolchain at the merge base: package -> version, and postcss.config.mjs's text. */
  toolchain: { packages: Record<string, string>; postcssConfig: string };
}
const MANIFEST = JSON.parse(readFileSync(join(PIN, 'manifest.json'), 'utf8')) as Manifest;
const MAIN_SHORT = MANIFEST.mergeBase.slice(0, 9);
const CANDIDATES = readFileSync(join(PIN, 'candidates.dat'), 'utf8').split('\n').filter(Boolean);

/** The glass @import of globals.css: the comment and the line, as one hunk. */
const GLASS_IMPORT_HUNK =
  '/* Liquid Glass, the opt-in third appearance: every rule scoped to\n' +
  '   :root[data-appearance="liquid-glass"] in cascade layer lg (styles/liquid-glass). */\n' +
  "@import '../styles/liquid-glass/index.css';\n";

interface Hunk {
  file: string;
  name: string;
  reason: string;
  /** The hunk is inserted right after this text, which main's file holds once. */
  after: string;
  insert: string;
}

/** Every way a Classic stylesheet may differ from main's text. */
const ALLOWED_HUNKS: readonly Hunk[] = [
  {
    file: 'app/globals.css',
    name: 'the Liquid Glass @import',
    reason:
      'brings in styles/liquid-glass/index.css, every rule of which is scoped to ' +
      ':root[data-appearance="liquid-glass"], inside @media screen and @layer lg ' +
      '(glass-scope and compiled-css guards), and no at-rule of which acts outside ' +
      'that scope (glass-at-rules guard: only @import in index.css, @layer, @media, ' +
      '@supports, @container, @starting-style, @keyframes lg-* and @property --lg-*); ' +
      "(c) compiles globals.css WITH it and requires main's output once the glass " +
      'entries are dropped',
    after: "@plugin 'tailwindcss-animate';\n",
    insert: GLASS_IMPORT_HUNK,
  },
];

/** The only imports a Classic stylesheet may add to main's. */
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
/** The pin's own copies of main's text (classic-css-pin/files), which nothing loads. */
const FIXTURE_COPIES = new Set(MANIFEST.files.map((f) => `${PIN_PREFIX}files/${f}`));

const isClassic = (file: string) =>
  STYLESHEET.test(file) && !isGlassSheet(file) && !FIXTURE_COPIES.has(file);

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

const FIXTURE: Sheets = new Map(
  MANIFEST.files.map((f) => [f, readFileSync(join(PIN, 'files', f), 'utf8')]),
);

/** Main's text of a file with its allowlisted hunks applied. */
function expectedText(file: string, main: string): string {
  let text = main;
  for (const hunk of ALLOWED_HUNKS.filter((h) => h.file === file)) {
    const parts = text.split(hunk.after);
    if (parts.length !== 2)
      throw new Error(`${file}: the anchor of ${hunk.name} is not there once`);
    text = parts.join(hunk.after + hunk.insert);
  }
  return text;
}

/** Where two texts first differ, as one line a reader can act on. */
function lineDiff(file: string, main: string, branch: string): string {
  const a = main.split('\n');
  const b = branch.split('\n');
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
    `${file}:${i + 1}: differs from main's text (${MAIN_SHORT}): ` +
    `main ${show(a.slice(i, ea + 1))}, branch ${show(b.slice(i, eb + 1))}` +
    ` (${ea - i + 1} line(s) of main, ${eb - i + 1} of the branch)`
  );
}

/** (a) Every Classic stylesheet is main's text, except the allowlisted hunks. */
function textFindings(sheets: Sheets, fixture: Sheets = FIXTURE): string[] {
  const out: string[] = [];
  for (const [file, main] of fixture) {
    const branch = sheets.get(file);
    if (branch === undefined) {
      out.push(`${file}: removed (main has it)`);
      continue;
    }
    const expected = expectedText(file, main);
    if (branch !== expected) out.push(lineDiff(file, expected, branch));
  }
  return out;
}

/** (b) No Classic stylesheet main does not have. */
function newFileFindings(sheets: Sheets, fixture: Sheets = FIXTURE): string[] {
  return [...sheets.keys()]
    .filter((f) => isClassic(f) && !fixture.has(f))
    .map(
      (f) =>
        `${f}: a new Classic stylesheet (not a glass sheet the glass guards read; main has no such file)`,
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

/** (b) No Classic stylesheet imports anything main's does not, beyond ALLOWED_IMPORTS. */
function importFindings(sheets: Sheets, fixture: Sheets = FIXTURE): string[] {
  const out: string[] = [];
  for (const [file, text] of sheets) {
    if (!isClassic(file)) continue;
    const known = [...importsOf(fixture.get(file) ?? '', file), ...(ALLOWED_IMPORTS[file] ?? [])];
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

/**
 * Every stylesheet a non-test source file under apps/web/src imports, other
 * than a glass sheet (refresh.mjs lists main's, which has no glass folder).
 */
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
      // A glass sheet is under the glass guards; anything else (a glass
      // subfolder, the pin's fixture copies) counts as Classic.
      if (!isGlassSheet(target) && !out.has(target)) out.set(target, rel);
    }
  }
  return out;
}

/** (b) Every stylesheet a source file imports that main never imported. */
function importedFindings(sources?: Map<string, string>): string[] {
  return [...stylesheetImports(sources)]
    .filter(([target]) => !MANIFEST.stylesheetImports.includes(target))
    .map(([target, by]) => `${by}: imports ${target}, which main never imported`);
}

// ── (c) the compiled comparison ─────────────────────────────────────────────

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

/** globals.css with its allowlisted hunks taken out (the glass @import). */
function withoutAllowedHunks(text: string): string {
  let out = text;
  for (const hunk of ALLOWED_HUNKS.filter((h) => h.file === 'app/globals.css')) {
    out = out.split(hunk.after + hunk.insert).join(hunk.after);
  }
  return out;
}

let compiles = 0;
/**
 * globals.css through Tailwind as compiled-css.guard.test.ts compiles it, with
 * no automatic sources and the fixed candidate list as the one source.
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
 * globals.css through Tailwind with HEAD's whole source as the class list:
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

type GlassFile = { file: string; text: string };
const GLASS_FILES: GlassFile[] = glassSourceFiles();

/** The files index.css imports, in its order. */
function indexImports(files: GlassFile[]): GlassFile[] {
  const index = files.find((f) => f.file === 'index.css');
  if (!index) throw new Error('styles/liquid-glass/index.css is gone');
  const out: GlassFile[] = [];
  postcss.parse(index.text).walkAtRules('import', (at) => {
    const name = at.params.replace(/['"]/g, '').replace(/^\.\//, '');
    const file = files.find((f) => f.file === name);
    if (!file) throw new Error(`index.css imports ${name}, which is not a glass file`);
    out.push(file);
  });
  return out;
}

/** The glass files the app loads beside globals.css: every one index.css does not import. */
function glassBeside(files = GLASS_FILES): GlassFile[] {
  const imported = new Set(['index.css', ...indexImports(files).map((f) => f.file)]);
  return files.filter((f) => !imported.has(f.file));
}

/**
 * globals.css at HEAD with the glass @import, as the app compiles it, and the
 * glass files the app loads beside it (the unlayered companions from the root
 * and auth layouts, the page compositions from their routes), in one text.
 */
async function compileWithGlass(text: string, planted?: { file: string; text: string }[]) {
  const importLine = "@import '../styles/liquid-glass/index.css';";
  if (!text.includes(importLine)) throw new Error('globals.css no longer imports the glass index');
  const files = planted ?? GLASS_FILES;
  // Planted copies are put in place of the @import, in index.css's order (what
  // Tailwind's @import does with the files on disk; a control shows the two agree).
  const input = planted
    ? text.replace(importLine, () =>
        indexImports(files)
          .map((f) => f.text)
          .join('\n'),
      )
    : text;
  const { css } = await compileClassic(input);
  return [css, ...glassBeside(files).map((f) => `/* ${f.file} */\n${f.text}`)].join('\n');
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

/**
 * A value with its whitespace outside quotes collapsed: Tailwind's @import
 * keeps a multi-line value of an imported file on one line, the file's own
 * text keeps its line breaks, and the two mean the same.
 */
const squashValue = (value: string) =>
  value
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, ' ')))
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

/** What a comparison may let through on the branch's side, and nothing else. */
interface Allow {
  /** Dropped from the branch before comparing (the glass entries of (c)). */
  entry?(e: Entry): boolean;
  /** A layer name dropped from the branch's layer order. */
  layer?(name: string): boolean;
  /** An entry main does not have that is not a finding ((d): a utility for a class Classic never had). */
  newEntry?(e: Entry): boolean;
  /** A declaration main's entry does not have that is not a finding ((d): an unread theme variable). */
  newDecl?(key: string, prop: string): boolean;
  /** The texts may differ in layout (line breaks, indentation) alone. */
  layout?: boolean;
}

/** (c), (d) Every way the compiled branch differs from compiled main, by kind. */
function compiledFindings(mainCss: string, branchCss: string, allow: Allow = {}): string[] {
  if (mainCss === branchCss) return [];
  const out: string[] = [];
  const main = entriesOf(mainCss);
  const branch = entriesOf(branchCss);
  const branchLayers = branch.layers.filter((l) => !allow.layer?.(l));
  // Whether an allowance let something through: then the texts differ by it.
  let allowed = allow.layout === true || branchLayers.length !== branch.layers.length;
  if (main.layers.join(', ') !== branchLayers.join(', ')) {
    out.push(`layer order: main ${main.layers.join(', ')}, branch ${branchLayers.join(', ')}`);
  }
  const a = keyed(main.entries);
  const kept = branch.entries.filter((e) => !allow.entry?.(e));
  allowed ||= kept.length !== branch.entries.length;
  const b = keyed(kept);
  for (const [key, e] of b) {
    if (!a.has(key) && allow.newEntry?.(e)) allowed = true;
    else if (!a.has(key)) {
      const body = [declText(e.decls), ...(e.frames ?? []).map(([f, d]) => `${f} { ${d} }`)]
        .filter(Boolean)
        .join(' ');
      out.push(`new in the branch: ${key} { ${body} }`);
    }
  }
  for (const key of a.keys()) if (!b.has(key)) out.push(`removed in the branch: ${key}`);
  for (const [key, was] of a) {
    const now = b.get(key);
    if (!now) continue;
    if (was.frames || now.frames) {
      const before = new Map(was.frames ?? []);
      const after = new Map(now.frames ?? []);
      for (const frame of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(frame) !== after.get(frame)) {
          out.push(
            `${key} ${frame}: main { ${before.get(frame) ?? '(none)'} }, branch { ${after.get(frame) ?? '(none)'} }`,
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
        `${kind}${prop} in ${key}: main ${before.get(prop) ?? '(none)'}, branch ${after.get(prop) ?? '(none)'}`,
      );
    }
    const nowDecls = now.decls.filter(([p]) => before.has(p) || after.has(p));
    if (
      declText(was.decls) !== declText(nowDecls) &&
      before.size === after.size &&
      [...before].every(([p, v]) => after.get(p) === v)
    ) {
      out.push(
        `declaration order in ${key}: main ${declText(was.decls)}, branch ${declText(nowDecls)}`,
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
    out.push(`cascade order: at rule ${at + 1} main has ${oa[at]}, the branch has ${ob[at]}`);
  }
  // Every kind the entries hold is compared above; a text difference beyond
  // them, with nothing allowed, is still reported.
  if (out.length === 0 && !allowed) out.push(lineDiff('compiled globals.css', mainCss, branchCss));
  return out;
}

/** Every selector of the list starts with the glass root. */
const glassScoped = (selector: string) => splitSelectors(selector).every((s) => GLASS_ROOT.test(s));
const isLgLayer = (name: string) => name === 'lg' || name.startsWith('lg.');

/** The two glass rules that act outside the glass root, by place, text and declarations. */
const GLASS_UNSCOPED: readonly { where: string; what: string; decls: string }[] = [
  { where: '@layer lg', what: CLASSIC_HIDE_RULE, decls: 'display: none' },
  { where: '@layer lg > @media print', what: '[data-glass-only]', decls: 'display: none' },
];

/**
 * (c) The glass entries, dropped from HEAD's compile before it is held to
 * main's: a rule every selector of which (or of a rule around it) starts with
 * the glass root, the two allowed unscoped rules, @keyframes lg-*, @property
 * --lg-*, a layer statement that only adds lg to main's layers, and layer lg in
 * the layer order. Anything else a glass file brings in is compared.
 */
function glassAllow(mainLayers: readonly string[]): Allow {
  return {
    entry(e) {
      if (e.inside.some(glassScoped)) return true;
      if (!e.what.startsWith('@')) {
        if (glassScoped(e.what)) return true;
        return GLASS_UNSCOPED.some(
          (r) =>
            r.where === e.where &&
            r.what === normaliseQuotes(e.what) &&
            r.decls === declText(e.decls),
        );
      }
      if (/^@(-webkit-)?keyframes lg-[\w-]+$/.test(e.what)) return true;
      if (/^@property --lg-[\w-]+$/.test(e.what)) return true;
      const layer = /^@layer ([\w.\-, ]+)$/.exec(e.what);
      if (layer && !e.frames && e.decls.length === 0) {
        const names = layer[1]!.split(',').map((n) => n.trim());
        return names.some(isLgLayer) && names.every((n) => isLgLayer(n) || mainLayers.includes(n));
      }
      return false;
    },
    layer: isLgLayer,
  };
}

const CANDIDATE_SET = new Set(CANDIDATES);
/** The first class of a selector, unescaped: a backslash escape becomes its character. */
const firstClass = (selector: string) =>
  /\.((?:\\.|[^\s.#:[\]>+~,()\\])+)/.exec(selector)?.[1]?.replace(/\\(.)/g, '$1');

/** Every custom property a stylesheet reads with var(). */
const varReads = (css: string) => [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);

/**
 * (d) What HEAD's whole source may add to the Classic compile: a utility for a
 * class Classic's source never had (its first class is not in candidates.dat,
 * so no Classic element carries it; changing Classic markup is defence (f)'s),
 * and a theme variable on :root that nothing Classic reads (main's compiled
 * globals.css and main's other Classic stylesheets name it in no var()).
 */
function fullScanAllow(mainCss: string): Allow {
  const reads = new Set([mainCss, ...FIXTURE.values()].flatMap(varReads));
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

// ── the toolchain and the provenance ────────────────────────────────────────

/** The CSS toolchain the compiles above run with (the packages the app's build resolves). */
function installedToolchain(): Record<string, string> {
  const versionOf = (resolveFrom: NodeRequire, name: string) => {
    let dir = posix.dirname(resolveFrom.resolve(name).split(sep).join('/'));
    for (;;) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version: string;
        };
        if (pkg.name === name) return pkg.version;
      } catch {
        // No package.json at this level: keep climbing.
      }
      const up = posix.dirname(dir);
      if (up === dir) throw new Error(`no package.json for ${name}`);
      dir = up;
    }
  };
  const fromWeb = createRequire(join(WEB, 'package.json'));
  return {
    '@tailwindcss/node': versionOf(fromTailwind, '@tailwindcss/node'),
    '@tailwindcss/oxide': versionOf(fromTailwind, '@tailwindcss/oxide'),
    '@tailwindcss/postcss': versionOf(fromWeb, '@tailwindcss/postcss'),
    postcss: versionOf(fromWeb, 'postcss'),
    tailwindcss: versionOf(fromWeb, 'tailwindcss'),
    'tailwindcss-animate': versionOf(fromWeb, 'tailwindcss-animate'),
  };
}

type Git = (...args: string[]) => string | undefined;

/**
 * The fixture is main's text at the branch's merge base. Returns 'skip' only
 * outside CI with no git repository at all; in CI, and wherever git works, a
 * missing commit or origin/main is a finding, never a skip.
 */
function provenanceFindings(
  git: Git,
  ci: boolean,
  manifest: Manifest = MANIFEST,
  fixture: Sheets = FIXTURE,
): string[] | 'skip' {
  const fetch = 'the CI Test job checks out with fetch-depth: 0; locally: git fetch origin';
  if (git('rev-parse', '--git-dir') === undefined) {
    return ci ? [`git is not available, so the fixture cannot be tied to main (${fetch})`] : 'skip';
  }
  const sha = manifest.mergeBase;
  if (git('cat-file', '-e', `${sha}^{commit}`) === undefined) {
    return [`the recorded merge base ${sha} is not in this clone (${fetch})`];
  }
  const main = git('rev-parse', '--verify', 'origin/main^{commit}')?.trim();
  if (!main) return [`origin/main is not in this clone (${fetch})`];
  const out: string[] = [];
  for (const file of manifest.files) {
    if (git('show', `${sha}:apps/web/src/${file}`) !== fixture.get(file)) {
      out.push(`classic-css-pin/files/${file} is not ${sha.slice(0, 9)}'s text`);
    }
  }
  const atBase = (
    git('ls-tree', '--full-tree', '-r', '--name-only', sha, '--', 'apps/web/src') ?? ''
  )
    .split('\n')
    .filter((p) => STYLESHEET.test(p) && !p.startsWith(`apps/web/src/${GLASS_PREFIX}`))
    .map((p) => p.slice('apps/web/src/'.length))
    .sort();
  if (atBase.join('\n') !== [...manifest.files].sort().join('\n')) {
    out.push(
      `manifest files are not ${sha.slice(0, 9)}'s Classic stylesheets: ${atBase.join(', ')}`,
    );
  }
  const isAncestor = (a: string, b: string) =>
    git('merge-base', '--is-ancestor', a, b) !== undefined;
  if (!isAncestor(sha, main)) out.push(`${sha} is not on origin/main`);
  if (!isAncestor(sha, 'HEAD')) out.push(`${sha} is not in HEAD's history`);
  // The branch's tip: HEAD, or for a pull request's merge commit (main first,
  // the branch second) its second parent.
  const second = git('rev-parse', '--verify', '--quiet', 'HEAD^2^{commit}')?.trim();
  const tip = second && isAncestor('HEAD^1', main) && !isAncestor(second, main) ? second : 'HEAD';
  const tipSha = git('rev-parse', `${tip}^{commit}`)?.trim();
  const base = git('merge-base', tip, main)?.trim();
  // Once the branch is on main (after its merge) there is no merge base to hold it to.
  if (base !== tipSha && base !== sha) {
    out.push(
      `manifest mergeBase ${sha} is not the merge base of the branch and origin/main (${base}): ` +
        'run classic-css-pin/refresh.mjs',
    );
  }
  return out;
}

// ── the guard ───────────────────────────────────────────────────────────────

const SHEETS = readStylesheets();
const HEAD_GLOBALS = SHEETS.get('app/globals.css')!;
let mainCompiled: Promise<string> | undefined;
const compiledMain = () =>
  (mainCompiled ??= compileClassic(FIXTURE.get('app/globals.css')!).then((r) => r.css));

describe('the Classic CSS pin (defence g)', () => {
  it('holds main’s text at the merge base, and every allowlisted hunk has a name and a reason', () => {
    expect(MANIFEST.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(MANIFEST.files).toContain('app/globals.css');
    expect([...FIXTURE.keys()]).toEqual(MANIFEST.files);
    for (const hunk of ALLOWED_HUNKS) {
      expect(hunk.name.length).toBeGreaterThan(0);
      expect(hunk.reason.length).toBeGreaterThan(40);
      expect(MANIFEST.files).toContain(hunk.file);
    }
  });

  const git: Git = (...args) => {
    try {
      return execFileSync('git', args, {
        cwd: WEB,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return undefined;
    }
  };
  const provenance = provenanceFindings(git, Boolean(process.env.CI));
  // Skipped only outside CI where there is no git repository at all.
  it.runIf(provenance !== 'skip')(
    'the fixture is the recorded commit’s text, that commit is on origin/main and is the branch’s merge base (CI: required)',
    () => {
      expect(provenance).toEqual([]);
    },
  );

  it('the CSS toolchain is the merge base’s: the same packages and postcss.config.mjs', () => {
    expect(installedToolchain()).toEqual(MANIFEST.toolchain.packages);
    expect(readFileSync(join(WEB, 'postcss.config.mjs'), 'utf8')).toBe(
      MANIFEST.toolchain.postcssConfig,
    );
  });

  it('the candidate list is sorted and unique, and Tailwind’s scanner reads it back whole', () => {
    expect(CANDIDATES.length).toBe(MANIFEST.candidates);
    expect(CANDIDATES.length).toBeGreaterThan(1000);
    expect([...new Set(CANDIDATES)].sort()).toEqual(CANDIDATES);
    const read = new Set(scan([{ base: TMP, pattern: 'candidates.txt', negated: false }]));
    expect(CANDIDATES.filter((c) => !read.has(c))).toEqual([]);
  });

  it('the pin’s own files (this test and the fixture) add nothing to the stylesheet the app builds', async () => {
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

  it('(a) every Classic stylesheet equals main’s text at the merge base, except the allowlisted hunks', () => {
    expect([...SHEETS.keys()].filter(isClassic).sort()).toEqual(
      expect.arrayContaining(MANIFEST.files),
    );
    expect(textFindings(SHEETS)).toEqual([]);
  });

  it('(b) there is no new Classic stylesheet', () => {
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

  it('(b) no source file imports a stylesheet that main did not, other than a glass sheet', () => {
    expect(importedFindings()).toEqual([]);
    expect([...stylesheetImports().keys()]).toEqual(expect.arrayContaining(['app/globals.css']));
  });

  it('(c) globals.css compiled at main’s text, and at HEAD with the glass @import and the glass files beside it, is the same once the glass entries are dropped', async () => {
    const main = await compiledMain();
    expect(main).toContain('@keyframes nav-progress-climb');
    expect(main).toContain('@property --tw-');
    const beside = glassBeside().map((f) => f.file);
    expect(beside).toEqual(expect.arrayContaining(['globals.glass.css', 'pages/items.css']));
    const branch = await compileWithGlass(HEAD_GLOBALS);
    // The glass is in it (so the drop below is what keeps (c) passing).
    expect(branch).toMatch(/:root\[data-appearance=["']liquid-glass["']\]/);
    expect(branch.length).toBeGreaterThan(main.length);
    expect(compiledFindings(main, branch, glassAllow(entriesOf(main).layers))).toEqual([]);
  });

  it('(d) globals.css compiled from HEAD’s whole source adds only utilities for classes Classic never had and theme variables nothing Classic reads', async () => {
    const main = await compiledMain();
    const { css } = await compileFullScan(withoutAllowedHunks(HEAD_GLOBALS));
    expect(css.length).toBeGreaterThan(main.length);
    expect(compiledFindings(main, css, fullScanAllow(main))).toEqual([]);
  });
});

// ── check 4's attacks (N-A1 to N-A3) must fail it ───────────────────────────

/** Replace text that occurs exactly once (so an attack never silently misses). */
function once(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2)
    throw new Error(`expected one ${JSON.stringify(from)}, found ${parts.length - 1}`);
  return parts.join(to);
}

const MARK_REDUCED =
  '  @media (prefers-reduced-motion: reduce) {\n' +
  '    .sp-mark-spath {\n' +
  '      animation: none;\n' +
  '      stroke-dashoffset: 0;\n' +
  '    }\n' +
  '    .sp-mark-pip {\n' +
  '      animation: none;\n' +
  '      opacity: 1;\n' +
  '    }\n' +
  '  }\n';
const MARK_BASE_START = '  .sp-mark-spath {\n    stroke-dasharray: 230;';
// Built from parts, so this file names no new whole class for Tailwind to build.
const PULSE = ['animate', 'pulse'].join('-');

const ATTACKS: Record<string, (css: string) => string> = {
  // N-A1 (a): the nav-progress keyframes, the lines the branch had re-formatted.
  'N-A1a': (css) =>
    once(
      once(
        css,
        '  100% { transform: scaleX(0.85); opacity: 1; }',
        '  100% { transform: scaleX(0.58); opacity: 1; }',
      ),
      '  100% { transform: scaleX(1); opacity: 0; }',
      '  100% { transform: scaleX(1); opacity: 1; }',
    ),
  // N-A1 (b): the loader's draw keyframes hold the S half drawn.
  'N-A1b': (css) =>
    once(
      once(
        css,
        '    45% {\n      stroke-dashoffset: 0;',
        '    45% {\n      stroke-dashoffset: 115;',
      ),
      '    80% {\n      stroke-dashoffset: 0;',
      '    80% {\n      stroke-dashoffset: 115;',
    ),
  // N-A1 (c): the theme variable and the keyframes every skeleton's pulse reads.
  'N-A1c': (css) =>
    once(
      css,
      '\n}\n\n@layer base {\n  :root {\n',
      `\n  --${PULSE}: pulse 0.4s linear infinite;\n  @keyframes pulse {\n    50% {\n      opacity: 0.05;\n    }\n  }\n}\n\n@layer base {\n  :root {\n`,
    ),
  // N-A2: the reduced-motion override of the mark moves above its base rules.
  'N-A2': (css) =>
    once(once(css, MARK_REDUCED, ''), MARK_BASE_START, MARK_REDUCED + MARK_BASE_START),
  // N-A3: a new context for a class Classic already uses, in @layer utilities.
  'N-A3': (css) =>
    once(
      css,
      '    scrollbar-color: var(--ed-line-strong) transparent;\n  }\n',
      '    scrollbar-color: var(--ed-line-strong) transparent;\n  }\n' +
        `  @media (prefers-reduced-motion: no-preference) {\n    .${PULSE} {\n      animation-duration: 0.4s;\n      opacity: 0.6;\n    }\n  }\n`,
    ),
};

/** The sheets with globals.css replaced. */
const withGlobals = (css: string): Sheets => new Map([...SHEETS, ['app/globals.css', css]]);

async function attackFindings(name: string) {
  const css = ATTACKS[name]!(HEAD_GLOBALS);
  const branch = await compileClassic(withoutAllowedHunks(css));
  return {
    text: textFindings(withGlobals(css)),
    compiled: compiledFindings(await compiledMain(), branch.css),
  };
}

describe('check 4’s attacks on Classic globals.css fail the pin', () => {
  it('N-A1 (a): nav-progress-climb 100% scaleX 0.85 -> 0.58, nav-progress-complete 100% opacity 0 -> 1', async () => {
    const { text, compiled } = await attackFindings('N-A1a');
    expect(text).toEqual([
      expect.stringMatching(
        /^app\/globals\.css:\d+: differs from main's text .*scaleX\(0\.85\).*scaleX\(0\.58\)/,
      ),
    ]);
    expect(compiled).toEqual([
      '@keyframes nav-progress-climb 100%: main { transform: scaleX(0.85); opacity: 1 }, branch { transform: scaleX(0.58); opacity: 1 }',
      '@keyframes nav-progress-complete 100%: main { transform: scaleX(1); opacity: 0 }, branch { transform: scaleX(1); opacity: 1 }',
    ]);
  });

  it('N-A1 (b): sp-mark-draw 45% and 80% stroke-dashoffset 0 -> 115', async () => {
    const { text, compiled } = await attackFindings('N-A1b');
    expect(text).toEqual([
      expect.stringMatching(
        /^app\/globals\.css:\d+: differs from main's text .*stroke-dashoffset: 115/,
      ),
    ]);
    expect(compiled).toEqual([
      '@layer components > @keyframes sp-mark-draw 45%: main { stroke-dashoffset: 0 }, branch { stroke-dashoffset: 115 }',
      '@layer components > @keyframes sp-mark-draw 80%: main { stroke-dashoffset: 0 }, branch { stroke-dashoffset: 115 }',
    ]);
  });

  it('N-A1 (c): the pulse theme variable duration and @keyframes pulse 50% opacity', async () => {
    const { text, compiled } = await attackFindings('N-A1c');
    expect(text).toEqual([
      expect.stringMatching(
        /^app\/globals\.css:\d+: differs from main's text .*pulse 0\.4s linear infinite/,
      ),
    ]);
    // Tailwind keeps its own @keyframes pulse; the later one of the same name wins.
    expect(compiled).toEqual([
      'new in the branch: @keyframes pulse #2 { 50% { opacity: 0.05 } }',
      `custom property --${PULSE} in @layer theme > :root, :host: main pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite, branch pulse 0.4s linear infinite`,
    ]);
  });

  it('N-A2: the reduced-motion .sp-mark-* override moved above the base rules', async () => {
    const { text, compiled } = await attackFindings('N-A2');
    expect(text).toEqual([
      expect.stringMatching(/^app\/globals\.css:\d+: differs from main's text /),
    ]);
    expect(compiled).toEqual([
      expect.stringMatching(
        /^cascade order: at rule \d+ main has @layer components > \.sp-mark-spath, the branch has @layer components > @media \(prefers-reduced-motion: reduce\) > \.sp-mark-spath$/,
      ),
    ]);
  });

  it('N-A3: a new @media (prefers-reduced-motion: no-preference) rule for the pulse utility in @layer utilities', async () => {
    const { text, compiled } = await attackFindings('N-A3');
    expect(text).toEqual([
      expect.stringMatching(/^app\/globals\.css:\d+: differs from main's text .*no-preference/),
    ]);
    expect(compiled).toEqual([
      `new in the branch: @layer utilities > @media (prefers-reduced-motion: no-preference) > .${PULSE} { animation-duration: 0.4s; opacity: 0.6 }`,
    ]);
  });
});

// ── controls ────────────────────────────────────────────────────────────────

describe('controls', () => {
  it('a change inside styles/liquid-glass under the glass root trips none of (a) to (c)', async () => {
    const glass = new Map(SHEETS);
    const shell = 'styles/liquid-glass/shell.css';
    expect(glass.has(shell)).toBe(true);
    const rule =
      "\n@layer lg { @media screen { :root[data-appearance='liquid-glass'] .sp-mark-spath { stroke-dashoffset: 115; } } }\n";
    glass.set(shell, glass.get(shell)! + rule);
    glass.set('styles/liquid-glass/pages/control.css', rule);
    expect(textFindings(glass)).toEqual([]);
    expect(newFileFindings(glass)).toEqual([]);
    expect(importFindings(glass)).toEqual([]);
    // (c) reads the glass and drops what is scoped to the glass root.
    const planted = plantGlass({ 'shell.css': rule });
    planted.push({ file: 'pages/control.css', text: rule });
    const main = await compiledMain();
    const css = await compileWithGlass(HEAD_GLOBALS, planted);
    expect(css).toContain('stroke-dashoffset: 115');
    expect(compiledFindings(main, css, glassAllow(entriesOf(main).layers))).toEqual([]);
    // The same rule in a Classic file is caught by (a), and a new Classic file by (b).
    const classic = new Map(SHEETS);
    classic.set('components/po/po-list.css', SHEETS.get('components/po/po-list.css')! + rule);
    classic.set('components/po/control.css', rule);
    expect(textFindings(classic)).toEqual([
      expect.stringMatching(/^components\/po\/po-list\.css:\d+: differs/),
    ]);
    expect(newFileFindings(classic)).toEqual([
      'components/po/control.css: a new Classic stylesheet (not a glass sheet the glass guards read; main has no such file)',
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
});

// ── the fix round's attacks (glass at-rules, the subfolder, the provenance, (d)) ─

/** The glass files with text appended to some of them. */
function plantGlass(extra: Record<string, string>): GlassFile[] {
  for (const file of Object.keys(extra)) {
    if (!GLASS_FILES.some((f) => f.file === file)) throw new Error(`no glass file ${file}`);
  }
  return GLASS_FILES.map((f) => ({ file: f.file, text: f.text + (extra[f.file] ?? '') }));
}

async function glassFindings(planted: GlassFile[]) {
  const main = await compiledMain();
  return compiledFindings(
    main,
    await compileWithGlass(HEAD_GLOBALS, planted),
    glassAllow(entriesOf(main).layers),
  );
}

const PULSE_VAR = `--${PULSE}`;
const PROPERTY_ATTACK = `\n@layer lg { @media screen { @property ${PULSE_VAR} { syntax: '<time>'; inherits: true; initial-value: 0s; } } }\n`;

describe('the fix round’s attacks fail the pin', () => {
  it('control: the glass inlined in place of its @import compiles as the @import does', async () => {
    const main = await compiledMain();
    const viaImport = await compileWithGlass(HEAD_GLOBALS);
    const inlined = await compileWithGlass(HEAD_GLOBALS, plantGlass({}));
    expect(viaImport).not.toBe(inlined);
    expect(compiledFindings(viaImport, inlined, { layout: true })).toEqual([]);
    expect(compiledFindings(main, inlined, glassAllow(entriesOf(main).layers))).toEqual([]);
  });

  it('control: without the glass drop, (c) sees the glass (so the drop is what lets it pass)', async () => {
    const main = await compiledMain();
    const css = await compileWithGlass(HEAD_GLOBALS);
    const raw = compiledFindings(main, css);
    expect(raw.length).toBeGreaterThan(10);
    expect(raw).toEqual(expect.arrayContaining([expect.stringMatching(/^layer order: .*, lg/)]));
  });

  it('@property for a Classic custom property in shell.css (@layer lg > @media screen) fails (c)', async () => {
    expect(await glassFindings(plantGlass({ 'shell.css': PROPERTY_ATTACK }))).toEqual([
      `new in the branch: @layer lg > @media screen > @property ${PULSE_VAR} { syntax: '<time>'; inherits: true; initial-value: 0s }`,
    ]);
  });

  it('@property and @font-face in the unlayered companion globals.glass.css fail (c)', async () => {
    const found = await glassFindings(
      plantGlass({
        'globals.glass.css': `\n@property ${PULSE_VAR} { syntax: '<time>'; inherits: true; initial-value: 0s; }\n@font-face { font-family: 'Tinos'; src: local('Comic Sans MS'); }\n`,
      }),
    );
    expect(found).toEqual([
      `new in the branch: @property ${PULSE_VAR} { syntax: '<time>'; inherits: true; initial-value: 0s }`,
      "new in the branch: @font-face { font-family: 'Tinos'; src: local('Comic Sans MS') }",
    ]);
  });

  it('@config in shell.css that changes the pulse animation fails (c)', async () => {
    const config = join(TMP, 'lg.config.cjs');
    writeFileSync(
      config,
      "module.exports = { theme: { extend: { animation: { pulse: 'pulse 0.4s linear infinite' } } } };\n",
    );
    const found = await glassFindings(plantGlass({ 'shell.css': `\n@config '${config}';\n` }));
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(
            `^animation in @layer utilities > \\.${PULSE}: main var\\(${PULSE_VAR}\\), branch pulse 0\\.4s linear infinite$`,
          ),
        ),
      ]),
    );
  });

  it('@page and an unscoped rule inside @layer lg fail (c)', async () => {
    const found = await glassFindings(
      plantGlass({
        'shell.css': `\n@layer lg { @page { margin: 3in; } @media screen { .sp-mark-spath { stroke-dashoffset: 115; } } }\n`,
      }),
    );
    expect(found).toEqual([
      'new in the branch: @layer lg > @page { margin: 3in }',
      'new in the branch: @layer lg > @media screen > .sp-mark-spath { stroke-dashoffset: 115 }',
    ]);
  });

  it('a stylesheet in a subfolder of styles/liquid-glass, imported from the root layout, fails (b) twice', () => {
    const sub = 'styles/liquid-glass/extra/x.css';
    const sheets = new Map([...SHEETS, [sub, `.${PULSE} { animation-duration: 0.4s; }\n`]]);
    expect(newFileFindings(sheets)).toEqual([
      `${sub}: a new Classic stylesheet (not a glass sheet the glass guards read; main has no such file)`,
    ]);
    const sources = readSources();
    const layout = sources.get('app/layout.tsx')!;
    sources.set('app/layout.tsx', `import '../styles/liquid-glass/extra/x.css';\n${layout}`);
    expect(importedFindings(sources)).toEqual([
      `app/layout.tsx: imports ${sub}, which main never imported`,
    ]);
  });

  it('a source file importing the pin’s fixture copy of globals.css fails (b), and a copy is not a Classic sheet', () => {
    const sources = readSources();
    sources.set(
      'components/po/control.tsx',
      "import '@/styles/liquid-glass/classic-css-pin/files/app/globals.css';\n",
    );
    expect(importedFindings(sources)).toEqual([
      'components/po/control.tsx: imports styles/liquid-glass/classic-css-pin/files/app/globals.css, which main never imported',
    ]);
    expect(isClassic(`${PIN_PREFIX}files/app/globals.css`)).toBe(false);
    expect(isClassic(`${PIN_PREFIX}files/app/other.css`)).toBe(true);
  });

  it('isGlassSheet names exactly the files glassSourceFiles() reads', () => {
    const onDisk = [...SHEETS.keys()].filter((f) => f.startsWith(GLASS_PREFIX) && isGlassSheet(f));
    expect(onDisk.sort()).toEqual(GLASS_FILES.map((f) => GLASS_PREFIX + f.file).sort());
  });

  describe('provenance: a fixture changed in step with globals.css fails', () => {
    const real: Git = (...args) => {
      try {
        return execFileSync('git', args, {
          cwd: WEB,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return undefined;
      }
    };
    const hasRepo = real('rev-parse', '--git-dir') !== undefined;
    const FAKE = '0123456789abcdef0123456789abcdef01234567';
    // The fixture with one Classic value changed (as the same edit to globals.css
    // would be). Built with replace, not once(): a fixture already edited on disk
    // must still load this file, so that the provenance test above can fail.
    const matched = new Map(FIXTURE);
    matched.set(
      'app/globals.css',
      FIXTURE.get('app/globals.css')!.replace(/--chart-4: [^;]+;/, '--chart-4: 95 28% 37%;'),
    );

    it('in CI, a shallow clone (no recorded commit, no origin/main) is a finding, not a skip', () => {
      const shallow: Git = (...args) =>
        args[0] === 'rev-parse' && args[1] === '--git-dir' ? '.git\n' : undefined;
      expect(provenanceFindings(shallow, true)).toEqual([
        `the recorded merge base ${MANIFEST.mergeBase} is not in this clone (the CI Test job checks out with fetch-depth: 0; locally: git fetch origin)`,
      ]);
      expect(provenanceFindings(() => undefined, true)).toEqual([
        'git is not available, so the fixture cannot be tied to main (the CI Test job checks out with fetch-depth: 0; locally: git fetch origin)',
      ]);
      expect(provenanceFindings(() => undefined, false)).toBe('skip');
    });

    it.runIf(hasRepo)('a made-up merge base fails, in CI and out of it', () => {
      for (const ci of [true, false]) {
        expect(provenanceFindings(real, ci, { ...MANIFEST, mergeBase: FAKE }, matched)).toEqual([
          `the recorded merge base ${FAKE} is not in this clone (the CI Test job checks out with fetch-depth: 0; locally: git fetch origin)`,
        ]);
      }
    });

    it.runIf(hasRepo)('the real merge base with a matched edit fails', () => {
      expect(provenanceFindings(real, true, MANIFEST, matched)).toEqual([
        `classic-css-pin/files/app/globals.css is not ${MAIN_SHORT}'s text`,
      ]);
    });

    it.runIf(hasRepo)('an older commit of main, not the merge base, fails', () => {
      const older = real('rev-parse', `${MANIFEST.mergeBase}~1`)!.trim();
      const found = provenanceFindings(real, true, { ...MANIFEST, mergeBase: older });
      expect(found).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^manifest mergeBase ${older} is not the merge base of the branch and origin/main \\(${MANIFEST.mergeBase}\\)`,
            ),
          ),
        ]),
      );
    });
  });

  describe('(d) lets through only unread theme variables and utilities for classes Classic never had', () => {
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
      const main = await compiledMain();
      // A variable Classic reads that the theme block does not set.
      const read = varReads(main).find((v) => v.startsWith('--ed-'));
      expect(read).toBeDefined();
      const unread = '--lgx-unread-zz';
      expect(
        compiledFindings(main, withTheme(main, `${unread}: 1px;`), fullScanAllow(main)),
      ).toEqual([]);
      expect(compiledFindings(main, withTheme(main, `${read}: red;`), fullScanAllow(main))).toEqual(
        [`custom property ${read} in @layer theme > :root, :host: main (none), branch red`],
      );
    });

    it('a changed theme value, a new @property and a new rule for a Classic class fail; a utility for a new class passes', async () => {
      const main = await compiledMain();
      const allow = fullScanAllow(main);
      const changed = main.replace(
        `${PULSE_VAR}: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;`,
        `${PULSE_VAR}: pulse 0.4s linear infinite;`,
      );
      expect(changed).not.toBe(main);
      expect(compiledFindings(main, changed, allow)).toEqual([
        `custom property ${PULSE_VAR} in @layer theme > :root, :host: main pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite, branch pulse 0.4s linear infinite`,
      ]);
      const property = `${main}\n@property --tw-lgx-zz { syntax: '*'; inherits: false; initial-value: 6px; }\n`;
      expect(compiledFindings(main, property, allow)).toEqual([
        "new in the branch: @property --tw-lgx-zz { syntax: '*'; inherits: false; initial-value: 6px }",
      ]);
      const classic = withUtility(
        main,
        `@media (prefers-reduced-motion: no-preference) { .${PULSE} { opacity: 0.6; } }`,
      );
      expect(compiledFindings(main, classic, allow)).toEqual([
        `new in the branch: @layer utilities > @media (prefers-reduced-motion: no-preference) > .${PULSE} { opacity: 0.6 }`,
      ]);
      const fresh = withUtility(main, '.lgx-new-zz { opacity: 0.6; }');
      expect(compiledFindings(main, fresh, allow)).toEqual([]);
    });
  });
});
