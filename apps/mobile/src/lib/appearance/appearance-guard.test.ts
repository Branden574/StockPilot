import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source guards for the phone's appearance layer.
 *
 * 1. expo-glass-effect is loaded in ONE place (plan 5.5, review R21): its
 *    GlassView resolves the native view at module load, so any other import
 *    could crash a binary without the module. (The eslint rule says the same
 *    at lint time; this holds it in the test run too.)
 * 2. The appearance is presentation only (plan 2.3): no data layer, cache,
 *    query, signed URL, realtime channel or outbox reads it, so changing it
 *    can never refetch, re-sign, resubscribe or touch queued work.
 * 3. Only the screens that change the appearance and the crash notice read
 *    the appearance control (it changes with every sync status); the root
 *    gate reads the ready flag alone; every other component reads the look
 *    through useTheme() alone.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(MOBILE_ROOT, f).split(path.sep).join('/');
const code = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SOURCES = [
  ...walk(path.join(MOBILE_ROOT, 'app')),
  ...walk(path.join(MOBILE_ROOT, 'src')),
].filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${path.sep}__fixtures__${path.sep}`));

describe('appearance guards', () => {
  it('only src/lib/appearance/glass-module.ts loads expo-glass-effect', () => {
    const loaders = SOURCES.filter((f) => code(f).includes("'expo-glass-effect'")).map(rel);
    expect(loaders).toEqual(['src/lib/appearance/glass-module.ts']);
    const wrapper = code(path.join(MOBILE_ROOT, 'src/lib/appearance/glass-module.ts'));
    // Never statically: only the guarded, lazy require inside the loader.
    expect(wrapper).not.toMatch(/^import[^;]*'expo-glass-effect'/m);
    expect(wrapper).toContain("return require('expo-glass-effect');");
    expect(wrapper.indexOf("requireOptionalNativeModule('ExpoGlassEffect')")).toBeGreaterThan(-1);
  });

  it('the eslint rule forbids every other import of it', () => {
    const config = readFileSync(path.join(MOBILE_ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain('name: "expo-glass-effect"');
    expect(config).toContain('ignores: ["src/lib/appearance/glass-module.ts"]');
    expect(config).toContain(
      "CallExpression[callee.name='require'][arguments.0.value='expo-glass-effect']",
    );
  });

  it('no data, cache, sync or outbox module reads the appearance', () => {
    const allowed = new Set(['src/lib/theme.ts', 'src/lib/use-theme.ts']);
    const readers = SOURCES.map(rel)
      .filter((f) => f.startsWith('src/lib/') && !f.startsWith('src/lib/appearance/'))
      .filter((f) => !allowed.has(f))
      .filter((f) => /appearance/i.test(code(path.join(MOBILE_ROOT, f))));
    expect(readers).toEqual([]);
  });

  it('only the appearance screen, the Settings row and the crash notice read the control; the root reads ready alone', () => {
    const readers = SOURCES.filter((f) => /\buseAppearance\(\)/.test(code(f)))
      .map(rel)
      .filter((f) => !f.startsWith('src/lib/appearance/'))
      .sort();
    expect(readers).toEqual([
      'app/(drawer)/settings.tsx',
      'app/(drawer)/settings/appearance.tsx',
      'src/components/appearance-fallback-notice.tsx',
    ]);
    const ready = SOURCES.filter((f) => /\buseAppearanceReady\(\)/.test(code(f)))
      .map(rel)
      .filter((f) => !f.startsWith('src/lib/appearance/'));
    expect(ready).toEqual(['app/_layout.tsx']);
  });

  it('nothing keys a tree by the appearance (a key would remount screens, sheets and forms)', () => {
    for (const f of SOURCES) {
      const src = code(f);
      expect(src, rel(f)).not.toMatch(/key=\{\s*(?:appearance|material|theme)(?:\.\w+)?\s*\}/);
    }
  });
});
