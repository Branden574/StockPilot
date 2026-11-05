import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  REPO_ROOT,
  SCENE_MANIFEST,
  SCENE_OUTPUTS,
  checkScene,
  ignoredOutputs,
} from '../../../../../../scripts/liquid-glass/install-scene.mjs';

vi.mock('react-native', () => ({}));

/**
 * The phone's scene illustrations. They were made for StockPilot by Claude
 * Design during the Liquid Glass design work (confirmed 2026-11-05), and the
 * pre-blurred phone copies are committed in apps/mobile/assets/liquid-glass/
 * (scripts/liquid-glass/install-scene.mjs writes them and pins their SHA-256
 * in scripts/liquid-glass/scene-files.sha256). The app requires them with
 * plain requires, so Metro bundles both and a missing file fails the bundle
 * instead of leaving the scene off; both phone update scripts first refuse a
 * file that is missing or is not the committed, pinned one.
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
 * unresolved (`isOptional`); buildSubgraph fails the bundle on a required one
 * it cannot resolve.
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
 * asset Metro bundled is its asset registry id (a number).
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

describe('the phone scene illustrations', () => {
  it('are required from exactly the paths the install script writes, one plain require per scheme', () => {
    expect(phone.map((o) => o.scheme).sort()).toEqual(['dark', 'light']);
    for (const output of phone) {
      const rel = path.relative(HERE, path.join(REPO_ROOT, output.path)).split(path.sep).join('/');
      expect(code, output.scheme).toContain(`require('${rel}')`);
    }
    expect((code.match(/require\(/g) ?? []).length).toBe(phone.length);
    // Never inside a try block: a missing file must fail the bundle, not turn the scene off.
    expect(code).not.toMatch(/\btry\s*\{/u);
  });

  it('are committed: git tracks both, no .gitignore rule keeps one out, and each is the pre-blurred 1200x750 JPEG the manifest pins, with no metadata', async () => {
    const paths = phone.map((o) => o.path);
    expect(ignoredOutputs(REPO_ROOT, phone)).toEqual([]);
    const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...paths], {
      encoding: 'utf8',
    });
    expect(tracked.split('\n').filter(Boolean).sort()).toEqual([...paths].sort());
    expect(await checkScene({ app: 'phone', decode: false })).toEqual([]);
  });

  it('Metro, as this app configures it, takes both requires as required: a bundle without either file fails', () => {
    expect(metroDependencies(SOURCE)).toEqual([
      { name: LIGHT, optional: false },
      { name: DARK, optional: false },
    ]);
    // The check can fail: inside a try block (the form used while the files
    // were not committed) a require turns optional, and a bundle without the
    // file would build without the scene.
    const optional = SOURCE.replace(
      /const day = (require\([^)]*\)[^;]*);/u,
      'let day = null;\ntry {\n  day = $1;\n} catch {\n  day = null;\n}',
    );
    expect(optional).not.toBe(SOURCE);
    expect(metroDependencies(optional)).toEqual([
      { name: LIGHT, optional: true },
      { name: DARK, optional: false },
    ]);
  });

  it('at run time: both bundled, the day file for Day and the night file for Night; no silent fallback', () => {
    const ids: Record<string, number> = { [LIGHT]: 11, [DARK]: 12 };
    expect(sceneImagesWith((spec) => ids[spec] ?? missing(spec))).toEqual({ day: 11, night: 12 });
    expect(() => sceneImagesWith(missing)).toThrow(/Cannot find module/u);
  });

  it('SceneBackground draws one of them only when the theme says so: Day the day file, Night the night file', () => {
    const bg = readFileSync(path.join(HERE, 'scene-background.tsx'), 'utf8').replace(/\s+/g, ' ');
    expect(bg).toContain('const { scene, mode, c } = useTheme();');
    expect(bg).toContain(
      "const source = scene ? (mode === 'dark' ? SCENE_IMAGES.night : SCENE_IMAGES.day) : null;",
    );
    expect(bg).toContain('style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]}');
    expect(bg).toContain('{source ? (');
  });
});

describe('a phone update ships the scene only as the committed files the manifest pins', () => {
  const MOBILE = path.resolve(HERE, '../../../..');
  const GUARD = path.join(MOBILE, 'scripts', 'refuse-uncommitted-scene.sh');
  const FILES = ['assets/liquid-glass/scene-light.jpg', 'assets/liquid-glass/scene-dark.jpg'];
  const git = (dir: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=Scene Test',
        '-c',
        'user.email=scene@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { stdio: 'ignore' },
    );
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  /**
   * A throwaway app checkout (its own git repository) whose two scene files
   * and manifest are committed; `change` then alters the working tree.
   */
  function guard(change: (dir: string) => void = () => {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scene-guard-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      let manifest = '';
      for (const file of FILES) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), `the ${file}`);
        manifest += `${sha(`the ${file}`)}  ${file}\n`;
      }
      mkdirSync(path.join(dir, path.dirname(SCENE_MANIFEST)), { recursive: true });
      writeFileSync(path.join(dir, SCENE_MANIFEST), manifest);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'scene');
      change(dir);
      return spawnSync('bash', [GUARD, dir], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('lets an update go when both files are the committed, pinned ones', () => {
    const result = guard();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('refuses a missing file, a changed one, an uncommitted one, and one the manifest does not pin', () => {
    const cases: [string, (dir: string) => void, string][] = [
      ['missing', (dir) => rmSync(path.join(dir, FILES[0]!)), `${FILES[0]} is missing`],
      [
        'changed',
        (dir) => writeFileSync(path.join(dir, FILES[1]!), 'another picture'),
        `${FILES[1]} differs from the committed file`,
      ],
      [
        'uncommitted',
        (dir) => {
          // Still on disk, no longer in the commit.
          git(dir, 'rm', '-q', '--cached', '--', FILES[0]!);
          git(dir, 'commit', '-q', '-m', 'stop tracking the picture');
        },
        `${FILES[0]} is not committed`,
      ],
      [
        'unpinned',
        (dir) => {
          writeFileSync(path.join(dir, FILES[1]!), 'another picture');
          git(dir, 'commit', '-q', '-a', '-m', 'change the picture, not the manifest');
        },
        `${FILES[1]} is not the file scripts/liquid-glass/scene-files.sha256 pins`,
      ],
      [
        'no manifest',
        (dir) => rmSync(path.join(dir, SCENE_MANIFEST)),
        'scripts/liquid-glass/scene-files.sha256 is missing',
      ],
    ];
    for (const [name, change, message] of cases) {
      const result = guard(change);
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toContain(message);
    }
  });

  it('both OTA scripts run it first, before the env file is loaded and before eas-cli publishes', () => {
    for (const script of ['release-ota.sh', 'release-ota-test.sh']) {
      const text = readFileSync(path.join(MOBILE, 'scripts', script), 'utf8');
      const check = text.indexOf('\nbash scripts/refuse-uncommitted-scene.sh\n');
      expect(check, script).toBeGreaterThan(text.indexOf('set -euo pipefail'));
      expect(check, script).toBeLessThan(text.indexOf('source .env.local'));
      expect(check, script).toBeLessThan(text.indexOf('eas-cli@'));
    }
  });

  it('checks exactly the phone files install-scene.mjs writes, against its manifest', () => {
    const text = readFileSync(GUARD, 'utf8');
    expect(text).toContain('for name in scene-light.jpg scene-dark.jpg; do');
    expect(text).toContain('file="assets/liquid-glass/$name"');
    expect(phone.map((o) => path.relative(MOBILE, path.join(REPO_ROOT, o.path))).sort()).toEqual(
      [...FILES].sort(),
    );
    expect(text).toContain(`manifest="$top/${SCENE_MANIFEST}"`);
  });
});
