import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CREDENTIAL_PATH_PREFIXES, isSharePath } from './share-paths';

const TOKEN = 'a'.repeat(64);

/** Every `[token]` route folder under src/app, as the URL prefix in front of the token. */
function tokenRoutePrefixes(): string[] {
  const appDir = path.resolve(__dirname, '../app');
  const found: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (name === '[token]') {
        found.push(segments.join('/'));
        continue;
      }
      // Route groups `(name)` and private folders `_name` are not URL segments.
      walk(full, name.startsWith('(') || name.startsWith('_') ? segments : [...segments, name]);
    }
  };
  walk(appDir, []);
  // API routes answer fetches, not page views: no pageview, no error boundary.
  return found.filter((prefix) => !prefix.startsWith('api/')).sort();
}

describe('isSharePath', () => {
  it.each(['/m/', '/r/', '/i/', '/invite/', '/orders/sign/', '/returns/request/'])(
    'treats %s<token> as a credential-bearing path',
    (prefix) => {
      expect(isSharePath(`${prefix}${TOKEN}`)).toBe(true);
      expect(isSharePath(`${prefix}${TOKEN}/photo`)).toBe(true);
    },
  );

  it('leaves ordinary app routes alone, including ones that merely look similar', () => {
    for (const pathname of [
      '/',
      '/dashboard',
      '/dashboard/orders/sign',
      '/dashboard/returns/request',
      '/invites',
      '/items/abc',
      '/reports',
      '/signin',
    ]) {
      expect(isSharePath(pathname)).toBe(false);
    }
    expect(isSharePath(null)).toBe(false);
    expect(isSharePath(undefined)).toBe(false);
    expect(isSharePath('')).toBe(false);
  });

  it('DRIFT GUARD: every [token] page route in src/app is on the list', () => {
    const routes = tokenRoutePrefixes();
    // If this list is empty the walk is broken, and the guard would pass vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const prefix of routes) {
      expect(CREDENTIAL_PATH_PREFIXES, `add '${prefix}' to CREDENTIAL_PATH_PREFIXES`).toContain(
        prefix,
      );
      expect(isSharePath(`/${prefix}/${TOKEN}`)).toBe(true);
    }
  });

  it('DRIFT GUARD: nothing on the list is stale', () => {
    expect([...CREDENTIAL_PATH_PREFIXES].sort()).toEqual(tokenRoutePrefixes());
  });
});
