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
 * setWorkerUrl, and the worker's dependence on its sibling chunk. A mismatch
 * is invisible in unit tests and in SSR -- the map simply mounts blank.
 */
describe('maplibre worker wiring', () => {
  it('copies the worker AND its sibling chunk from the installed package', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'maplibre-'));
    try {
      const dest = copyMaplibreWorker(root);
      expect(dest).toBe(path.join(root, MAPLIBRE_PUBLIC_DIR));
      for (const f of MAPLIBRE_WORKER_FILES) expect(existsSync(path.join(dest, f))).toBe(true);
      // The worker imports the sibling by relative path; if a future release
      // renames it, the copy list is stale and the map breaks at runtime.
      const worker = readFileSync(path.join(dest, 'maplibre-gl-worker.mjs'), 'utf8');
      expect(worker).toContain('maplibre-gl-shared');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('points setWorkerUrl at exactly where the copy script puts the worker', () => {
    expect(MAPLIBRE_WORKER_URL).toBe(`/${MAPLIBRE_PUBLIC_DIR}/maplibre-gl-worker.mjs`);
    expect(MAPLIBRE_WORKER_FILES).toContain('maplibre-gl-worker.mjs');
  });
});
