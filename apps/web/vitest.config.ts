import * as path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Root-level exclusions. NOTE the merge semantics documented on `projects`
// below: this array is CONCATENATED into each project's own `exclude`, so every
// project gets these for free.
const BASE_EXCLUDE = ['node_modules/**', '.next/**', 'dist/**', 'tests/e2e/**'];

// Everything that renders React (and therefore needs a DOM) lives under these
// two trees.
const DOM_GLOBS = ['src/components/**', 'src/app/**'];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@stockpilot/core': path.resolve(__dirname, '../../packages/core/src'),
      // server-only is a Next.js runtime guard; in tests we bypass it.
      'server-only': path.resolve(__dirname, './src/test/__mocks__/server-only.ts'),
    },
  },
  test: {
    exclude: BASE_EXCLUDE,
    // Deliberately NO root-level `include` — see the merge note on `projects`.
    setupFiles: ['./src/test/setup.ts'],
    // The suite has integration-shaped tests that intermittently exceed
    // vitest's 5000ms defaults under load — raise both to stop the flakes.
    testTimeout: 15000,
    hookTimeout: 30000,
    // WHY PROJECTS INSTEAD OF environmentMatchGlobs (2026-09):
    // The DOM environment used to be selected with `test.environmentMatchGlobs`,
    // which Vitest 3 deprecates (it printed a DEPRECATED banner as the first
    // line of every run) and Vitest 4 REMOVED. On that upgrade the option would
    // be ignored in silence, so every src/components and src/app test would run
    // under `node` and die with "document is not defined" — ~236 files red at
    // once, in CI, during an unrelated dependency bump. `test.projects` is the
    // documented replacement and already works on the installed 3.2.7, so the
    // migration lands now rather than under upgrade pressure.
    //
    // `extends: true` is load-bearing: it is what keeps setupFiles, the
    // '@' / '@stockpilot/core' / 'server-only' aliases, the react plugin and the
    // raised timeouts above. Drop it and each project starts from bare defaults.
    //
    // MERGE GOTCHA (cost a debugging round when this landed): `extends: true`
    // re-loads THIS file and merges the inline project config over it with
    // Vite's mergeConfig, which CONCATENATES arrays rather than replacing them.
    // A root-level `include` therefore unions into every project — the first
    // attempt kept `include: ['src/**/*.test.{ts,tsx}']` up top and the `dom`
    // project happily collected all 608 files instead of its 236. So the root
    // declares no `include` at all and each project owns its own; `exclude`
    // stays at the root precisely because unioning it IS the desired behaviour.
    //
    // The two projects must PARTITION the suite: a file matched by neither would
    // simply stop running, with no error. src/test/vitest-config.test.ts walks
    // every test file on disk and asserts exactly-one-project ownership, and
    // pins that the root grows no `include`.
    //
    // Per-file `// @vitest-environment` docblocks (~19 files carry one) still
    // win over the project environment, so those files behave as before.
    projects: [
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: DOM_GLOBS.map((glob) => `${glob}/*.test.{ts,tsx}`),
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          // BASE_EXCLUDE restated so this list is correct on its own terms,
          // independent of the concat behaviour described above.
          exclude: [...BASE_EXCLUDE, ...DOM_GLOBS],
        },
      },
    ],
  },
});
