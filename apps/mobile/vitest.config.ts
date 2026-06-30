import * as path from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the mobile app's unit-testable lib layer.
 * Only pure-TS libs (no React Native UI, no native modules) are tested here
 * — anything that requires a native runtime is mocked at the module level.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@stockpilot/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**'],
  },
});
