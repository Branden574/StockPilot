// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * THE CLASSIC CSS PIN (defence (g); liquid-glass DECISIONS.md, 2026-11-09).
 * Classic Dark and Light must look exactly as on main. Check 4 of the parity
 * tool showed that a capture cannot see Classic CSS whose element is absent at
 * shot time (N-A1 keyframes, @property and custom property values; N-A2 the
 * cascade order of unmatched rules; N-A3 a new rule for a class Classic uses,
 * in a new context). This guard closes that class at the source:
 *
 *   (a) every Classic stylesheet (apps/web/src outside styles/liquid-glass)
 *       equals main's text at the merge base, held in classic-css-pin/files,
 *       except the hunks named in ALLOWED_HUNKS, each with its reason;
 *   (b) there is no new Classic stylesheet, no Classic stylesheet imports
 *       anything new (the glass @import is the one allowlisted), and no source
 *       file imports a stylesheet outside styles/liquid-glass that main did
 *       not import;
 *   (c) globals.css compiled through Tailwind (as compiled-css.guard.test.ts
 *       compiles it) at main's text and at HEAD without the glass @import,
 *       with ONE fixed candidate list (classic-css-pin/candidates.dat: the
 *       class tokens of Classic's source at the merge base), is the same:
 *       layer order, rule order, every rule's declarations, every custom
 *       property value, and every @keyframes, @property and @font-face.
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
const STYLESHEET = /\.(css|scss|sass|less|pcss|postcss)$/;

interface Manifest {
  mergeBase: string;
  files: string[];
  stylesheetImports: string[];
  candidates: number;
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
      '(glass-scope and compiled-css guards); (c) compiles globals.css without it ' +
      "and requires main's output",
    after: "@plugin 'tailwindcss-animate';\n",
    insert: GLASS_IMPORT_HUNK,
  },
];

/** The only imports a Classic stylesheet may add to main's. */
const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  'app/globals.css': ["@import '../styles/liquid-glass/index.css'"],
};

type Sheets = Map<string, string>;

const isClassic = (file: string) => STYLESHEET.test(file) && !file.startsWith(GLASS_PREFIX);

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
      (f) => `${f}: a new Classic stylesheet (outside styles/liquid-glass; main has no such file)`,
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
 * Every stylesheet a non-test source file under apps/web/src imports, outside
 * styles/liquid-glass (refresh.mjs lists main's with the same rule).
 */
function stylesheetImports(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) {
        const rel = relative(SRC, full).split(sep).join('/');
        for (const m of readFileSync(full, 'utf8').matchAll(IMPORT_STYLESHEET)) {
          const spec = m[1]!;
          const target = spec.startsWith('.')
            ? posix.join(posix.dirname(rel), spec)
            : spec.startsWith('@/')
              ? spec.slice(2)
              : spec;
          if (!target.startsWith(GLASS_PREFIX) && !out.has(target)) out.set(target, rel);
        }
      }
    }
  };
  walk(SRC);
  return out;
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

interface Entry {
  /** The at-rules around it, outermost first. */
  where: string;
  /** The selector, or "@keyframes name", "@property --x", "@font-face". */
  what: string;
  decls: [string, string][];
  /** A whole at-rule's body (keyframes): frame -> declarations. */
  frames?: [string, string][];
}

const BODY_AT_RULES =
  /^(keyframes|-webkit-keyframes|property|font-face|counter-style|page|font-feature-values|font-palette-values)$/;

const declsOf = (node: Container): [string, string][] => {
  const out: [string, string][] = [];
  node.each((child) => {
    if (child.type === 'decl')
      out.push([child.prop, `${child.value}${child.important ? ' !important' : ''}`]);
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
  const visit = (node: ChildNode, where: string[]) => {
    if (node.type === 'rule') {
      entries.push({
        where: where.join(' > '),
        what: squash((node as Rule).selector),
        decls: declsOf(node as Rule),
      });
      (node as Rule).each((child) => {
        if (child.type !== 'decl') visit(child, [...where, squash((node as Rule).selector)]);
      });
      return;
    }
    if (node.type !== 'atrule') return;
    const at = node as AtRule;
    const label = squash(`@${at.name} ${at.params}`);
    if (at.name === 'layer') addLayers(at.params);
    if (!at.nodes) {
      entries.push({ where: where.join(' > '), what: label, decls: [] });
      return;
    }
    if (BODY_AT_RULES.test(at.name)) {
      const frames: [string, string][] = [];
      at.each((child) => {
        if (child.type === 'rule') frames.push([squash(child.selector), declText(declsOf(child))]);
      });
      entries.push({ where: where.join(' > '), what: label, decls: declsOf(at), frames });
      return;
    }
    if (at.nodes.some((n) => n.type === 'decl')) {
      entries.push({ where: where.join(' > '), what: label, decls: declsOf(at) });
    }
    at.each((child) => visit(child, [...where, label]));
  };
  postcss.parse(css).each((node) => visit(node, []));
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

/** (c) Every way the compiled branch differs from compiled main, by kind. */
function compiledFindings(mainCss: string, branchCss: string): string[] {
  if (mainCss === branchCss) return [];
  const out: string[] = [];
  const main = entriesOf(mainCss);
  const branch = entriesOf(branchCss);
  if (main.layers.join(', ') !== branch.layers.join(', ')) {
    out.push(`layer order: main ${main.layers.join(', ')}, branch ${branch.layers.join(', ')}`);
  }
  const a = keyed(main.entries);
  const b = keyed(branch.entries);
  for (const [key, e] of b) {
    if (!a.has(key)) {
      const body = e.frames
        ? e.frames.map(([f, d]) => `${f} { ${d} }`).join(' ')
        : declText(e.decls);
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
      const kind = prop.startsWith('--') ? 'custom property ' : '';
      out.push(
        `${kind}${prop} in ${key}: main ${before.get(prop) ?? '(none)'}, branch ${after.get(prop) ?? '(none)'}`,
      );
    }
    if (
      declText(was.decls) !== declText(now.decls) &&
      before.size === after.size &&
      [...before].every(([p, v]) => after.get(p) === v)
    ) {
      out.push(
        `declaration order in ${key}: main ${declText(was.decls)}, branch ${declText(now.decls)}`,
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
  if (out.length === 0) out.push(lineDiff('compiled globals.css', mainCss, branchCss));
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

  // Where git and the recorded commit are at hand (not in a shallow CI clone).
  const git = (...args: string[]) => {
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
  const recorded = git('cat-file', '-e', `${MANIFEST.mergeBase}^{commit}`) !== undefined;
  it.runIf(recorded)(
    'the fixture is the recorded commit’s text, and that commit is on origin/main',
    () => {
      for (const file of MANIFEST.files) {
        expect(git('show', `${MANIFEST.mergeBase}:apps/web/src/${file}`), file).toBe(
          FIXTURE.get(file),
        );
      }
      if (git('rev-parse', '--verify', 'origin/main^{commit}') !== undefined) {
        expect(git('merge-base', '--is-ancestor', MANIFEST.mergeBase, 'origin/main')).toBe('');
      }
    },
  );

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

  it('(b) no source file imports a stylesheet outside styles/liquid-glass that main did not', () => {
    const branch = stylesheetImports();
    const fresh = [...branch].filter(([target]) => !MANIFEST.stylesheetImports.includes(target));
    expect(
      fresh.map(([target, by]) => `${by}: imports ${target}, which main never imported`),
    ).toEqual([]);
    expect([...branch.keys()]).toEqual(expect.arrayContaining(['app/globals.css']));
  });

  it('(c) globals.css compiled at main’s text and at HEAD without the glass @import is the same', async () => {
    const branch = await compileClassic(withoutAllowedHunks(HEAD_GLOBALS));
    expect(withoutAllowedHunks(HEAD_GLOBALS)).not.toContain('liquid-glass/index.css');
    const main = await compiledMain();
    expect(main).toContain('@keyframes nav-progress-climb');
    expect(main).toContain('@property --tw-');
    expect(compiledFindings(main, branch.css)).toEqual([]);
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
    // (c) never reads a glass file: it compiles globals.css without the glass
    // @import, so its only dependencies are Tailwind's own and the candidates.
    const branch = await compileClassic(withoutAllowedHunks(HEAD_GLOBALS));
    const deps = branch.messages
      .filter((m) => m.type === 'dependency')
      .map((m) => String((m as { file?: string }).file));
    expect(deps.some((d) => d.includes('liquid-glass'))).toBe(false);
    expect(deps).toContain(CANDIDATE_FILE);
    // The same rule in a Classic file is caught by (a), and a new Classic file by (b).
    const classic = new Map(SHEETS);
    classic.set('components/po/po-list.css', SHEETS.get('components/po/po-list.css')! + rule);
    classic.set('components/po/control.css', rule);
    expect(textFindings(classic)).toEqual([
      expect.stringMatching(/^components\/po\/po-list\.css:\d+: differs/),
    ]);
    expect(newFileFindings(classic)).toEqual([
      'components/po/control.css: a new Classic stylesheet (outside styles/liquid-glass; main has no such file)',
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
