import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The web type check and the web build run with an explicit Node heap size.
 *
 * `tsc --noEmit` over apps/web holds about 4.1 GB of heap on a cold run
 * (6431 files, 1.5 million types; tsc --extendedDiagnostics, 2026-11-16).
 * Node's own default heap limit is about 4.1 GB on a machine with 16 GB or
 * more, and about half that with 8 GB. `next build` runs the same check in a
 * worker that takes its heap size from NODE_OPTIONS (next/dist/build/
 * type-check.js starts it with isolatedMemory: false, and
 * next/dist/lib/worker.js passes the parent's --max-old-space-size on).
 *
 * So both scripts set `NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}"`
 * on the command that runs the check:
 *   - CI (`pnpm typecheck`, `pnpm build`, through turbo) and the production
 *     build (Vercel runs `turbo run build`, which runs this build script) both
 *     run these scripts, so they get the same heap as a local run.
 *   - Flags a caller already put in NODE_OPTIONS are kept. When the caller also
 *     names a heap size, the caller's comes later in the string and Node uses
 *     the last one, so an explicit choice by the caller wins.
 *   - The size stays at or under 6144 MB: the smallest Vercel build machine
 *     has 8 GB, shared by the main build process, the type check worker and
 *     Turbopack's own memory. A heap larger than the machine can hold gets the
 *     build killed by the machine instead of stopped by Node.
 *
 * The scripts are compared with the constants below character for character.
 * The behaviour checks run command lines built from these constants only,
 * never from text read out of package.json.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

/** At least this much heap (MB) for the web type check. */
const MIN_HEAP_MB = 6144;
/** At most this much: 8 GB build machine, less 2 GB for everything else in the build. */
const MAX_HEAP_MB = 6144;

/** The assignment both scripts put in front of the program that runs the check. */
const HEAP_ASSIGNMENT = 'NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}"';

const TYPECHECK_SCRIPT = 'NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}" tsc --noEmit';
const BUILD_SCRIPT =
  'node ./scripts/copy-maplibre-worker.mjs && NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}" next build';

const EXPECTED = [
  { script: 'typecheck', text: TYPECHECK_SCRIPT, program: 'tsc --noEmit' },
  { script: 'build', text: BUILD_SCRIPT, program: 'next build' },
] as const;

function webScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/web/package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/**
 * What is wrong with `script` as a way to run `program` with the heap: the
 * program's own `&&` part must be NODE_OPTIONS="..." then the program, the
 * value must name one heap size in [MIN_HEAP_MB, MAX_HEAP_MB] and end with the
 * caller's ${NODE_OPTIONS:-}. Text only: nothing is run.
 */
function heapProblems(script: string, program: string): string[] {
  const parts = script.split('&&').map((part) => part.trim());
  const part = parts.find((p) => p === program || p.endsWith(` ${program}`));
  if (part === undefined) return [`no part runs ${program}`];
  const match = /^NODE_OPTIONS="([^"]*)" (.+)$/.exec(part);
  if (!match) return [`${program} has no NODE_OPTIONS="..." in front of it`];
  if (match[2] !== program) return [`NODE_OPTIONS is followed by "${match[2]}", not ${program}`];
  const value = match[1] ?? '';
  const problems: string[] = [];
  const sizes = [...value.matchAll(/--max[-_]old[-_]space[-_]size=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  if (sizes.length !== 1) problems.push(`${sizes.length} heap sizes`);
  for (const size of sizes) {
    if (size < MIN_HEAP_MB) problems.push(`heap ${size} MB is under ${MIN_HEAP_MB}`);
    if (size > MAX_HEAP_MB) problems.push(`heap ${size} MB is over ${MAX_HEAP_MB}`);
  }
  if (!value.endsWith(' ${NODE_OPTIONS:-}')) {
    problems.push("the caller's ${NODE_OPTIONS:-} is not last");
  }
  return problems;
}

// Prints [heap limit in MB, NODE_OPTIONS] of the node it runs in.
const PRINT = `JSON.stringify([Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576), process.env.NODE_OPTIONS])`;

/** PATH, NODE_ENV and the caller's NODE_OPTIONS; nothing else from this process. */
function childEnv(callerNodeOptions: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH };
  if (callerNodeOptions !== undefined) env.NODE_OPTIONS = callerNodeOptions;
  return env;
}

/**
 * Runs `HEAP_ASSIGNMENT "$0" -p "<PRINT>"` in sh, $0 being this node, so the
 * shell expands ${NODE_OPTIONS:-} the way it does in the scripts.
 */
function throughAssignment(callerNodeOptions: string | undefined): [number, string] {
  const line = `${HEAP_ASSIGNMENT} "$0" -p "${PRINT}"`;
  const out = execFileSync('sh', ['-c', line, process.execPath], {
    env: childEnv(callerNodeOptions),
    encoding: 'utf8',
  });
  return JSON.parse(out) as [number, string];
}

/** Runs this node with NODE_OPTIONS set as given, no shell. */
function direct(nodeOptions: string): [number, string] {
  const out = execFileSync(process.execPath, ['-p', PRINT], {
    env: childEnv(nodeOptions),
    encoding: 'utf8',
  });
  return JSON.parse(out) as [number, string];
}

describe('apps/web type check and build heap size', () => {
  const scripts = webScripts();

  it('the constants hold the assignment in front of each program', () => {
    expect(TYPECHECK_SCRIPT).toBe(`${HEAP_ASSIGNMENT} tsc --noEmit`);
    expect(BUILD_SCRIPT).toBe(
      `node ./scripts/copy-maplibre-worker.mjs && ${HEAP_ASSIGNMENT} next build`,
    );
  });

  for (const { script, text, program } of EXPECTED) {
    it(`scripts.${script} is exactly the expected text`, () => {
      expect(scripts[script]).toBe(text);
    });

    it(`the expected scripts.${script} runs ${program} with a heap of at least ${MIN_HEAP_MB} MB`, () => {
      expect(heapProblems(text, program)).toEqual([]);
    });
  }

  it('control: the text check refuses scripts without the heap, with a wrong size or order', () => {
    const plants: Array<[string, string]> = [
      ['tsc --noEmit', 'tsc --noEmit'],
      ['NODE_OPTIONS="--max-old-space-size=4096 ${NODE_OPTIONS:-}" tsc --noEmit', 'tsc --noEmit'],
      ['NODE_OPTIONS="--max-old-space-size=8192 ${NODE_OPTIONS:-}" tsc --noEmit', 'tsc --noEmit'],
      ['NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=6144" tsc --noEmit', 'tsc --noEmit'],
      ['NODE_OPTIONS="--max-old-space-size=6144" tsc --noEmit', 'tsc --noEmit'],
      [
        'tsc --noEmit && NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}" true',
        'tsc --noEmit',
      ],
      [
        'node ./scripts/copy-maplibre-worker.mjs && next build && NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}" true',
        'next build',
      ],
      [
        'NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}" node ./scripts/copy-maplibre-worker.mjs && next build',
        'next build',
      ],
    ];
    for (const [plant, program] of plants) {
      expect(heapProblems(plant, program), plant).not.toEqual([]);
    }
  });

  it('gives node the heap when the caller sets no NODE_OPTIONS', () => {
    const [limit, options] = throughAssignment(undefined);
    // heap_size_limit adds the young generation (a few dozen MB) to the old space.
    expect(limit).toBeGreaterThanOrEqual(MIN_HEAP_MB);
    expect(limit).toBeLessThan(MAX_HEAP_MB + 256);
    expect(options.trim()).toBe(`--max-old-space-size=${MIN_HEAP_MB}`);
  });

  it("keeps the caller's other flags, after the heap", () => {
    const [limit, options] = throughAssignment('--no-deprecation');
    expect(options).toBe(`--max-old-space-size=${MIN_HEAP_MB} --no-deprecation`);
    expect(limit).toBeGreaterThanOrEqual(MIN_HEAP_MB);
    expect(limit).toBeLessThan(MAX_HEAP_MB + 256);
  });

  it("uses the caller's heap size when the caller names one", () => {
    const [limit, options] = throughAssignment('--max-old-space-size=5000');
    expect(options).toBe(`--max-old-space-size=${MIN_HEAP_MB} --max-old-space-size=5000`);
    expect(limit).toBeGreaterThanOrEqual(5000);
    expect(limit).toBeLessThan(5000 + 256);
  });

  it('node uses the last of two heap sizes in NODE_OPTIONS (no shell)', () => {
    expect(direct('--max-old-space-size=6144 --max-old-space-size=5000')[0]).toBeLessThan(5256);
    expect(direct('--max-old-space-size=5000 --max-old-space-size=6144')[0]).toBeGreaterThanOrEqual(
      6144,
    );
  });
});
