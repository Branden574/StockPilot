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
 * So both scripts set `NODE_OPTIONS="--max-old-space-size=<n> ${NODE_OPTIONS:-}"`
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
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

/** At least this much heap (MB) for the web type check. */
const MIN_HEAP_MB = 6144;
/** At most this much: 8 GB build machine, less 2 GB for everything else in the build. */
const MAX_HEAP_MB = 6144;

/** The command in each script that runs the type check. */
const CHECKED = [
  { script: 'typecheck', program: 'tsc --noEmit' },
  { script: 'build', program: 'next build' },
] as const;

const ASSIGNMENT = /^NODE_OPTIONS="([^"]*)"\s+/;

function webScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/web/package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/** The `&&` part of a script that runs `program`. */
function commandOf(script: string, program: string): string | undefined {
  return script
    .split('&&')
    .map((part) => part.trim())
    .find((part) => part === program || part.endsWith(` ${program}`));
}

/** Runs the command's own NODE_OPTIONS assignment with `program` swapped for `instead`. */
function runWithAssignment(
  command: string,
  program: string,
  instead: string,
  callerNodeOptions: string | undefined,
): string {
  // PATH and the caller's NODE_OPTIONS, and nothing else from this process.
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH };
  if (callerNodeOptions !== undefined) env.NODE_OPTIONS = callerNodeOptions;
  const line = `${command.slice(0, command.length - program.length)}${instead}`;
  return execFileSync('sh', ['-c', line], { env, encoding: 'utf8' }).trim();
}

const HEAP_LIMIT = `node -p "Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)"`;

describe('apps/web type check and build heap size', () => {
  const scripts = webScripts();

  for (const { script, program } of CHECKED) {
    describe(`scripts.${script}`, () => {
      const command = commandOf(scripts[script] ?? '', program);

      it(`runs ${program} with NODE_OPTIONS naming a heap of ${MIN_HEAP_MB} MB, ahead of the caller's NODE_OPTIONS`, () => {
        expect(command, `apps/web/package.json scripts.${script} runs ${program}`).toBeDefined();
        const value = ASSIGNMENT.exec(command ?? '')?.[1];
        expect(value, `${program} is preceded by NODE_OPTIONS="..."`).toBeDefined();
        const sizes = [...(value ?? '').matchAll(/--max[-_]old[-_]space[-_]size=(\d+)/g)].map((m) =>
          Number(m[1]),
        );
        expect(sizes).toHaveLength(1);
        expect(sizes[0]).toBeGreaterThanOrEqual(MIN_HEAP_MB);
        expect(sizes[0]).toBeLessThanOrEqual(MAX_HEAP_MB);
        // The caller's own flags come after ours, so they are kept and theirs win.
        expect(value?.trimEnd().endsWith('${NODE_OPTIONS:-}')).toBe(true);
      });

      it('gives node that heap when the caller sets no NODE_OPTIONS', () => {
        const limit = Number(runWithAssignment(command ?? '', program, HEAP_LIMIT, undefined));
        // heap_size_limit adds the young generation (a few dozen MB) to the old space.
        expect(limit).toBeGreaterThanOrEqual(MIN_HEAP_MB);
        expect(limit).toBeLessThan(MAX_HEAP_MB + 256);
      });

      it("keeps the caller's other flags and gives node the same heap", () => {
        const options = runWithAssignment(
          command ?? '',
          program,
          'printenv NODE_OPTIONS',
          '--no-deprecation',
        );
        expect(options.split(/\s+/)).toEqual([
          `--max-old-space-size=${MIN_HEAP_MB}`,
          '--no-deprecation',
        ]);
        const limit = Number(
          runWithAssignment(command ?? '', program, HEAP_LIMIT, '--no-deprecation'),
        );
        expect(limit).toBeGreaterThanOrEqual(MIN_HEAP_MB);
        expect(limit).toBeLessThan(MAX_HEAP_MB + 256);
      });

      it("uses the caller's heap size when the caller names one", () => {
        const limit = Number(
          runWithAssignment(command ?? '', program, HEAP_LIMIT, '--max-old-space-size=5000'),
        );
        expect(limit).toBeGreaterThanOrEqual(5000);
        expect(limit).toBeLessThan(5000 + 256);
      });
    });
  }
});
