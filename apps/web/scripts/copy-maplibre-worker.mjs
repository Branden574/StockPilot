// maplibre-gl v6 is ESM-only and runs its tile pipeline in a Web Worker that
// imports a sibling chunk (maplibre-gl-shared.mjs) by RELATIVE path. Turbopack
// hashes `new URL(worker, import.meta.url)` into a lone asset without that
// sibling, so the worker dies on its first import and the map mounts but never
// requests a tile. The documented fix for Next.js is to serve both files from
// public/ and point setWorkerUrl at the worker; this script does the copy at
// build/dev time from node_modules so it always matches the installed version.
//
// Wired into the `build` and `dev` scripts explicitly (NOT via npm `prebuild`:
// pnpm does not run pre/post lifecycle scripts by default).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAPLIBRE_PUBLIC_DIR = 'maplibre';
export const MAPLIBRE_WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

export function copyMaplibreWorker(publicRoot = path.join(process.cwd(), 'public')) {
  const pkgJson = createRequire(import.meta.url).resolve('maplibre-gl/package.json');
  const dist = path.join(path.dirname(pkgJson), 'dist');
  const dest = path.join(publicRoot, MAPLIBRE_PUBLIC_DIR);
  mkdirSync(dest, { recursive: true });
  for (const file of MAPLIBRE_WORKER_FILES) {
    copyFileSync(path.join(dist, file), path.join(dest, file));
  }
  return dest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dest = copyMaplibreWorker();
  console.log(`[maplibre] copied ${MAPLIBRE_WORKER_FILES.join(', ')} -> ${path.relative(process.cwd(), dest)}/`);
}
