import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { REPO_ROOT, SCENE_OUTPUTS } from '../../../../../../scripts/liquid-glass/install-scene.mjs';

vi.mock('react-native', () => ({}));

/**
 * The phone's scene photos (FOLLOWUPS SC1, standing rule): the repository is
 * public and the photos' source is not confirmed, so they are never
 * committed. scripts/liquid-glass/install-scene.mjs writes the pre-blurred
 * phone copies into apps/mobile/assets/liquid-glass/ (git-ignored), and the
 * app loads them from exactly there through OPTIONAL requires: Metro (Expo
 * sets allowOptionalDependencies) bundles a require inside a try block even
 * when the file is missing, and it throws at run time instead, so a checkout
 * without the photos (CI, any clone) builds and draws the opaque --bg, as
 * before.
 */
const HERE = __dirname;
const SOURCE = readFileSync(path.join(HERE, 'scene-assets.ts'), 'utf8');
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LIGHT = '../../../../assets/liquid-glass/scene-light.jpg';
const DARK = '../../../../assets/liquid-glass/scene-dark.jpg';

/**
 * Metro as this app runs it: the app's own metro.config.js (Expo's config,
 * wrapped by Sentry's) and the Metro its Expo resolves, whose
 * collectDependencies decides at build time which requires may stay
 * unresolved (`isOptional`); buildSubgraph drops an optional one it cannot
 * resolve instead of failing the build.
 */
function appMetro() {
  const mobileRoot = path.resolve(HERE, '../../../..');
  const fromApp = createRequire(path.join(mobileRoot, 'package.json'));
  const config = fromApp('./metro.config.js') as {
    transformer: {
      allowOptionalDependencies: boolean;
      asyncRequireModulePath: string;
      unstable_allowRequireContext: boolean;
    };
  };
  const fromExpo = createRequire(fromApp.resolve('expo/package.json'));
  const fromMetroConfig = createRequire(fromExpo.resolve('@expo/metro-config/package.json'));
  const fromMetro = createRequire(fromMetroConfig.resolve('metro/package.json'));
  const collectDependencies = fromMetro('metro/private/ModuleGraph/worker/collectDependencies')
    .default as (
    ast: unknown,
    options: Record<string, unknown>,
  ) => { dependencies: { name: string; data: { isOptional?: boolean } }[] };
  const parser = fromMetro('@babel/parser') as {
    parse(code: string, options: Record<string, unknown>): unknown;
  };
  return { config, collectDependencies, parser };
}

/** The requires Metro collects from this source, and whether each may stay unresolved. */
function metroDependencies(source: string): { name: string; optional: boolean }[] {
  const { config, collectDependencies, parser } = appMetro();
  // TypeScript removed as Expo's Babel transform removes it; requires kept.
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { dependencies } = collectDependencies(parser.parse(js, { sourceType: 'module' }), {
    asyncRequireModulePath: config.transformer.asyncRequireModulePath,
    allowOptionalDependencies: config.transformer.allowOptionalDependencies,
    unstable_allowRequireContext: config.transformer.unstable_allowRequireContext,
    dependencyMapName: null,
    dynamicRequires: 'reject',
    inlineableCalls: [],
    keepRequireNames: true,
  });
  return dependencies.map((d) => ({ name: d.name, optional: d.data.isOptional === true }));
}

/**
 * Runs scene-assets.ts with Metro's run-time `require` played by `load`: an
 * asset Metro bundled is its asset registry id (a number); an optional
 * dependency Metro could not resolve is serialized as a null module id, for
 * which metro-runtime's require throws "Cannot find module".
 */
function sceneImagesWith(load: (spec: string) => unknown): unknown {
  const js = ts.transpileModule(SOURCE, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(js, { module, exports: module.exports, require: load });
  return module.exports.SCENE_IMAGES;
}

const missing = (spec: string): never => {
  throw new Error(`Cannot find module '${spec}'`);
};

const phone = SCENE_OUTPUTS.filter((o) => o.app === 'phone');

describe('the phone scene photos', () => {
  it('are required from exactly the paths the install script writes, one optional require per scheme', () => {
    expect(phone.map((o) => o.scheme).sort()).toEqual(['dark', 'light']);
    for (const output of phone) {
      const rel = path.relative(HERE, path.join(REPO_ROOT, output.path)).split(path.sep).join('/');
      const call = `require('${rel}')`;
      expect(code, output.scheme).toContain(call);
      // Directly inside a try block (Metro's optional-dependency rule).
      const at = code.indexOf(call);
      const before = code.slice(0, at);
      expect(before.lastIndexOf('try {'), output.scheme).toBeGreaterThan(before.lastIndexOf('}'));
    }
    expect((code.match(/require\(/g) ?? []).length).toBe(phone.length);
  });

  it('are never committed: every phone path is ignored by git and not tracked', () => {
    for (const output of phone) {
      expect(() =>
        execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', output.path], {
          stdio: 'ignore',
        }),
      ).not.toThrow();
      const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', output.path], {
        encoding: 'utf8',
      });
      expect(tracked, output.path).toBe('');
    }
  });

  it('Metro, as this app configures it, takes both requires as optional: a bundle without the files builds', () => {
    expect(appMetro().config.transformer.allowOptionalDependencies).toBe(true);
    expect(metroDependencies(SOURCE)).toEqual([
      { name: LIGHT, optional: true },
      { name: DARK, optional: true },
    ]);
    // The check can fail: a require moved out of its try block is required,
    // and a bundle without the photo would not build.
    const outside = SOURCE.replace(
      /try \{\s*(day = require\([^)]*\)[^;]*;)\s*\} catch \{\s*day = null;\s*\}/,
      '$1',
    );
    expect(outside).not.toBe(SOURCE);
    expect(metroDependencies(outside)).toEqual([
      { name: LIGHT, optional: false },
      { name: DARK, optional: true },
    ]);
  });

  it('at run time: no files, no scene (SceneBackground draws the opaque --bg); files bundled, both drawn', () => {
    expect(sceneImagesWith(missing)).toEqual({ day: null, night: null });
    const ids: Record<string, number> = { [LIGHT]: 11, [DARK]: 12 };
    expect(sceneImagesWith((spec) => ids[spec] ?? missing(spec))).toEqual({ day: 11, night: 12 });
    // Each on its own: one file alone gives one scheme.
    expect(sceneImagesWith((spec) => (spec === DARK ? 12 : missing(spec)))).toEqual({
      day: null,
      night: 12,
    });
  });

  it('SceneBackground draws a photo only when the theme says so and the file is there', () => {
    const bg = readFileSync(path.join(HERE, 'scene-background.tsx'), 'utf8').replace(/\s+/g, ' ');
    expect(bg).toContain('const { scene, mode, c } = useTheme();');
    expect(bg).toContain(
      "const source = scene ? (mode === 'dark' ? SCENE_IMAGES.night : SCENE_IMAGES.day) : null;",
    );
    expect(bg).toContain('style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]}');
    expect(bg).toContain('{source ? (');
  });
});

describe('a phone update never ships them before the owner confirms where they came from (SC1)', () => {
  const MOBILE = path.resolve(HERE, '../../../..');
  const GUARD = path.join(MOBILE, 'scripts', 'refuse-unconfirmed-scene.sh');

  /** A throwaway app checkout (its own git repository) holding these files. */
  function checkout(files: { path: string; committed?: boolean }[]): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scene-guard-'));
    execFileSync('git', ['init', '-q', dir]);
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
      writeFileSync(path.join(dir, file.path), 'not a photo');
      if (file.committed) execFileSync('git', ['-C', dir, 'add', '--', file.path]);
    }
    return dir;
  }

  function guard(files: { path: string; committed?: boolean }[]) {
    const dir = checkout(files);
    try {
      return spawnSync('bash', [GUARD, dir], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('refuses while a scene photo is installed and not committed', () => {
    for (const name of ['scene-light.jpg', 'scene-dark.jpg']) {
      const result = guard([
        { path: 'assets/liquid-glass/scene-light.jpg', committed: name !== 'scene-light.jpg' },
        { path: 'assets/liquid-glass/scene-dark.jpg', committed: name !== 'scene-dark.jpg' },
      ]);
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toContain(
        `assets/liquid-glass/${name} is installed but not committed`,
      );
      expect(result.stderr, name).toContain('FOLLOWUPS SC1');
    }
  });

  it('lets an update go with no photo installed, or with the photos committed once SC1 is settled', () => {
    expect(guard([{ path: 'assets/other.png' }]).status).toBe(0);
    expect(
      guard([
        { path: 'assets/liquid-glass/scene-light.jpg', committed: true },
        { path: 'assets/liquid-glass/scene-dark.jpg', committed: true },
      ]).status,
    ).toBe(0);
  });

  it('both OTA scripts run it first, before the env file is loaded and before eas-cli publishes', () => {
    for (const script of ['release-ota.sh', 'release-ota-test.sh']) {
      const text = readFileSync(path.join(MOBILE, 'scripts', script), 'utf8');
      const check = text.indexOf('\nbash scripts/refuse-unconfirmed-scene.sh\n');
      expect(check, script).toBeGreaterThan(text.indexOf('set -euo pipefail'));
      expect(check, script).toBeLessThan(text.indexOf('source .env.local'));
      expect(check, script).toBeLessThan(text.indexOf('eas-cli@'));
    }
    // The paths it checks are the paths .gitignore keeps out of the repository.
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('\napps/mobile/assets/liquid-glass/scene-*\n');
    expect(readFileSync(GUARD, 'utf8')).toContain('for photo in assets/liquid-glass/scene-*; do');
  });
});
