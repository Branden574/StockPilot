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
 * Every source file under src (tests and test helpers aside), comments taken
 * out, is read two ways:
 *   1. a read of an address header: `.get('<name>')` or `['<name>']` (with
 *      its line, for the message);
 *   2. stricter: any quoted literal that IS an address-header name, however
 *      it is used (held in a constant, cast with `as`), or a quoted piece of
 *      one that a name could be built from ('forwarded-for', 'real-ip'),
 *      unless the literal is the first argument of `.set(`, `.append(` or
 *      `.delete(` (writing a header, as the analytics proxy sets
 *      x-forwarded-for from the helper's answer, is not a read); and the other
 *      ways to the address: `request.ip` / `req.ip`, `const { ip } = request`,
 *      a socket's `remoteAddress`, and `ipAddress` or `geolocation` in a file
 *      that names `@vercel/functions` or `@vercel/edge` (a named, namespace
 *      or dynamic import).
 * Only lib/client-ip.ts may do either. The self-test at the bottom runs both
 * readings over inline sources written to fail, and to pass, so this cannot
 * pass by reading nothing.
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
  'x-vercel-proxied-for',
  'x-original-forwarded-for',
];

/**
 * Quoted pieces an address-header name could be built from: every run of
 * two or more of a name's dash-separated words that is not the whole name
 * ('forwarded-for', 'real-ip', 'connecting-ip', 'x-forwarded', ...). A
 * single word ('for', 'ip', 'real') is too common to mean anything.
 */
const NAME_PIECES = (() => {
  const pieces = new Set<string>();
  for (const name of ADDRESS_HEADERS) {
    const words = name.split('-');
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 2; j <= words.length; j++) {
        const piece = words.slice(i, j).join('-');
        if (piece !== name) {
          pieces.add(piece);
          if (i > 0) pieces.add(`-${piece}`);
          if (j < words.length) pieces.add(`${piece}-`);
        }
      }
    }
  }
  for (const name of ADDRESS_HEADERS) pieces.delete(name);
  return pieces;
})();

const NAMES = ADDRESS_HEADERS.map((n) => n.replace(/-/g, '\\-')).join('|');
const READ = new RegExp(
  `(?:\\.get\\(\\s*|\\[\\s*)(['"\`])(?:${NAMES})\\1\\s*[)\\]]`,
  'gi',
);
/** Any single-, double- or backtick-quoted literal with no `${` inside. */
const LITERAL = /(['"`])((?:(?!\1)[^\\\n$]|\\.|\$(?!\{))*)\1/g;
const WRITE_BEFORE = /\.(?:set|append|delete)\(\s*$/;
const OTHER_WAYS: Array<[string, RegExp]> = [
  ['request.ip', /\b(?:req|request)\??\.ip\b(?!\w)/g],
  ['{ ip } = request', /\{[^}]*\bip\b[^}]*\}\s*=\s*(?:req|request)\b/g],
  ['remoteAddress', /\bremoteAddress\b/g],
];
/** A file that names one of these packages may not name ipAddress or geolocation. */
const VERCEL_IP_PACKAGES = /(['"`])@vercel\/(?:functions|edge)\1/;
const VERCEL_IP_HELPERS = /\b(?:ipAddress|geolocation)\b/g;

/**
 * The source with comments turned to spaces; strings and templates are kept,
 * and every line stays where it was. A `/*` or `//` inside a string is not a
 * comment, and a comment ends where it ends. Where it is unsure (a quote
 * inside a regex literal) it keeps text, so the worst case is a finding to
 * look at, never a blanked span.
 */
function code(src: string): string {
  let out = '';
  let i = 0;
  let st: 'code' | "'" | '"' | '`' | 'line' | 'block' = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') {
        st = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        st = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') st = c;
      out += c;
      i++;
      continue;
    }
    if (st === 'line') {
      if (c === '\n') {
        st = 'code';
        out += c;
      } else out += ' ';
      i++;
      continue;
    }
    if (st === 'block') {
      if (c === '*' && d === '/') {
        st = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? c : ' ';
      i++;
      continue;
    }
    // Inside a string or a template.
    if (c === '\\') {
      out += c + (d ?? '');
      i += 2;
      continue;
    }
    if (c === st || (c === '\n' && st !== '`')) st = 'code';
    out += c;
    i++;
  }
  return out;
}

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

/** Reading 1: the address-header reads in one source text, as their line numbers. */
function addressHeaderReads(source: string): number[] {
  const text = code(source);
  return [...text.matchAll(READ)].map((m) => lineOf(text, m.index));
}

/** Reading 2: every other way to the address, as `<line>: <what>`. */
function strictFindings(source: string): string[] {
  const text = code(source);
  const found: string[] = [];
  for (const m of text.matchAll(LITERAL)) {
    const value = m[2]!.toLowerCase();
    const isName = ADDRESS_HEADERS.includes(value);
    if (!isName && !NAME_PIECES.has(value)) continue;
    if (isName && WRITE_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    found.push(`${lineOf(text, m.index)}: ${isName ? 'name' : 'piece'} ${m[0]}`);
  }
  for (const [what, re] of OTHER_WAYS) {
    for (const m of text.matchAll(re)) found.push(`${lineOf(text, m.index)}: ${what}`);
  }
  if (VERCEL_IP_PACKAGES.test(text)) {
    for (const m of text.matchAll(VERCEL_IP_HELPERS)) {
      found.push(`${lineOf(text, m.index)}: @vercel ${m[0]}`);
    }
  }
  return found;
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
  const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');

  it('reads a real tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('lib/client-ip.ts');
  });

  it('no other source file reads an address header', () => {
    const found: string[] = [];
    for (const rel of files) {
      if (ALLOWED.has(rel)) continue;
      for (const line of addressHeaderReads(read(rel))) found.push(`${rel}:${line}`);
    }
    expect(found).toEqual([]);
  });

  it('no other source file names an address header, builds one, or reads the address another way', () => {
    const found: string[] = [];
    for (const rel of files) {
      if (ALLOWED.has(rel)) continue;
      for (const f of strictFindings(read(rel))) found.push(`${rel}:${f}`);
    }
    expect(found).toEqual([]);
  });

  it('a reader planted in the middle of a real file is found by both readings (no span is blanked)', () => {
    const lines = read('lib/auth/session.ts').split('\n');
    expect(lines.length).toBeGreaterThan(300);
    const planted = [
      ...lines.slice(0, 249),
      "const probeIp = (await headers()).get('x-real-ip');",
      ...lines.slice(249),
    ].join('\n');
    expect(addressHeaderReads(planted)).toEqual([250]);
    expect(strictFindings(planted).some((f) => f.startsWith('250: '))).toBe(true);
  });

  it('lib/client-ip.ts itself still reads them (the reading is not blind)', () => {
    const source = read('lib/client-ip.ts');
    expect(addressHeaderReads(source).length).toBeGreaterThanOrEqual(2);
    expect(strictFindings(source).length).toBeGreaterThanOrEqual(2);
  });
});

describe('self-test: the readings find what they must', () => {
  it.each([
    ["req.headers.get('x-forwarded-for')?.split(',')[0]"],
    ['h.get("x-real-ip")'],
    ['h.get(`X-Forwarded-For`)'],
    ["headers.get( 'cf-connecting-ip' )"],
    ["request.headers.get('true-client-ip')"],
    ["h.get('forwarded')"],
    ["raw['x-forwarded-for']"],
  ])('reading 1 finds %s', (src) => {
    expect(addressHeaderReads(src)).toEqual([1]);
  });

  it.each([
    ["const ACCEPT = 'image/*,application/pdf';\nconst ip = h.get('x-real-ip');\n/** later */"],
    ["// on `/api/**` the header is the client's\nconst ip = h.get('x-real-ip');\n/** later */"],
    ["const u = base + '//x'; const ip = h.get('x-real-ip');"],
    [
      "// the matcher covers /api/** and the pages\nexport const a = 1;\nconst ip = req.headers.get('x-forwarded-for');\n/* end */",
    ],
  ])('both readings find a reader after text the comment strip must keep: %s', (src) => {
    expect(addressHeaderReads(src).length).toBeGreaterThanOrEqual(1);
    expect(strictFindings(src).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["const H = 'x-forwarded-for';\nh.get(H);"],
    ["h.get('x-real-ip' as string)"],
    ["h.get('x-' + 'forwarded-for')"],
    ["h.get(['x', 'real-ip'].join('-'))"],
    ["const name = `x-vercel-forwarded-for`;"],
    ["h.get('x-vercel-proxied-for')"],
    ["const ip = request.ip;"],
    ["const ip = req?.ip ?? null;"],
    ["const ip = req.socket.remoteAddress;"],
    ["import { ipAddress } from '@vercel/functions';"],
    ["import { geolocation, waitUntil } from '@vercel/functions';"],
    ['const { ip } = request;'],
    ['const { ip, geo } = req;'],
    ["import * as vf from '@vercel/functions';\nconst a = vf.ipAddress(req);"],
    ["const { ipAddress } = await import('@vercel/functions');"],
    ["import { ipAddress } from '@vercel/edge';"],
  ])('reading 2 finds %s', (src) => {
    expect(strictFindings(src).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["headers.set('x-forwarded-for', visitor)"],
    ["out.append('x-real-ip', value)"],
    ["// read 'x-forwarded-for' only on Vercel"],
    ["/* `x-real-ip` in a comment */"],
    ["h.get('x-forwarded-host')"],
    ["h.get('user-agent')"],
    ["import { clientIpFromHeaders } from '@/lib/client-ip';"],
    ["const url = 'https://example.com/x';"],
    ["const shipping = request.ipAllowList;"],
    ["import { waitUntil } from '@vercel/functions';"],
    ["import * as vf from '@vercel/functions';\nvf.waitUntil(p);"],
    ['const { ipAllowList } = request;'],
    ['const { ip } = settings;'],
  ])('neither reading counts %s', (src) => {
    expect(addressHeaderReads(src)).toEqual([]);
    expect(strictFindings(src)).toEqual([]);
  });
});
