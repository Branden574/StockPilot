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
 *     (a path, `${origin}/signin?...`, or an absolute URL);
 *   - `url.searchParams.set('key', value)` (or append) on a variable the same
 *     file binds to that page (`const url = new URL('/signin', ...)`, or
 *     `url.pathname = '/signin'`).
 * `redirect` carries a destination, not a reason, and is never a notice.
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

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => HOLE + s.literal.text).join('');
  }
  return null;
}

function pageOfPath(node: ts.Node | undefined): Page | null {
  if (!node) return null;
  const text =
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
  return text === '/signin' ? 'signin' : text === '/reset' ? 'reset' : null;
}

function scan(file: string, rel: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
          const raw = eq < 0 ? '' : pair.slice(eq + 1);
          findings.push({
            file: rel,
            page,
            key: decoded(eq < 0 ? pair : pair.slice(0, eq)),
            value: raw.includes(HOLE) ? null : decoded(raw),
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
      const key = keyArg ? literalText(keyArg) : null;
      const value = valueArg ? literalText(valueArg) : null;
      if (key !== null && !key.includes(HOLE)) {
        setCalls.push({
          target: node.expression.expression.expression.text,
          key,
          value: value !== null && !value.includes(HOLE) ? value : null,
        });
      }
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
      out.push(...scan(file, `${label}/${path.relative(root, file)}`));
    }
  }
  return out;
}

const FINDINGS = allFindings();
const show = (f: Finding) => `${f.file}: /${f.page}?${f.key}=${f.value ?? '<computed>'}`;

describe('auth page notices: every reason in the URL is decided (docket B39)', () => {
  it('finds the routes and the action that send a reason today (the scan works)', () => {
    const reasons = FINDINGS.filter((f) => !DESTINATION_KEYS.has(f.key)).map(show);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'apps/web/src/app/auth/callback/route.ts: /signin?error=auth_callback_failed',
        'apps/web/src/app/auth/confirm/route.ts: /signin?error=auth_callback_failed',
        'apps/web/src/app/auth/confirm/route.ts: /reset?error=link_expired',
        'apps/web/src/app/auth/session-ended/route.ts: /signin?reason=session_ended',
        'apps/web/src/server/actions/auth.ts: /signin?reset=success',
      ]),
    );
    // And the destinations, which are never a notice.
    expect(FINDINGS.map(show)).toEqual(
      expect.arrayContaining([
        'apps/web/src/lib/supabase/middleware.ts: /signin?redirect=<computed>',
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
