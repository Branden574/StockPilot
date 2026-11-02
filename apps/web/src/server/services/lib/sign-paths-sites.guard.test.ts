import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: every storage signing call either chunks its paths or says why it
 * cannot pass the limit (B20a).
 *
 * storage-api refuses a createSignedUrls call of more than 1,000 paths with a
 * 400 for the WHOLE call (storage-sign-limiter.ts SIGN_PATHS_PER_CALL), so a
 * list that grows past it loses every link at once. Each `.createSignedUrls(`
 * call in apps/web/src (tests and the shared test helpers excluded) must be
 * either:
 *   - in CHUNKED below, a file that slices its paths by its own constant: the
 *     file holds exactly that many calls and the constant appears in its code;
 *   - or annotated `// sign-bound: <why the paths stay at or under 1,000>`
 *     (ten characters or more) on the call's line or one of the 6 lines above.
 * A new call, a CHUNKED file whose number of calls changes, or a CHUNKED
 * constant that disappears fails.
 *
 * Comments are blanked before the scan (prose mentions createSignedUrls all
 * over) and line numbers are kept, as in the phone's in-filter guard, so a
 * failure names the real line. It is a source scan: a call made through a
 * computed property name is out of its reach.
 */

const WEB_SRC = path.resolve(__dirname, '../../..');
const ANNOTATION_REACH = 6;
const ANNOTATION = /\/\/\s*sign-bound:\s*(\S.{9,})$/;

/** Files that sign in chunks: the number of calls each holds and the constant it slices by. */
const CHUNKED: Readonly<Record<string, { calls: number; constant: string }>> = {
  'server/services/item-images.ts': { calls: 1, constant: 'SIGN_PATHS_PER_CALL' },
  'server/loaders/orders-new-catalog.ts': { calls: 1, constant: 'SIGN_PATHS_PER_CALL' },
  'server/loaders/orders-phone-catalog.ts': { calls: 1, constant: 'PHONE_SIGN_PATHS_PER_CALL' },
  'server/services/lib/exception-evidence-read.ts': { calls: 1, constant: 'SIGN_PATHS_PER_CALL' },
};

/**
 * Blank out `//` and `/* *\/` comments, keeping every newline (so line numbers
 * hold) and every string's contents. Single- and double-quoted strings end at
 * a newline, so a quote misread inside a regex literal cannot swallow more
 * than its own line.
 */
function stripComments(src: string): string {
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

/** The 1-based line of every `.createSignedUrls(` call in one file's source. */
function signSites(src: string): number[] {
  const code = stripComments(src);
  return [...code.matchAll(/\.\s*createSignedUrls\s*\(/g)].map(
    (m) => code.slice(0, m.index).split('\n').length,
  );
}

/** The reason a call's annotation gives, or null when it has none in reach. */
function annotation(line: number, srcLines: readonly string[]): string | null {
  for (let l = line; l >= Math.max(1, line - ANNOTATION_REACH); l -= 1) {
    const m = ANNOTATION.exec(srcLines[l - 1] ?? '');
    if (m) return m[1]!.trim();
  }
  return null;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (entry.name === '__mocks__' || entry.name === '__fixtures__') continue;
        // The shared test helpers (supabase-mock.ts and friends).
        if (full === path.join(WEB_SRC, 'test')) continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(WEB_SRC);
  return out.sort();
}

describe('sign-paths guard: the scanner', () => {
  it('strips comments but keeps strings and line numbers', () => {
    const src = [
      "const a = 'https://x.test'; // bucket.createSignedUrls(paths, 60)",
      '/* one createSignedUrls(',
      '   call per row */ const b = 1;',
      'await bucket.createSignedUrls(paths, 60);',
    ].join('\n');
    const code = stripComments(src);
    expect(code.split('\n')).toHaveLength(4);
    expect(code).toContain("'https://x.test'");
    expect(signSites(src)).toEqual([4]);
  });

  it('finds a call split over lines on the line of its name', () => {
    const src =
      'const { data } = await admin.storage\n  .from(BUCKET)\n  .createSignedUrls(paths, 3600);';
    expect(signSites(src)).toEqual([3]);
  });

  it('reads an annotation on the line or up to 6 lines above, with a reason of ten characters or more', () => {
    const lines = [
      '// sign-bound: one path a row, at most 500 rows', // 1
      '', // 2
      '', // 3
      '', // 4
      '', // 5
      '', // 6
      'bucket.createSignedUrls(a, 60);', // 7: annotation 6 lines up
      '', // 8
      'bucket.createSignedUrls(b, 60);', // 9: annotation 8 lines up
      '// sign-bound: short', // 10
      'bucket.createSignedUrls(c, 60);', // 11: reason too short
      'bucket.createSignedUrls(d, 60); // sign-bound: one path per ticket, 500 tickets', // 12
    ];
    expect([7, 9, 11, 12].map((l) => annotation(l, lines))).toEqual([
      'one path a row, at most 500 rows',
      null,
      null,
      'one path per ticket, 500 tickets',
    ]);
  });
});

describe('sign-paths guard: apps/web/src', () => {
  const files = sourceFiles();
  const scanned = files.map((file) => {
    const src = readFileSync(file, 'utf8');
    return { rel: path.relative(WEB_SRC, file), src, sites: signSites(src) };
  });

  it('scans a real tree (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(scanned.reduce((n, f) => n + f.sites.length, 0)).toBeGreaterThanOrEqual(8);
  });

  it('every CHUNKED file still holds its calls and slices by its constant', () => {
    const drift = Object.entries(CHUNKED).flatMap(([rel, { calls, constant }]) => {
      const file = scanned.find((f) => f.rel === rel);
      if (!file) return [`${rel}: not found`];
      const out: string[] = [];
      if (file.sites.length !== calls) {
        out.push(`${rel}: ${file.sites.length} createSignedUrls calls, CHUNKED says ${calls}`);
      }
      if (!new RegExp(`\\b${constant}\\b`).test(stripComments(file.src))) {
        out.push(`${rel}: ${constant} is not in its code`);
      }
      return out;
    });
    expect(drift).toEqual([]);
  });

  it('every other createSignedUrls call says why its paths stay at or under 1,000', () => {
    const offenders = scanned
      .filter((f) => !(f.rel in CHUNKED))
      .flatMap((f) => {
        const lines = f.src.split('\n');
        return f.sites
          .filter((line) => annotation(line, lines) === null)
          .map((line) => `${f.rel}:${line}`);
      });
    expect(
      offenders,
      'Sign in calls of at most SIGN_PATHS_PER_CALL (lib/storage-sign-limiter.ts) and add the file ' +
        'to CHUNKED, or add `// sign-bound: <why the paths stay at or under 1,000>` on or up to ' +
        '6 lines above the call.',
    ).toEqual([]);
  });
});
