import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * C15: one Node.js major for the production web runtime, CI and dev machines.
 *
 * WHAT WAS WRONG (2026-10-24): four pins named three majors. The Vercel
 * project runs Node.js 24.x (Project Settings > Build and Deployment >
 * Node.js Version, read with a read-only `vercel project inspect`). CI's
 * actions/setup-node steps asked for 22. `.nvmrc` said 20.11.0, a release of
 * a line that left upstream support in April 2026 and got none of the July
 * 2026 security fixes, and the root engines field said >=20.11.0. So
 * `nvm use` put a developer on an end-of-life Node, and CI tested on a
 * different major from the one serving production.
 *
 * WHAT HOLDS IT NOW: `.nvmrc` and the root engines field name the production
 * major, and every actions/setup-node step in every workflow reads `.nvmrc`
 * (or names the same major). apps/web, the Vercel project's root directory,
 * must not grow an engines field that disagrees: Vercel takes engines.node
 * from the package.json closest to the build directory over the project
 * setting (@vercel/build-utils getNodeVersion), while the root package.json
 * is never consulted for it.
 *
 * Deliberately NOT here: the phone build. EAS builds use the "node" of each
 * build profile in apps/mobile/eas.json (22.19.0 since Expo's prebuild
 * crashed on Node 20), and that pin moves only with an EAS build that proves
 * it. pnpm only warns when a running Node is outside the engines range
 * (no engine-strict here), so EAS installs keep working.
 *
 * The docs are held to the same major. Nothing in the repo can see the Vercel
 * setting itself, so the one drift no pin catches is someone moving it by hand
 * because a doc told them to expect another major. The 2026-08-07 security
 * reports said to check for a "current nodejs22.x runtime". A doc may keep an
 * older runtime only as history, under a later dated "Updated <date>" note
 * in the same table cell or line that names the production major.
 *
 * IF THIS FAILS after Vercel's Node.js Version setting moved to a new major:
 * change PRODUCTION_NODE_MAJOR, `.nvmrc` and the root engines field together.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

// The Node.js major the Vercel project runs in production (its Node.js Version
// setting reads 24.x). Nothing in the repo selects it; this mirrors it.
const PRODUCTION_NODE_MAJOR = 24;

type PackageJson = { engines?: { node?: string } };

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as PackageJson;
}

/** The major of a version or simple range (`24`, `v24.11.0`, `'24.x'`, `>=24`), else NaN. */
function majorOf(spec: string): number {
  const m = /^['"]?(?:v|>=|\^|~)?(\d+)(?:\.(?:\d+|x)){0,2}['"]?$/.exec(spec.trim());
  return m ? Number(m[1]) : Number.NaN;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

type SetupNodeStep = { line: number; nodeVersion?: string; nodeVersionFile?: string };

/**
 * Every `uses: actions/setup-node@...` step in a workflow, with the
 * node-version / node-version-file it passes. A step runs from its `- ` line
 * to the next line at or left of that dash, so keys before or after `uses:`
 * are both found.
 */
function setupNodeSteps(text: string): SetupNodeStep[] {
  const lines = text.split('\n');
  const at = (n: number): string => lines[n] ?? '';
  const isDashLine = (s: string): boolean => /^\s*-\s/.test(s);
  const steps: SetupNodeStep[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*(?:-\s+)?uses:\s*['"]?actions\/setup-node@/.test(line)) return;

    // The step's own `- ` line: this one, or the nearest one above that sits
    // left of `uses:`. Its column bounds the step.
    const usesIndent = indentOf(line);
    let start = i;
    while (
      start >= 0 &&
      !(isDashLine(at(start)) && (start === i || indentOf(at(start)) < usesIndent))
    ) {
      start -= 1;
    }
    const dashCol = start >= 0 ? indentOf(at(start)) : usesIndent - 2;
    if (start < 0) start = i;

    let end = i + 1;
    while (end < lines.length) {
      const next = at(end).trim();
      if (next !== '' && !next.startsWith('#') && indentOf(at(end)) <= dashCol) break;
      end += 1;
    }

    const step: SetupNodeStep = { line: i + 1 };
    for (const stepLine of lines.slice(start, end)) {
      const file = /^\s*node-version-file:\s*([^#\s]+)/.exec(stepLine)?.[1];
      const version = /^\s*node-version:\s*([^#\s]+)/.exec(stepLine)?.[1];
      if (file !== undefined) step.nodeVersionFile = file.replace(/^['"]|['"]$/g, '');
      if (version !== undefined) step.nodeVersion = version;
    }
    steps.push(step);
  });
  return steps;
}

// How docs name the Node.js runtime Vercel runs: its runtime id (`nodejs22.x`)
// or a major followed by "runtime" (`a current 22.x runtime`).
const RUNTIME_MENTION = /\bnodejs(\d+)\.x\b|\b(\d+)\.x runtime\b/gi;
// A dated note that supersedes what comes before it in its cell or line.
const DATED_UPDATE = /\bUpdated \d{4}-\d{2}-\d{2}\b/g;

function runtimeMajors(text: string): number[] {
  return [...text.matchAll(RUNTIME_MENTION)].map((m) => Number(m[1] ?? m[2]));
}

type StaleMention = { line: number; text: string };

/**
 * Markdown table cells (or whole lines, outside a table) that name a Vercel
 * Node.js runtime other than `major` without a later dated note. Such a
 * segment passes only when the text after its last `Updated <date>` names
 * `<major>.x` (or `nodejs<major>.x`) and no other runtime, so the old wording
 * reads as history.
 */
function staleRuntimeMentions(markdown: string, major: number): StaleMention[] {
  // `\b24` alone misses `nodejs24.x`: there is no word boundary inside it.
  const current = new RegExp(`(?:\\bnodejs|\\b)${major}\\.x\\b`, 'i');
  const out: StaleMention[] = [];
  markdown.split('\n').forEach((line, i) => {
    // A table row is split on its unescaped pipes, so one cell's note never
    // covers another cell.
    const segments = line.trimStart().startsWith('|') ? line.split(/(?<!\\)\|/) : [line];
    for (const segment of segments) {
      if (runtimeMajors(segment).every((m) => m === major)) continue;
      const lastUpdate = [...segment.matchAll(DATED_UPDATE)].at(-1);
      const after = lastUpdate ? segment.slice(lastUpdate.index) : '';
      const superseded = current.test(after) && runtimeMajors(after).every((m) => m === major);
      if (!superseded) out.push({ line: i + 1, text: segment.trim() });
    }
  });
  return out;
}

describe('staleRuntimeMentions (the doc check reads cells and dated notes)', () => {
  it('flags each cell that names another runtime and has no dated note', () => {
    const md = '| Node | Vercel runtime (nodejs22.x) | spot-check a current 22.x runtime |';
    expect(staleRuntimeMentions(md, 24)).toEqual([
      { line: 1, text: 'Vercel runtime (nodejs22.x)' },
      { line: 1, text: 'spot-check a current 22.x runtime' },
    ]);
  });

  it('keeps older wording as history under a later dated note that names the major', () => {
    const md = [
      '| Node | Vercel runtime (nodejs22.x). Updated 2026-10-25: the setting reads 24.x |',
      '3. Check for a current nodejs22.x runtime. Updated 2026-10-25: expect 24.x instead.',
      '| Vercel runtime | nodejs24.x |',
      // The note may name the major by its runtime id too.
      '| Vercel runtime (nodejs22.x). Updated 2026-10-25: it reads nodejs24.x |',
    ].join('\n');
    expect(staleRuntimeMentions(md, 24)).toEqual([]);
  });

  it("never lets one cell's note cover another cell", () => {
    const md = '| Vercel runtime (nodejs22.x) | Updated 2026-10-25: reads 24.x |';
    expect(staleRuntimeMentions(md, 24)).toEqual([
      { line: 1, text: 'Vercel runtime (nodejs22.x)' },
    ]);
  });

  it('flags a note that names no major, or another runtime after its date', () => {
    const md = [
      '3. Check for a current 22.x runtime. Updated 2026-10-25: see section 3.',
      '3. Upgrade Node. Updated 2026-10-25: expect 24.x, then a nodejs22.x runtime.',
    ].join('\n');
    expect(staleRuntimeMentions(md, 24).map((s) => s.line)).toEqual([1, 2]);
  });
});

describe('setupNodeSteps (the guard reads each step whole)', () => {
  it('reads node-version under with:, after uses:', () => {
    const yml = [
      'steps:',
      '  - uses: actions/setup-node@v7',
      '    with:',
      "      node-version: '22'",
      '      cache: pnpm',
    ].join('\n');
    expect(setupNodeSteps(yml)).toEqual([{ line: 2, nodeVersion: "'22'" }]);
    expect(majorOf("'22'")).toBe(22);
  });

  it('reads keys written before uses: in the same step', () => {
    const yml = [
      'steps:',
      '  - name: Set up Node',
      '    with:',
      '      node-version-file: ./.nvmrc',
      '    uses: actions/setup-node@v7',
    ].join('\n');
    expect(setupNodeSteps(yml)).toEqual([{ line: 5, nodeVersionFile: './.nvmrc' }]);
  });

  it("never lends one step's version to the step before it", () => {
    const yml = [
      'steps:',
      '  - uses: actions/setup-node@v7',
      '  - name: Other',
      '    uses: actions/setup-node@v7',
      '    with:',
      '      node-version: 24 # trailing comment',
    ].join('\n');
    expect(setupNodeSteps(yml)).toEqual([{ line: 2 }, { line: 4, nodeVersion: '24' }]);
  });

  it('reads a version, a .x range and a floor, and nothing else', () => {
    expect(['24', 'v24.11.0', '24.x', '>=24', '"24"'].map(majorOf)).toEqual([24, 24, 24, 24, 24]);
    expect(['lts/*', '${{ matrix.node }}', 'node'].map(majorOf)).toEqual([NaN, NaN, NaN]);
  });
});

describe('Node.js version pins', () => {
  it('.nvmrc names the production major', () => {
    const nvmrc = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim();
    expect(majorOf(nvmrc)).toBe(PRODUCTION_NODE_MAJOR);
  });

  it('the root engines field names the production major', () => {
    expect(readJson('package.json').engines?.node).toBe(`${PRODUCTION_NODE_MAJOR}.x`);
  });

  it('apps/web declares no Node engines that would override the Vercel setting', () => {
    expect([undefined, `${PRODUCTION_NODE_MAJOR}.x`]).toContain(
      readJson('apps/web/package.json').engines?.node,
    );
  });

  it('every actions/setup-node step in every workflow runs the production major', () => {
    const workflows = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
    const problems: string[] = [];
    let found = 0;

    for (const file of workflows) {
      const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      const steps = setupNodeSteps(text);
      // Parser sanity: every mention of the action is a step it understood.
      expect(steps.length, file).toBe(text.split('actions/setup-node@').length - 1);
      found += steps.length;

      for (const step of steps) {
        const where = `.github/workflows/${file}:${step.line}`;
        if (step.nodeVersion !== undefined) {
          // setup-node prefers node-version when both are given.
          if (majorOf(step.nodeVersion) !== PRODUCTION_NODE_MAJOR) {
            problems.push(`${where} asks for node-version ${step.nodeVersion}`);
          }
        } else if (step.nodeVersionFile !== undefined) {
          if (step.nodeVersionFile.replace(/^\.\//, '') !== '.nvmrc') {
            problems.push(`${where} reads ${step.nodeVersionFile}, not .nvmrc`);
          }
        } else {
          problems.push(`${where} pins no Node version, so the runner's default runs`);
        }
      }
    }

    // The workflows set up Node somewhere; finding none means the parser broke.
    expect(found).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('no doc tells a reader to expect another Vercel Node runtime', () => {
    // The repo's own Markdown at the root (README.md, DEPLOY.md, ...) and
    // everything under docs/, where the security reports live.
    const docs = [
      ...readdirSync(REPO_ROOT).filter((f) => f.endsWith('.md')),
      ...readdirSync(join(REPO_ROOT, 'docs'), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.md'))
        .map((f) => join('docs', f)),
    ];
    expect(docs).toContain(join('docs', 'security', 'current-threat-intelligence.md'));

    const problems = docs.flatMap((file) =>
      staleRuntimeMentions(readFileSync(join(REPO_ROOT, file), 'utf8'), PRODUCTION_NODE_MAJOR).map(
        (s) => `${file}:${s.line} ${s.text.slice(0, 160)}`,
      ),
    );
    expect(problems).toEqual([]);
  });
});
