import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  copyMaplibreWorker,
  MAPLIBRE_PUBLIC_DIR,
  MAPLIBRE_WORKER_FILES,
} from '../../../scripts/copy-maplibre-worker.mjs';
import { MAPLIBRE_WORKER_URL } from './delivery-map';

/**
 * maplibre-gl v6 (the first version past the GHSA-jrc7-96c5-q579 sanitizer
 * bypass) is ESM-only and needs its worker served from public/. Three things
 * have to agree for the map to load a single tile, and nothing else checks
 * them: the copy script's destination, the URL the component hands to
 * setWorkerUrl, and the files the worker imports. A mismatch is invisible in
 * unit tests and in SSR -- the map simply mounts blank.
 *
 * The worker's own imports changed shape within v6. Through 6.12 the worker
 * is a small file that imports a sibling chunk, maplibre-gl-shared.mjs, by
 * relative path. From 6.13 the worker is one self-contained file with no
 * relative import, and maplibre-gl-shared.mjs ships empty. This test used to
 * require the worker to name the sibling, which holds only for the first
 * layout. What the map needs in both is that every file the worker imports
 * is copied next to it, so that is what it checks now.
 */

/** The relative module specifiers a source imports: static, side-effect or dynamic with a literal. */
function relativeImports(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g)) {
    const spec = m[2];
    if (spec !== undefined) found.add(spec);
  }
  return [...found];
}

/** The files a worker imports that the copy list does not carry next to it. */
function missingSiblings(source: string, copied: readonly string[]): string[] {
  return relativeImports(source)
    .map((spec) => path.posix.normalize(spec))
    .filter((file) => !copied.includes(file));
}

describe('maplibre worker wiring', () => {
  it('copies the worker and every file it imports from the installed package', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'maplibre-'));
    try {
      const dest = copyMaplibreWorker(root);
      expect(dest).toBe(path.join(root, MAPLIBRE_PUBLIC_DIR));
      for (const f of MAPLIBRE_WORKER_FILES) expect(existsSync(path.join(dest, f))).toBe(true);
      // If a release imports a chunk the copy list does not name, the worker
      // dies on its first import at runtime and the map stays blank.
      const worker = readFileSync(path.join(dest, 'maplibre-gl-worker.mjs'), 'utf8');
      expect(worker.length).toBeGreaterThan(0);
      expect(missingSiblings(worker, MAPLIBRE_WORKER_FILES)).toEqual([]);
      for (const spec of relativeImports(worker)) {
        expect(existsSync(path.join(dest, spec)), spec).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts both worker layouts and catches an import the copy list lacks', () => {
    // The shape through 6.12: the worker imports its sibling chunk.
    const split =
      'import{a as b,c as d}from"./maplibre-gl-shared.mjs";function e(){}export{e as default};';
    // The shape from 6.13: one file; its only dynamic import takes a URL at run time.
    const single =
      'var t=1;async function u(e){await import(/* @vite-ignore */ e)}export{u as default};';
    expect(relativeImports(split)).toEqual(['./maplibre-gl-shared.mjs']);
    expect(missingSiblings(split, MAPLIBRE_WORKER_FILES)).toEqual([]);
    expect(relativeImports(single)).toEqual([]);
    expect(missingSiblings(single, MAPLIBRE_WORKER_FILES)).toEqual([]);
    // A renamed chunk, a side-effect import and a literal dynamic import are each caught.
    expect(
      missingSiblings('import{a}from"./maplibre-gl-shared-2.mjs";', MAPLIBRE_WORKER_FILES),
    ).toEqual(['maplibre-gl-shared-2.mjs']);
    expect(missingSiblings("import './chunk-a.mjs';", MAPLIBRE_WORKER_FILES)).toEqual([
      'chunk-a.mjs',
    ]);
    expect(missingSiblings('await import("./chunk-b.mjs")', MAPLIBRE_WORKER_FILES)).toEqual([
      'chunk-b.mjs',
    ]);
  });

  it('points setWorkerUrl at exactly where the copy script puts the worker', () => {
    expect(MAPLIBRE_WORKER_URL).toBe(`/${MAPLIBRE_PUBLIC_DIR}/maplibre-gl-worker.mjs`);
    expect(MAPLIBRE_WORKER_FILES).toContain('maplibre-gl-worker.mjs');
  });
});
