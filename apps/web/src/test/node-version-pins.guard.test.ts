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
});
