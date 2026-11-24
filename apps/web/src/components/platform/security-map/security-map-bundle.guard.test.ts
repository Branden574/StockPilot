// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THREE.JS STAYS IN THE ATTACK MAP'S LAZY ISLAND.
 *
 * `three` was approved for the globe only, loaded only where the globe is
 * shown. Pinned here, as imports, so no page's first bundle can grow:
 *   - `three` is imported by globe-renderer.ts and nothing else;
 *   - globe-renderer.ts is reached only through a dynamic import() in
 *     security-map-globe.tsx (a type-only import elsewhere brings no code);
 *   - the island's client (security-map-client.tsx, which renders the globe)
 *     is reached only through next/dynamic with ssr: false in
 *     security-map-island.tsx;
 *   - the island is rendered by the map's section alone.
 */

const SRC = join(__dirname, '..', '..', '..');
const DIR = 'components/platform/security-map';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * A module loaded for its effect alone: a bare import, an empty import or
 * re-export list, or a require() whose value is not kept.
 */
const EFFECT_ONLY = [
  /^import\s+['"][^'"]+['"];?\s*$/m,
  /^(?:import|export)\s*\{\s*\}\s*from\s+['"][^'"]+['"]/m,
  /^\s*require\(\s*['"][^'"]+['"]\s*\);?\s*$/m,
];

const files = sourceFiles(SRC).map((abs) => ({
  rel: relative(SRC, abs).split(sep).join('/'),
  text: readFileSync(abs, 'utf8'),
}));

/**
 * Every way a file can bring a module's code in without a dynamic import():
 * `import ... from`, a bare `import '...'`, `export ... from` (a re-export
 * loads the module too), and `require('...')`. `import type` and
 * `export type` bring no code and are left out.
 */
const STATIC_FORMS = [
  /^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms,
  /^import\s+['"]([^'"]+)['"]/gm,
  /^export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** The modules a file brings in statically, in any of the forms above. */
function staticSources(text: string): string[] {
  return STATIC_FORMS.flatMap((form) => [...text.matchAll(form)].map((m) => m[1]!));
}

/** Files with a static import, re-export or require whose source matches `from`. */
function staticImporters(from: RegExp): string[] {
  return files
    .filter(({ text }) => staticSources(text).some((source) => from.test(source)))
    .map((f) => f.rel)
    .sort();
}

/** Files that name the module in a dynamic import(). */
function dynamicImporters(from: RegExp): string[] {
  return files
    .filter(({ text }) =>
      [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].some((m) => from.test(m[1]!)),
    )
    .map((f) => f.rel)
    .sort();
}

describe("three.js stays in the attack map's lazy island", () => {
  it('the import check sees every static form, and not the type-only ones', () => {
    const forms = [
      "import * as THREE from 'three';",
      "import { WebGLRenderer } from 'three';",
      "import 'three';",
      "export { WebGLRenderer } from 'three';",
      "export * from 'three';",
      "export * as THREE from 'three';",
      "const THREE = require('three');",
      "import THREE = require('three');",
    ];
    for (const form of forms) expect(staticSources(form), form).toEqual(['three']);
    for (const form of [
      "import type { WebGLRenderer } from 'three';",
      "export type { X } from 'three';",
    ]) {
      expect(staticSources(form), form).toEqual([]);
    }
  });

  it('three is imported by the globe renderer and by nothing else', () => {
    expect(staticImporters(/^three(\/|$)/)).toEqual([`${DIR}/globe-renderer.ts`]);
    expect(dynamicImporters(/^three(\/|$)/)).toEqual([]);
  });

  it('the renderer is reached only by a dynamic import from the globe component', () => {
    expect(staticImporters(/(^|\/)globe-renderer$/)).toEqual([]);
    expect(dynamicImporters(/(^|\/)globe-renderer$/)).toEqual([`${DIR}/security-map-globe.tsx`]);
  });

  it("the island's client is reached only by next/dynamic, ssr: false, from the island", () => {
    expect(staticImporters(/(^|\/)security-map-client$/)).toEqual([]);
    expect(dynamicImporters(/(^|\/)security-map-client$/)).toEqual([
      `${DIR}/security-map-island.tsx`,
    ]);
    const island = files.find((f) => f.rel === `${DIR}/security-map-island.tsx`)!.text;
    expect(island.startsWith("'use client';")).toBe(true);
    // The code only, comments taken out: a comment that says "ssr: false"
    // proves nothing.
    const code = island.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(
      /dynamic\(\s*\(\) =>\s*import\('\.\/security-map-client'\)\.then\(\(m\) => m\.SecurityMapClient\),\s*\{\s*ssr: false,/,
    );
    expect(code.match(/\bssr:/g)).toHaveLength(1);
  });

  it('the globe component, the client and the island are client modules', () => {
    for (const name of [
      'security-map-globe.tsx',
      'security-map-client.tsx',
      'security-map-flat.tsx',
    ]) {
      const text = files.find((f) => f.rel === `${DIR}/${name}`)!.text;
      expect(text.startsWith("'use client';"), name).toBe(true);
    }
  });

  it('core is marked free of side effects, so what the island uses from it stays in the island', () => {
    // Without the mark, Next's bundler keeps every core module that any
    // browser code uses inside core's barrel, which the root layout loads:
    // the map's words were in every page's first load (measured 2026-11-24:
    // every route 16,041 bytes larger, 5.5 KB gzip). With it, a page gets
    // only the core modules it uses.
    const core = JSON.parse(
      readFileSync(join(SRC, '..', '..', '..', 'packages', 'core', 'package.json'), 'utf8'),
    ) as {
      sideEffects?: unknown;
    };
    expect(core.sideEffects).toBe(false);
    // The mark is true only while no core module is imported for its effect.
    const coreSrc = join(SRC, '..', '..', '..', 'packages', 'core', 'src');
    const bare = sourceFiles(coreSrc).filter((abs) =>
      EFFECT_ONLY.some((form) => form.test(readFileSync(abs, 'utf8'))),
    );
    expect(bare.map((abs) => relative(coreSrc, abs))).toEqual([]);
  });

  it('the side-effect check sees a module loaded for its effect in every form', () => {
    for (const form of [
      "import './setup';",
      "import {} from './setup';",
      "export {} from './setup';",
      "export { } from './setup';",
      "require('./setup');",
    ]) {
      expect(
        EFFECT_ONLY.some((re) => re.test(form)),
        form,
      ).toBe(true);
    }
    for (const form of [
      "import { a } from './a';",
      "export * from './a';",
      "export { a } from './a';",
      "const a = require('./a');",
    ]) {
      expect(
        EFFECT_ONLY.some((re) => re.test(form)),
        form,
      ).toBe(false);
    }
  });

  it('the island is rendered by the map section alone', () => {
    expect(staticImporters(/(^|\/)security-map-island$/)).toEqual([
      'components/platform/platform-security-map-section.tsx',
    ]);
  });
});
