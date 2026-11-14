import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant: the caller's network address is read in one place,
 * lib/client-ip.ts, which takes x-forwarded-for only on Vercel (where the
 * platform sets it) and otherwise x-real-ip or the 'unknown' bucket. Every
 * rate-limit key, audit row, device row and email reads the address through
 * clientIpFromRequest, clientIpFromHeaders or clientIpForRecord, so the rule
 * cannot differ from one reader to the next.
 *
 * This reads every source file under src (tests and test helpers aside) for a
 * read of an address header: `.get('<name>')` or `['<name>']`. Writing the
 * header (the analytics proxy sets x-forwarded-for from the helper's answer)
 * is not a read. The self-test at the bottom runs the same reading over
 * sources written to fail, so this cannot pass by reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '..');

/** The one file allowed to read the address headers. */
const ALLOWED = new Set(['lib/client-ip.ts']);

const ADDRESS_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'x-vercel-forwarded-for',
];

const NAMES = ADDRESS_HEADERS.map((n) => n.replace(/-/g, '\\-')).join('|');
const READ = new RegExp(
  `(?:\\.get\\(\\s*|\\[\\s*)(['"\`])(?:${NAMES})\\1\\s*[)\\]]`,
  'gi',
);

/** The address-header reads in one source text, as their line numbers. */
function addressHeaderReads(source: string): number[] {
  const lines: number[] = [];
  for (const m of source.matchAll(READ)) {
    lines.push(source.slice(0, m.index).split('\n').length);
  }
  return lines;
}

function isTestFile(rel: string): boolean {
  return (
    rel.startsWith('test/') ||
    rel.includes('/__tests__/') ||
    rel.includes('/__mocks__/') ||
    /\.(test|spec)\.(ts|tsx)$/.test(rel)
  );
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('the caller address is read only through lib/client-ip.ts', () => {
  const files = sourceFiles(WEB_SRC)
    .map((f) => path.relative(WEB_SRC, f).split(path.sep).join('/'))
    .filter((rel) => !isTestFile(rel));

  it('reads a real tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('lib/client-ip.ts');
  });

  it('no other source file reads an address header', () => {
    const found: string[] = [];
    for (const rel of files) {
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(path.join(WEB_SRC, rel), 'utf8');
      for (const line of addressHeaderReads(source)) found.push(`${rel}:${line}`);
    }
    expect(found).toEqual([]);
  });

  it('lib/client-ip.ts itself still reads them (the reading is not blind)', () => {
    const source = readFileSync(path.join(WEB_SRC, 'lib/client-ip.ts'), 'utf8');
    expect(addressHeaderReads(source).length).toBeGreaterThanOrEqual(2);
  });
});

describe('self-test: the reading finds what it must', () => {
  it.each([
    ["req.headers.get('x-forwarded-for')?.split(',')[0]"],
    ['h.get("x-real-ip")'],
    ['h.get(`X-Forwarded-For`)'],
    ["headers.get( 'cf-connecting-ip' )"],
    ["request.headers.get('true-client-ip')"],
    ["h.get('forwarded')"],
    ["raw['x-forwarded-for']"],
  ])('finds %s', (src) => {
    expect(addressHeaderReads(src)).toEqual([1]);
  });

  it.each([
    ["headers.set('x-forwarded-for', visitor)"],
    ["// read x-forwarded-for only on Vercel"],
    ["h.get('x-forwarded-host')"],
    ["h.get('user-agent')"],
  ])('does not count %s', (src) => {
    expect(addressHeaderReads(src)).toEqual([]);
  });
});
