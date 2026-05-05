import * as path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
    exclude: ['node_modules/**', '.next/**', 'dist/**', 'tests/e2e/**'],
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    environmentMatchGlobs: [
      ['src/components/**', 'happy-dom'],
      ['src/app/**', 'happy-dom'],
    ],
  },
});
