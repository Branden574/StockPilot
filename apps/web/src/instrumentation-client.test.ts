// @vitest-environment happy-dom
// The store records nothing without a window; see router-navigation.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { onRouterTransitionStart } from '@/instrumentation-client';
import {
  getRouterNavigation,
  noteCommittedLocation,
  resetRouterNavigationForTests,
} from '@/lib/navigation/router-navigation';

/** Every module specifier a file imports or re-exports, side-effect imports included. */
const importsOf = (source: string) =>
  [
    ...source.matchAll(/^\s*import\b[^;'"]*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*export\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]);

describe('instrumentation-client', () => {
  beforeEach(() => {
    resetRouterNavigationForTests();
    window.history.replaceState(null, '', '/dashboard');
  });

  it('runs with a DOM (the happy-dom docblock is in place)', () => {
    expect(typeof window).not.toBe('undefined');
  });

  it('B1 onRouterTransitionStart records the navigation Next reports', () => {
    noteCommittedLocation('/dashboard');
    onRouterTransitionStart('/dashboard/orders/abc', 'push');
    expect(getRouterNavigation()).toMatchObject({
      kind: 'path',
      type: 'push',
      fromKey: '/dashboard',
      targetPath: '/dashboard/orders/abc',
    });
  });

  it('B2 imports only the store, and the store imports nothing (it ships on every route)', () => {
    const file = readFileSync(path.resolve(__dirname, 'instrumentation-client.ts'), 'utf8');
    expect(importsOf(file)).toEqual(['@/lib/navigation/router-navigation']);
    const store = readFileSync(
      path.resolve(__dirname, 'lib/navigation/router-navigation.ts'),
      'utf8',
    );
    expect(importsOf(store)).toEqual([]);
    expect(store).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
