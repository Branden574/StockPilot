import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The prewarm route may be called by the two SINGLETON robots only: the Vercel
 * cron (vercel.json) and the post-deploy GitHub Action. Nothing in the app may
 * call it.
 *
 * WHY THIS GUARD EXISTS. Until 2026-09-21 `src/instrumentation.ts` called it
 * from `register()`, that is, every time a server instance started. Production
 * ran it 1,300 times in 24 hours (48 scheduled). After a quiet spell every
 * visit started a new instance, so every visit re-ran the hot tier's
 * service-role queries in the same seconds as the visitor's own page, on a
 * 15-connection database API. Warming caches from a request path or from
 * instance start-up adds load at exactly the moment a person is waiting.
 */
const SRC = path.resolve(__dirname, '../../../..');
const ROUTE_DIR = path.resolve(__dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Comments may talk about the route; code may not name it. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('nothing in the app calls the prewarm route', () => {
  it('resolves src/ (the scan below would pass vacuously on a wrong path)', () => {
    expect(existsSync(path.join(SRC, 'app'))).toBe(true);
    expect(sourceFiles(SRC).length).toBeGreaterThan(500);
  });

  it('no source file outside the route itself names it in code', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(ROUTE_DIR + path.sep))
      .filter((file) => codeOnly(readFileSync(file, 'utf8')).includes('prewarm-orders-catalog'))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('an instance start-up hook, if one is ever added back, does no network call', () => {
    for (const name of ['instrumentation.ts', 'instrumentation.node.ts']) {
      const file = path.join(SRC, name);
      if (!existsSync(file)) continue;
      expect(codeOnly(readFileSync(file, 'utf8'))).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
