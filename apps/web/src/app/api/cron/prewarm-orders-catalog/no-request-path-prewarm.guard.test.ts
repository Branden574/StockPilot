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

/**
 * The warmers the route calls are cron-only too. Naming the route is not the
 * only way to warm from a request: a route or server action could import
 * `prewarmPhoneThumbMap` (or any other `prewarm*` a loader exports) and await
 * it, with the same effect as the 2026-09-21 incident, and the check above
 * would not see it. So every `prewarm*` function a server loader exports may be
 * named in code only by its own module (once: its declaration) and by this
 * route's folder. Tests may name them; they are not a request path.
 */
const LOADERS_DIR = path.join(SRC, 'server', 'loaders');
const isTestFile = (file: string) =>
  /\.test\.tsx?$/.test(file) || file.startsWith(path.join(SRC, 'test') + path.sep);

interface Warmer {
  name: string;
  file: string;
}

function cronOnlyWarmers(): Warmer[] {
  return sourceFiles(LOADERS_DIR)
    .filter((file) => !isTestFile(file))
    .flatMap((file) =>
      [
        ...codeOnly(readFileSync(file, 'utf8')).matchAll(
          /\bexport\s+async\s+function\s+(prewarm[A-Z]\w*)\s*\(/g,
        ),
      ].map((m) => ({ name: m[1]!, file })),
    );
}

/** Where `code` (from `file`) names a warmer it may not: anywhere outside the
 *  route's folder, beyond the one declaration in the warmer's own module. */
function warmerOffences(file: string, code: string, warmers: readonly Warmer[]): string[] {
  if (file.startsWith(ROUTE_DIR + path.sep)) return [];
  return warmers.flatMap(({ name, file: home }) => {
    const named = code.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    const allowed = file === home ? 1 : 0;
    return named > allowed ? [`${path.relative(SRC, file)}: ${name} (${named}x)`] : [];
  });
}

describe("nothing in the app calls the route's cron-only warmers", () => {
  const warmers = cronOnlyWarmers();

  it('finds them (the scan below would pass vacuously without them)', () => {
    expect(warmers.map((w) => w.name)).toEqual(
      expect.arrayContaining([
        'prewarmInventoryList',
        'prewarmOrdersNewCatalog',
        'prewarmPhoneThumbMap',
      ]),
    );
  });

  it('the check catches an import, an alias and a second use in the home module', () => {
    const plantedRoute = path.join(SRC, 'app', 'api', 'v1', 'orders', 'catalog', 'route.ts');
    const home = warmers.find((w) => w.name === 'prewarmPhoneThumbMap')!.file;
    expect(
      warmerOffences(
        plantedRoute,
        "import { prewarmPhoneThumbMap as warm } from '@/server/loaders/orders-phone-catalog';\nawait warm(a, b);",
        warmers,
      ),
    ).toHaveLength(1);
    expect(
      warmerOffences(
        home,
        'export async function prewarmPhoneThumbMap() {}\nexport async function load() { await prewarmPhoneThumbMap(); }',
        warmers,
      ),
    ).toHaveLength(1);
    expect(
      warmerOffences(
        path.join(ROUTE_DIR, 'route.ts'),
        'await prewarmPhoneThumbMap(a, b);',
        warmers,
      ),
    ).toEqual([]);
  });

  it('no source file outside the route names one in code, and each home module only declares it', () => {
    const offences = sourceFiles(SRC)
      .filter((file) => !isTestFile(file))
      .flatMap((file) => warmerOffences(file, codeOnly(readFileSync(file, 'utf8')), warmers));
    expect(offences).toEqual([]);
  });
});
