import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: a retired order route stays retired (B20a).
 *
 * GET /api/orders/freq answered a warehouse's most-requested items, with their
 * availability and signed photos, to any signed-in member: no Orders module
 * check, no orders:request, no step-up. Nothing has called it since the
 * storefront's Frequently ordered strip moved to the server (#218,
 * server/loaders/orders-frequently-ordered.ts), and the phone never did (it
 * reads /api/v1/orders/storefront, which is gated). So it was deleted rather
 * than gated. Its database function stays: the loader calls it.
 *
 * The guard checks that the route's folder does not come back, and that no
 * product file under apps/web/src, apps/mobile/src or apps/mobile/app, and
 * nothing under scripts/, names the path outside a comment (the loader's
 * history note names it in one). Tests are left out, this one included.
 * Comments are blanked first (`//` and `/* *\/` in code, `#` in shell
 * scripts, `--` in SQL), keeping line numbers, so a failure names the real
 * line.
 */

const REPO = path.resolve(__dirname, '../../../../../..');

const RETIRED: ReadonlyArray<{ route: string; folder: string }> = [
  { route: '/api/orders/freq', folder: 'apps/web/src/app/api/orders/freq' },
];

const ROOTS = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'scripts'];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SHELL = /\.sh$/;
const SQL = /\.sql$/;
const PLAIN = /\.(json|html)$/;

/**
 * Blank out `//` and `/* *\/` comments, keeping every newline (so line numbers
 * hold) and every string's contents. Single- and double-quoted strings end at
 * a newline, so a quote misread inside a regex literal cannot swallow more
 * than its own line.
 */
function stripCodeComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i]!;
        if (c === '\\') {
          out += c + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '\n' && quote !== '`') break;
        out += c;
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Blank a line comment that starts the line or follows white space (`#` in shell, `--` in SQL). */
function stripLineComments(src: string, marker: '#' | '--'): string {
  const re = marker === '#' ? /(^|\s)#.*$/gm : /(^|\s)--.*$/gm;
  return src.replace(re, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

function withoutComments(file: string, src: string): string {
  if (CODE.test(file)) return stripCodeComments(src);
  if (SHELL.test(file)) return stripLineComments(src, '#');
  if (SQL.test(file)) return stripLineComments(src, '--');
  return src;
}

/** The route as a whole path segment run: `/api/orders/freq` and below, never `/api/orders/frequent`. */
function routePattern(route: string): RegExp {
  return new RegExp(`${route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g');
}

function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        (CODE.test(entry.name) ||
          SHELL.test(entry.name) ||
          SQL.test(entry.name) ||
          PLAIN.test(entry.name)) &&
        !/\.test\.(ts|tsx|js|mjs)$/.test(entry.name)
      ) {
        out.push(full);
      }
    }
  };
  for (const root of ROOTS) walk(path.join(REPO, root));
  return out.sort();
}

/** `<file>:<line>` for every place `route` is named outside a comment. */
function namings(files: readonly string[], route: string): string[] {
  const pattern = routePattern(route);
  return files.flatMap((file) => {
    const code = withoutComments(file, readFileSync(file, 'utf8'));
    return [...code.matchAll(pattern)].map(
      (m) => `${path.relative(REPO, file)}:${code.slice(0, m.index).split('\n').length}`,
    );
  });
}

describe('retired routes guard: the scanner', () => {
  it('blanks comments in code, shell and SQL, keeping strings and line numbers', () => {
    const ts = [
      "const u = '/api/orders/freq?x=1'; // /api/orders/freq",
      '/* /api/orders/freq */ const v = 1;',
    ].join('\n');
    expect(stripCodeComments(ts).split('\n')).toHaveLength(2);
    expect([...stripCodeComments(ts).matchAll(routePattern('/api/orders/freq'))]).toHaveLength(1);
    const shLines = [
      '  # src/app/api/orders/freq/route.test.ts',
      '  src/app/api/orders/freq/route.test.ts',
      'echo "${#LIST[@]}"',
    ];
    const stripped = stripLineComments(shLines.join('\n'), '#').split('\n');
    expect(stripped.map((l) => l.length)).toEqual(shLines.map((l) => l.length));
    expect(stripped).toEqual([' '.repeat(shLines[0]!.length), shLines[1], shLines[2]]);
    expect(stripLineComments("select '/x'; -- /api/orders/freq", '--')).not.toContain('freq');
  });

  it('matches the route and paths below it, never a longer name', () => {
    const p = routePattern('/api/orders/freq');
    expect('fetch(`/api/orders/freq?warehouseId=${id}`)'.match(p)).toHaveLength(1);
    expect('src/app/api/orders/freq/route.test.ts'.match(p)).toHaveLength(1);
    expect('/api/orders/frequently-ordered'.match(p)).toBeNull();
  });

  it('scans a real tree, and the loader that names the route in a comment passes only because comments are blanked', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(1000);
    const loader = files.find((f) =>
      f.endsWith('apps/web/src/server/loaders/orders-frequently-ordered.ts'),
    );
    expect(loader).toBeDefined();
    const raw = readFileSync(loader!, 'utf8');
    expect(raw.match(routePattern('/api/orders/freq'))?.length ?? 0).toBeGreaterThan(0);
    expect(namings([loader!], '/api/orders/freq')).toEqual([]);
    expect(files.some((f) => f.endsWith('scripts/security-test.sh'))).toBe(true);
  });
});

describe('retired routes guard: the tree', () => {
  const files = scannedFiles();

  it.each(RETIRED)('$route: its folder is gone', ({ folder }) => {
    expect(existsSync(path.join(REPO, folder))).toBe(false);
  });

  it.each(RETIRED)('$route: no product file or script names it outside a comment', ({ route }) => {
    expect(namings(files, route)).toEqual([]);
  });
});
