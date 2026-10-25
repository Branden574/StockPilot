/**
 * RECURRENCE GUARD (docket B39): every reason the app puts in the URL of
 * /signin or /reset is decided in lib/auth/auth-page-notices.ts.
 *
 * /auth/confirm and /auth/callback sent a failed emailed link to
 * /signin?error=auth_callback_failed while the sign-in form read only
 * ?reason=session_ended, so the person landed on a plain form with no word
 * that their link had not worked. This reads the source for every query value
 * the app sends to those two pages and fails until each one has an entry in
 * the page's table (a notice, or null for nothing on purpose), and fails on a
 * table entry nothing sends any more.
 *
 * Two shapes are read, from the AST (so comments never count):
 *   - a string or template literal holding a /signin?... or /reset?... URL
 *     (a path, `${origin}/signin?...`, or an absolute URL); a substitution in
 *     the query is computed, except `new URLSearchParams({ key: value })`,
 *     whose keys are read (and a value the code writes as a string);
 *   - `url.searchParams.set('key', value)` (or append) on a variable the same
 *     file binds to that page (`const url = new URL('/signin', ...)`, or
 *     `url.pathname = '/signin'`).
 * `redirect` carries a destination, not a reason, and is never a notice. Any
 * other computed key or value fails: a page can only decide a fixed value.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { RESET_QUERY_NOTICES, SIGN_IN_QUERY_NOTICES } from './auth-page-notices';

const WEB_SRC = path.resolve(__dirname, '../..');
const CORE_SRC = path.resolve(__dirname, '../../../../../packages/core/src');

type Page = 'signin' | 'reset';

const TABLES: Record<Page, Readonly<Record<string, Readonly<Record<string, unknown>>>>> = {
  signin: SIGN_IN_QUERY_NOTICES,
  reset: RESET_QUERY_NOTICES,
};

/** Query keys that carry where to go next, never why the person is here. */
const DESTINATION_KEYS = new Set(['redirect']);

/** Stands in for a template substitution, so a computed part is never read as a fixed value. */
const HOLE = '\u0000';

interface Finding {
  file: string;
  page: Page;
  key: string;
  /** The fixed value, or null when the code computes it. */
  value: string | null;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** A /signin?... or /reset?... URL: a root path, after a substitution, or after a host. */
const PAGE_URL = new RegExp(
  `(?:^|${HOLE}|//[\\w.-]+(?::\\d+)?)/(signin|reset)\\?([^#\\s'"\`]*)`,
  'g',
);

/** A query part as the page reads it; a computed part, or one that is not valid percent-encoding, stays as written. */
function decoded(part: string): string {
  if (part.includes(HOLE)) return part.replaceAll(HOLE, '<computed>');
  try {
    return decodeURIComponent(part.replaceAll('+', ' '));
  } catch {
    return part;
  }
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) {
    n = n.expression;
  }
  return n;
}

function fixedText(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/**
 * A template substitution as query text. `${new URLSearchParams({ redirect: back })}`
 * (or its .toString()) has fixed keys: each is read, with a fixed value when the
 * code writes one and a computed one otherwise. Anything else is computed whole.
 */
function substitution(expression: ts.Expression): string {
  let e = unwrap(expression);
  if (
    ts.isCallExpression(e) &&
    e.arguments.length === 0 &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'toString'
  ) {
    e = unwrap(e.expression.expression);
  }
  const init = ts.isNewExpression(e) ? e.arguments?.[0] : undefined;
  if (
    !ts.isNewExpression(e) ||
    !ts.isIdentifier(e.expression) ||
    e.expression.text !== 'URLSearchParams' ||
    !init ||
    !ts.isObjectLiteralExpression(init)
  ) {
    return HOLE;
  }
  const parts: string[] = [];
  for (const prop of init.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      parts.push(`${encodeURIComponent(prop.name.text)}=${HOLE}`);
    } else if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      const value = fixedText(prop.initializer);
      parts.push(
        `${encodeURIComponent(prop.name.text)}=${value === null ? HOLE : encodeURIComponent(value)}`,
      );
    } else {
      return HOLE; // a spread or a computed key: the keys are not fixed
    }
  }
  return parts.join('&');
}

function literalText(node: ts.Node): string | null {
  const fixed = fixedText(node);
  if (fixed !== null) return fixed;
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((s) => substitution(s.expression) + s.literal.text).join('')
    );
  }
  return null;
}

function pageOfPath(node: ts.Node | undefined): Page | null {
  const text = node ? fixedText(node) : null;
  return text === '/signin' ? 'signin' : text === '/reset' ? 'reset' : null;
}

/** Every query value this source sends to /signin or /reset. */
function scanSource(text: string, rel: string, tsx: boolean): Finding[] {
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const bound = new Map<string, Set<Page>>();
  const bind = (name: string, page: Page) => {
    const pages = bound.get(name) ?? new Set<Page>();
    pages.add(page);
    bound.set(name, pages);
  };
  const setCalls: { target: string; key: string; value: string | null }[] = [];

  const visit = (node: ts.Node) => {
    const literal = literalText(node);
    if (literal !== null) {
      for (const m of literal.matchAll(PAGE_URL)) {
        const page = m[1] as Page;
        for (const pair of m[2]!.split('&')) {
          if (!pair) continue;
          const eq = pair.indexOf('=');
          const rawKey = eq < 0 ? pair : pair.slice(0, eq);
          const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
          findings.push({
            file: rel,
            page,
            key: decoded(rawKey),
            // A computed key computes its value too.
            value: rawKey.includes(HOLE) || rawValue.includes(HOLE) ? null : decoded(rawValue),
          });
        }
      }
    }
    // const url = new URL('/signin', ...)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'URL'
    ) {
      const page = pageOfPath(node.initializer.arguments?.[0]);
      if (page) bind(node.name.text, page);
    }
    // url.pathname = '/signin'
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'pathname' &&
      ts.isIdentifier(node.left.expression)
    ) {
      const page = pageOfPath(node.right);
      if (page) bind(node.left.expression.text, page);
    }
    // url.searchParams.set('key', value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['set', 'append'].includes(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'searchParams' &&
      ts.isIdentifier(node.expression.expression.expression)
    ) {
      const [keyArg, valueArg] = node.arguments;
      const key = keyArg ? fixedText(keyArg) : null;
      const value = valueArg ? fixedText(valueArg) : null;
      setCalls.push({
        target: node.expression.expression.expression.text,
        key: key ?? '<computed>',
        value: key === null ? null : value,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const call of setCalls) {
    for (const page of bound.get(call.target) ?? []) {
      findings.push({ file: rel, page, key: call.key, value: call.value });
    }
  }
  return findings;
}

function allFindings(): Finding[] {
  const out: Finding[] = [];
  for (const [root, label] of [
    [WEB_SRC, 'apps/web/src'],
    [CORE_SRC, 'packages/core/src'],
  ] as const) {
    for (const file of sourceFiles(root)) {
      const rel = `${label}/${path.relative(root, file)}`;
      out.push(...scanSource(readFileSync(file, 'utf8'), rel, file.endsWith('.tsx')));
    }
  }
  return out;
}

const show = (f: Finding) => `${f.file}: /${f.page}?${f.key}=${f.value ?? '<computed>'}`;

describe('the scan reads the shapes it names', () => {
  const read = (source: string) => scanSource(source, 'x.tsx', true).map(show);

  it('reads a path, a substitution before it, and an absolute URL', () => {
    expect(read(`const a = '/signin?error=one&reason=two';`)).toEqual([
      'x.tsx: /signin?error=one',
      'x.tsx: /signin?reason=two',
    ]);
    expect(read('const b = `${origin}/reset?error=three`;')).toEqual(['x.tsx: /reset?error=three']);
    expect(read(`const c = 'https://app.example.com/signin?reset=four';`)).toEqual([
      'x.tsx: /signin?reset=four',
    ]);
    expect(read(`const d = <a href="/signin?redirect=%2Fportal">Sign in</a>;`)).toEqual([
      'x.tsx: /signin?redirect=/portal',
    ]);
  });

  it("reads URLSearchParams' fixed keys, and computes everything else", () => {
    expect(
      read('const e = `/signin?${new URLSearchParams({ redirect: back }).toString()}`;'),
    ).toEqual(['x.tsx: /signin?redirect=<computed>']);
    expect(read("const f = `/signin?${new URLSearchParams({ error: 'five', next })}`;")).toEqual([
      'x.tsx: /signin?error=five',
      'x.tsx: /signin?next=<computed>',
    ]);
    expect(read('const g = `/signin?${query}`;')).toEqual(['x.tsx: /signin?<computed>=<computed>']);
    expect(read('const h = `/signin?error=${code}`;')).toEqual(['x.tsx: /signin?error=<computed>']);
    expect(read('const i = `/signin?${new URLSearchParams({ ...rest })}`;')).toEqual([
      'x.tsx: /signin?<computed>=<computed>',
    ]);
  });

  it('reads searchParams.set on a URL the file builds for the page', () => {
    expect(
      read(`const url = new URL('/signin', base); url.searchParams.set('reason', 'six');`),
    ).toEqual(['x.tsx: /signin?reason=six']);
    expect(read(`u.pathname = '/reset'; u.searchParams.append('error', code);`)).toEqual([
      'x.tsx: /reset?error=<computed>',
    ]);
    expect(read(`const v = new URL('/signin', base); v.searchParams.set(key, 'seven');`)).toEqual([
      'x.tsx: /signin?<computed>=<computed>',
    ]);
    // A URL built for another page is not read.
    expect(read(`const w = new URL('/settings', base); w.searchParams.set('error', 'x');`)).toEqual(
      [],
    );
  });

  it('ignores comments, other paths and other pages, and survives bad percent-encoding', () => {
    expect(read(`// '/signin?error=in-a-comment'\n/* '/reset?error=too' */`)).toEqual([]);
    expect(read(`const j = '/signin/mfa?redirect=%2Fdashboard';`)).toEqual([]);
    expect(read(`const k = '/api/v1/auth/reset?x=1';`)).toEqual([]);
    expect(read(`const l = '/signin?bad=%E0%A4%A';`)).toEqual(['x.tsx: /signin?bad=%E0%A4%A']);
  });
});

describe('auth page notices: every reason in the URL is decided (docket B39)', () => {
  const FINDINGS = allFindings();

  it('finds the routes and the action that send a reason today (the scan works)', () => {
    const reasons = FINDINGS.filter((f) => !DESTINATION_KEYS.has(f.key)).map(show);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'apps/web/src/app/auth/callback/route.ts: /signin?error=auth_callback_failed',
        'apps/web/src/app/auth/confirm/route.ts: /signin?error=auth_callback_failed',
        'apps/web/src/app/auth/confirm/route.ts: /reset?error=link_expired',
        'apps/web/src/app/auth/confirm/route.ts: /signin?error=link_refused',
        'apps/web/src/app/auth/confirm/route.ts: /reset?error=link_refused',
        'apps/web/src/app/auth/session-ended/route.ts: /signin?reason=session_ended',
        'apps/web/src/server/actions/auth.ts: /signin?reset=success',
      ]),
    );
    // And the destinations, which are never a notice.
    expect(FINDINGS.map(show)).toEqual(
      expect.arrayContaining([
        'apps/web/src/lib/supabase/middleware.ts: /signin?redirect=<computed>',
        'apps/web/src/lib/auth/session.ts: /signin?redirect=<computed>',
      ]),
    );
  });

  it('has a decision (a notice, or null on purpose) for every value the app sends', () => {
    const undecided = FINDINGS.filter((f) => {
      if (DESTINATION_KEYS.has(f.key)) return false;
      const values = Object.hasOwn(TABLES[f.page], f.key) ? TABLES[f.page][f.key]! : null;
      return values === null || f.value === null || !Object.hasOwn(values, f.value);
    }).map(show);
    expect(
      undecided,
      'Decide what the page says for each of these in lib/auth/auth-page-notices.ts (a fixed value only)',
    ).toEqual([]);
  });

  it('has no entry that nothing sends any more', () => {
    const sent = new Set(FINDINGS.map((f) => `${f.page} ${f.key} ${f.value}`));
    const stale: string[] = [];
    for (const page of Object.keys(TABLES) as Page[]) {
      for (const [key, values] of Object.entries(TABLES[page])) {
        for (const value of Object.keys(values)) {
          if (!sent.has(`${page} ${key} ${value}`)) stale.push(`/${page}?${key}=${value}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
