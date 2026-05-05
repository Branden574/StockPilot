import * as path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@stockpilot/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  test: {
    exclude: ['node_modules/**', '.next/**', 'dist/**'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
