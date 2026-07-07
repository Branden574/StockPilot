import { defineConfig } from 'vitest/config';

// Unit tests for pure src/lib logic only (native/Expo modules are mocked in
// the tests themselves). Scope the include so vitest never crawls app/ screens
// or the Metro `dist/` output — those import native modules at top level.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
