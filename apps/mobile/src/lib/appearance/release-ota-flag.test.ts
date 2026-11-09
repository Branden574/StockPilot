import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GLASS_ROLLOUTS, parseRollout } from '@stockpilot/core';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The phone flag's home (RELEASE.md section 2 item 5; DECISIONS "RELEASE PREP
 * REVIEW" item 5, R-1 and R-2). EXPO_PUBLIC_LIQUID_GLASS is inlined into every
 * phone update, so `pnpm release:ota` takes it only from the command that runs
 * it, refuses any value but off, opt-in or default (unset and empty included),
 * refuses an .env.local that names it, and prints the value it publishes with.
 * Store and simulator builds take it from eas.json.
 *
 * The real script runs in a throwaway copy of the app folder with a stub
 * `pnpm` on PATH (it records its arguments and the flag it was given, and
 * exits 0), a stub scene guard and a FAKE .env.local with dummy values. No
 * eas-cli and no network: the stub stands in for every pnpm call.
 */
const MOBILE = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(MOBILE, 'scripts', 'release-ota.sh');

/** Dummy values only: the real .env.local is never read. */
const FAKE_ENV = [
  'EXPO_PUBLIC_SENTRY_DSN=https://dummy-key@sentry.example.test/1',
  'SENTRY_AUTH_TOKEN=dummy-token-not-a-secret',
  'SENTRY_ORG=dummy-org',
  'SENTRY_PROJECT=dummy-project',
  'EXPO_PUBLIC_SUPABASE_URL=https://dummy.example.test',
  '',
].join('\n');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** One line per pnpm call: its arguments, then the flag as it reached it. */
  calls: { args: string; flag: string }[];
  sceneRan: boolean;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(opts: { flag?: string; envLocal?: string }): Run {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-ota-flag-'));
  dirs.push(root);
  const app = path.join(root, 'apps', 'mobile');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'pnpm-calls.log');
  const sceneLog = path.join(root, 'scene.log');
  mkdirSync(path.join(app, 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(SCRIPT, path.join(app, 'scripts', 'release-ota.sh'));
  writeFileSync(
    path.join(app, 'scripts', 'refuse-uncommitted-scene.sh'),
    `#!/bin/bash\necho ran >> '${sceneLog}'\nexit 0\n`,
  );
  writeFileSync(path.join(app, '.env.local'), opts.envLocal ?? FAKE_ENV);
  writeFileSync(
    path.join(bin, 'pnpm'),
    [
      '#!/bin/bash',
      `printf 'ARGS %s\\n' "$*" >> '${log}'`,
      `printf 'FLAG %s\\n' "\${EXPO_PUBLIC_LIQUID_GLASS-<unset>}" >> '${log}'`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(bin, 'pnpm'), 0o755);

  // A minimal environment: nothing of the runner's own shell reaches the script.
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: root };
  if (opts.flag !== undefined) env.EXPO_PUBLIC_LIQUID_GLASS = opts.flag;
  const result = spawnSync(
    'bash',
    [path.join(app, 'scripts', 'release-ota.sh'), '-m', 'Fictional test update'],
    // Expo's types require NODE_ENV in ProcessEnv; the script never reads it.
    { env: env as NodeJS.ProcessEnv, encoding: 'utf8' },
  );

  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const calls: Run['calls'] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    calls.push({
      args: lines[i]!.replace(/^ARGS /, ''),
      flag: lines[i + 1]!.replace(/^FLAG /, ''),
    });
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    sceneRan: existsSync(sceneLog),
  };
}

const DUMMY_VALUES = ['dummy-key', 'dummy-token-not-a-secret', 'dummy-org', 'dummy-project'];
function expectNoEnvFileValue(r: Run) {
  for (const value of DUMMY_VALUES) {
    expect(r.stdout + r.stderr).not.toContain(value);
  }
}

describe('pnpm release:ota publishes with the Liquid Glass rollout the command names, and only that', () => {
  it('accepts exactly the values the app reads: off, opt-in and default', () => {
    expect([...GLASS_ROLLOUTS].sort()).toEqual(['default', 'off', 'opt-in']);
    for (const value of GLASS_ROLLOUTS) expect(parseRollout(value)).toBe(value);
  });

  it.each(['off', 'opt-in', 'default'])(
    '%s reaches eas update and the source map upload unchanged, and is printed',
    (flag) => {
      const r = run({ flag });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.sceneRan).toBe(true);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0]!.args).toBe(
        'dlx eas-cli@20.3.0 update --channel production --environment production --non-interactive -m Fictional test update',
      );
      expect(r.calls[1]!.args).toMatch(/^dlx @sentry\/cli sourcemaps upload /);
      for (const call of r.calls) expect(call.flag).toBe(flag);
      expect(r.stdout).toContain(
        `Liquid Glass rollout in this update: EXPO_PUBLIC_LIQUID_GLASS=${flag}\n`,
      );
      expect(r.stdout.indexOf('EXPO_PUBLIC_LIQUID_GLASS=')).toBeLessThan(
        r.stdout.indexOf('OTA published'),
      );
      expectNoEnvFileValue(r);
    },
  );

  it.each([
    ['unset', undefined, 'it is not set'],
    ['empty', '', 'it is empty'],
    ['bogus', 'on', "'on' is not one of them"],
    ['the stage 2 value 1', '1', "'1' is not one of them"],
    ['a capital letter', 'Default', "'Default' is not one of them"],
    ['a trailing space', 'default ', "'default ' is not one of them"],
  ] as const)('refuses %s before anything is published', (_name, flag, why) => {
    const r = run({ flag });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain('FATAL: name the Liquid Glass rollout this update ships with');
    expect(r.stderr).toContain(why);
    expect(r.stdout).not.toContain('Liquid Glass rollout in this update');
  });

  it.each([
    ['a plain line', 'EXPO_PUBLIC_LIQUID_GLASS=default'],
    ['an export line', 'export EXPO_PUBLIC_LIQUID_GLASS=off'],
    ['an indented line', '  EXPO_PUBLIC_LIQUID_GLASS="opt-in"'],
    ['an empty value', 'EXPO_PUBLIC_LIQUID_GLASS='],
  ])('refuses an .env.local that sets the name (%s), without printing the file', (_name, line) => {
    const r = run({ flag: 'default', envLocal: `${FAKE_ENV}${line}\n` });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toContain('FATAL: apps/mobile/.env.local sets EXPO_PUBLIC_LIQUID_GLASS.');
    expect(r.stdout).not.toContain('Liquid Glass rollout in this update');
    expectNoEnvFileValue(r);
  });

  it('lets a comment in .env.local mention the name, and an unrelated longer name pass', () => {
    const r = run({
      flag: 'opt-in',
      envLocal: `# EXPO_PUBLIC_LIQUID_GLASS=default comes from the command now\nEXPO_PUBLIC_LIQUID_GLASS_NOTE=x\n${FAKE_ENV}`,
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const call of r.calls) expect(call.flag).toBe('opt-in');
  });

  it('an .env.local that sets it some other way still cannot change the value that reaches eas update', () => {
    // A name the line check cannot see: set by a second file the env file loads.
    const root = mkdtempSync(path.join(os.tmpdir(), 'release-ota-flag-indirect-'));
    dirs.push(root);
    const more = path.join(root, 'more.env');
    writeFileSync(more, 'EXPO_PUBLIC_LIQUID_GLASS=default\n');
    const r = run({ flag: 'off', envLocal: `${FAKE_ENV}source '${more}'\n` });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(2);
    for (const call of r.calls) expect(call.flag).toBe('off');
    expect(r.stdout).toContain('EXPO_PUBLIC_LIQUID_GLASS=off\n');
  });

  it('checks the flag before the scene guard, the env file and eas-cli', () => {
    const r = run({});
    expect(r.sceneRan).toBe(false);
    const text = readFileSync(SCRIPT, 'utf8');
    const capture = text.indexOf('rollout="${EXPO_PUBLIC_LIQUID_GLASS-}"');
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(text.indexOf('\nbash scripts/refuse-uncommitted-scene.sh\n'));
    expect(capture).toBeLessThan(text.indexOf('source .env.local'));
    const reExport = text.indexOf('export EXPO_PUBLIC_LIQUID_GLASS="$rollout"');
    expect(reExport).toBeGreaterThan(text.indexOf('source .env.local'));
    expect(reExport).toBeLessThan(text.indexOf('eas-cli@'));
  });
});

describe('store and simulator builds embed default from eas.json', () => {
  const eas = JSON.parse(readFileSync(path.join(MOBILE, 'eas.json'), 'utf8')) as {
    build: Record<string, { env?: Record<string, string>; extends?: string }>;
  };

  it('build.production.env and build.simulator.env set EXPO_PUBLIC_LIQUID_GLASS=default', () => {
    expect(eas.build.production?.env?.EXPO_PUBLIC_LIQUID_GLASS).toBe('default');
    expect(eas.build.simulator?.env?.EXPO_PUBLIC_LIQUID_GLASS).toBe('default');
    expect(eas.build['simulator-ota-test']?.extends).toBe('simulator');
  });
});
