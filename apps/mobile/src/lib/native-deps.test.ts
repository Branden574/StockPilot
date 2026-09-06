import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE DEPENDENCY NOBODY REVERTS.
 *
 * A `react-native-*` package is not inert weight the way a pure-JS dependency
 * is. Every one of them ships a podspec / Gradle module, so RN + Expo
 * AUTOLINKING compiles it into the next binary whether or not a single line of
 * JS ever imports it. It costs binary size, it widens the native build surface
 * (one more place for an Xcode/Gradle toolchain pin to break — see
 * reference_eas_build_xcode26_sharp_gotchas), and nothing in the JS world ever
 * complains, because from JS's point of view an unimported package is simply
 * absent.
 *
 * That is exactly how the hands-free size-count revert leaked. #172 added
 * react-native-vision-camera, react-native-vision-camera-worklets,
 * react-native-nitro-image and react-native-nitro-modules in ONE hunk; the
 * revert #177 removed only the two vision-camera lines. The Nitro pair — which
 * existed solely as vision-camera's peer, and which no commit in this repo has
 * ever imported from JS — stayed in package.json, stayed in the lockfile, and
 * stayed in ios/Podfile.lock, ready to be linked into every future build. The
 * whole mobile suite was green throughout, because no test in the repo had an
 * opinion about what is in `dependencies`.
 *
 * So this test gives one. Every direct `react-native-*` dependency must either
 * be REFERENCED by the app's own non-test source (src/, app/, plugins/,
 * scripts/, the config files), or appear in AUTOLINK_ONLY below with a written
 * reason. Adding a native package you never import now costs one line of
 * justification instead of shipping silently.
 *
 * Deliberately: *.test.ts files do NOT count as a reference. A native module
 * that only tests mention is dead weight in the binary — the precise failure
 * mode this pins.
 */

// `new URL(..., import.meta.url)` typechecks against the DOM URL under this
// app's lib settings, which is not assignable to node:url's — resolve from the
// file path string instead. src/lib -> apps/mobile.
const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Native packages with no direct import ON PURPOSE. Each is a PEER of a
 * package we DO use (verified with `pnpm why`), pulled in so autolinking finds
 * a real version rather than resolving it from a transitive nest. Removing one
 * breaks navigation/animation at runtime, not at build time — hence the note.
 */
const AUTOLINK_ONLY: Record<string, string> = {
  // peer of expo-router (via react-native-drawer-layout) — drives every
  // navigator animation. Also the package Babel's worklets plugin targets.
  'react-native-reanimated': 'peer of expo-router / react-native-drawer-layout',
  // peer of expo-router — the native screen container behind every route.
  'react-native-screens': 'peer of expo-router',
  // peer of react-native-reanimated and @expo/ui — the worklet runtime.
  'react-native-worklets': 'peer of react-native-reanimated / @expo/ui',
};

/** Directories and files that count as "the app's own source". */
const SOURCE_ROOTS = ['src', 'app', 'plugins', 'scripts'];
const SOURCE_FILES = ['app.config.ts', 'metro.config.js', 'babel.config.js'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function collectSourceFiles(): string[] {
  const found: string[] = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // an optional root (scripts/) may not exist
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // A test file is NOT a reference: see the header comment.
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(entry))) found.push(full);
    }
  };

  for (const root of SOURCE_ROOTS) walk(path.join(MOBILE_ROOT, root));
  for (const file of SOURCE_FILES) {
    const full = path.join(MOBILE_ROOT, file);
    try {
      if (statSync(full).isFile()) found.push(full);
    } catch {
      /* optional */
    }
  }
  return found;
}

function readPackageJson(): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(MOBILE_ROOT, 'package.json'), 'utf8'));
}

describe('apps/mobile/package.json — native dependencies must be justified', () => {
  const deps = Object.keys(readPackageJson().dependencies ?? {});
  const nativeDeps = deps.filter(
    (name) => name.startsWith('react-native-') && !AUTOLINK_ONLY[name],
  );
  const sources = collectSourceFiles();

  it('scans a real corpus (guards against a walker that silently finds nothing)', () => {
    // Without this, a broken walk would make every dependency look "unused" —
    // or, worse, a broken *filter* would make every dependency look fine.
    expect(sources.length).toBeGreaterThan(100);
    expect(nativeDeps.length).toBeGreaterThan(0);
  });

  it.each(nativeDeps)('%s is imported by the app, not just linked into it', (name) => {
    // Trailing guard so `react-native-svg` is not "found" by a file that only
    // mentions `react-native-svg-charts`.
    const reference = new RegExp(
      `${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`,
    );
    const referencedBy = sources.filter((file) =>
      reference.test(readFileSync(file, 'utf8')),
    );

    expect(
      referencedBy.length,
      `"${name}" is a direct dependency of apps/mobile but nothing under ` +
        `src/, app/, plugins/, scripts/ or the config files imports it. ` +
        `Autolinking will still compile it into the next binary. Either ` +
        `delete it from package.json, or add it to AUTOLINK_ONLY in this ` +
        `file with the reason it must stay.`,
    ).toBeGreaterThan(0);
  });

  it('keeps the packages the app actually depends on', () => {
    // The cheap way to "fix" the assertion above is to delete a dependency the
    // app really needs, so pin the ones with live import sites.
    expect(deps).toContain('react-native-document-scanner-plugin'); // document-scanner.ts
    expect(deps).toContain('react-native-gesture-handler'); // app/_layout.tsx
    expect(deps).toContain('react-native-safe-area-context');
    expect(deps).toContain('react-native-svg');
    expect(deps).toContain('react-native-url-polyfill'); // lib/supabase.ts
    expect(deps).toContain('react-native-webview'); // app/zendesk/web.tsx
    for (const name of Object.keys(AUTOLINK_ONLY)) expect(deps).toContain(name);
  });
});
