import * as fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCallGraph, shippedSourceFiles, type CallGraph } from '@/test/gate-reach';

import {
  AUTHENTICATOR_SET_UP_PAGE,
  AUTHENTICATOR_SET_UP_URL,
  OPEN_BEFORE_AUTHENTICATOR_SET_UP,
  openBeforeAuthenticatorSetUp,
} from './authenticator-set-up';

/**
 * Security invariant: a member who must set up an authenticator first is held
 * to it on every dashboard page and every Server Action that builds on their
 * context, with one list of the pages open to them before set-up, and NO
 * LAYOUT EVER REDIRECTS TO A PAGE UNDER ITSELF.
 *
 * That last rule is a browser fact: a layout rendered for a client-side
 * navigation (the landing after sign-in, an organization switch, accepting an
 * invitation) that throws a redirect is kept by the browser as that layout's
 * answer; when the target shares the layout the server does not send the
 * layout again, so the browser renders the kept redirect again and again (the
 * address replaced hundreds of times a second, a blank page) until a reload.
 *
 *   1. requireOrgContext() has ONE exit: it resolves the context with the
 *      module-private resolveOrgContext() and hands it out only through
 *      sendToSetUpWhenOwed(), which asks the set-up question
 *      (authenticatorSetUpIsOwed, on the core rule). Every dashboard page asks
 *      requireOrgContext() first (test/page-step-up.guard.test.ts).
 *   2. requireOrgContextForLayout(), the same context without the set-up
 *      redirect, and authenticatorSetUpOwedForLayout(), the set-up answer
 *      without the redirect, are used by layout.tsx files under
 *      app/(dashboard) and by nothing else. The first still asks the
 *      authenticator-code rule; the second asks the set-up question the page
 *      asks (setUpOwedOnThisPage) and redirects to nothing itself.
 *   3. No layout.tsx under app/ reaches requireOrgContext(), by a call or by
 *      a component it renders.
 *   4. No layout.tsx under app/ calls redirect() or permanentRedirect() to a
 *      page under itself: a literal target must not be a page of that layout's
 *      own tree; any other target is listed below with where it goes. Read in
 *      the layout file itself and, one level down, in the app's own files it
 *      imports (a helper it calls, a component it renders), where a literal
 *      target under the layout is reported. NOT checked: a computed target in
 *      an imported file, files two or more imports away, and the redirects
 *      inside requireOrgContextForLayout()'s resolver (all outside the
 *      dashboard layout today: sign-in, the code page, onboarding).
 *   5. The dashboard layout uses the same rule and open pages for its banner
 *      and its set-up panel, and redirects to nothing for set-up.
 *   6. Nothing else decides which pages are open: no file writes its own
 *      prefix test for those pages.
 *   7. The open pages: the security page and the profile page, exactly or
 *      below them after a slash.
 *   8. Signing out never asks for the member's context.
 *
 * The self-test at the bottom plants a violation of 2, 3 and 4.
 */

const WEB_SRC = path.resolve(__dirname, '../..');

interface Tree {
  graph: CallGraph;
  /** Src-relative path -> text. */
  files: Map<string, string>;
  abs: (rel: string) => string;
}

function treeOf(files: Array<{ path: string; text: string }>, root: string): Tree {
  return {
    graph: buildCallGraph(files, root),
    files: new Map(
      files.map((f) => [path.relative(root, f.path).split(path.sep).join('/'), f.text]),
    ),
    abs: (rel) => path.join(root, rel),
  };
}

const REAL = treeOf(shippedSourceFiles(WEB_SRC, fs), WEB_SRC);
const SESSION = 'lib/auth/session.ts';
const GATE = 'requireOrgContext';
const LAYOUT_GATE = 'requireOrgContextForLayout';
const LAYOUT_SET_UP_QUESTION = 'authenticatorSetUpOwedForLayout';
/** The session.ts exports only dashboard layouts may use. */
const LAYOUT_ONLY = [LAYOUT_GATE, LAYOUT_SET_UP_QUESTION];

/** The text without comments, so a mention in prose is not a use. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const isLayout = (rel: string) => /^app\/.*(^|\/)layout\.tsx$/.test(rel);
const dashboardLayout = (rel: string) => rel.startsWith('app/(dashboard)/') && isLayout(rel);

/**
 * redirect() calls in a layout whose target is not a string literal, with the
 * target each one has. Reviewed: none of them is a page under that layout.
 */
const COMPUTED_LAYOUT_REDIRECTS: Record<string, string> = {
  'app/(dashboard)/layout.tsx#await mfaChallengePath()':
    'The authenticator code page, /signin/mfa, carrying the page to come back to: outside the dashboard layout.',
};

/** Rule 2: files other than dashboard layouts and session.ts that use a layout-only export. */
function layoutContextOutsideLayouts(tree: Tree): string[] {
  return [...tree.files]
    .filter(([rel]) => rel !== SESSION && !dashboardLayout(rel))
    .filter(([, text]) => new RegExp(`\\b(${LAYOUT_ONLY.join('|')})\\b`).test(code(text)))
    .map(([rel]) => rel)
    .sort();
}

/** Rule 3: layout files that reach requireOrgContext(), with the chain. */
function layoutsReachingTheGate(tree: Tree): string[] {
  const rendered = tree.graph.reach([`${tree.abs(SESSION)}#${GATE}`], { jsx: true });
  return [...tree.files.keys()]
    .filter(isLayout)
    .filter((rel) => rendered.exportReaches(tree.abs(rel), 'default'))
    .map((rel) => `${rel}: ${rendered.pathToTarget(tree.abs(rel), 'default')?.join(' -> ')}`)
    .sort();
}

/** The URL patterns of the pages under a layout's directory (route groups dropped). */
function pagesUnderLayout(tree: Tree, layout: string): string[][] {
  const dir = path.posix.dirname(layout);
  return [...tree.files.keys()]
    .filter((rel) => rel.startsWith(`${dir}/`) && /(^|\/)page\.tsx$/.test(rel))
    .map((rel) =>
      path.posix
        .dirname(rel)
        .split('/')
        .slice(1)
        .filter((seg) => !/^\(.*\)$/.test(seg)),
    );
}

const matchesPage = (target: string, page: string[]) => {
  const segs = target.split('?')[0]!.split('/').filter(Boolean);
  if (page.some((s) => s.startsWith('[...') || s.startsWith('[[...'))) {
    const fixed = page.findIndex((s) => s.startsWith('[...') || s.startsWith('[[...'));
    return page.slice(0, fixed).every((s, i) => s.startsWith('[') || s === segs[i]);
  }
  return segs.length === page.length && page.every((s, i) => s.startsWith('[') || s === segs[i]);
};

/**
 * Every redirect() and permanentRedirect() call in the text, with its argument
 * read to the matching parenthesis (so a call over several lines, or one with
 * no semicolon after it, is read too) and its white space collapsed. A method
 * of the same name (`NextResponse.redirect(`) is not one.
 */
function redirectCalls(text: string): Array<{ fn: string; arg: string }> {
  const calls: Array<{ fn: string; arg: string }> = [];
  for (const m of code(text).matchAll(/(?<![.\w$])(permanentRedirect|redirect)\(/g)) {
    const src = code(text);
    let depth = 1;
    let quote: string | null = null;
    let i = m.index! + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const arg = src
      .slice(m.index! + m[0].length, i - 1)
      .replace(/\s+/g, ' ')
      .replace(/,\s*$/, '')
      .trim();
    calls.push({ fn: m[1]!, arg });
  }
  return calls;
}

/** The literal target of a redirect argument (its first argument), or null. */
const literalTarget = (arg: string) => /^(['"`])([^'"`$]*)\1(\s*,.*)?$/.exec(arg)?.[2] ?? null;

/** The app's own files a file imports (`@/...` or relative), one level. */
function localImports(tree: Tree, rel: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bfrom\s+['"]((?:@\/|\.)[^'"]+)['"]/g)) {
    const spec = m[1]!;
    const base = spec.startsWith('@/')
      ? spec.slice(2)
      : path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    const hit = ['.ts', '.tsx', '/index.ts', '/index.tsx', '']
      .map((ext) => `${base}${ext}`)
      .find((f) => tree.files.has(f));
    if (hit && hit !== rel) out.add(hit);
  }
  return [...out].sort();
}

/** Rule 4: layout redirects whose target is a page under that layout, or is not reviewed. */
function layoutRedirectsUnderThemselves(tree: Tree, reviewed: Record<string, string>): string[] {
  const problems: string[] = [];
  const under = (pages: string[][], target: string) => pages.some((p) => matchesPage(target, p));
  for (const [rel, text] of tree.files) {
    if (!isLayout(rel)) continue;
    const pages = pagesUnderLayout(tree, rel);
    for (const { fn, arg } of redirectCalls(text)) {
      const target = literalTarget(arg);
      if (target !== null) {
        if (under(pages, target)) {
          problems.push(`${rel}: ${fn}('${target}') is a page under this layout`);
        }
      } else if (!reviewed[`${rel}#${arg}`]) {
        problems.push(`${rel}: ${fn}(${arg}) has a target this guard cannot read`);
      }
    }
    for (const dep of localImports(tree, rel, text)) {
      for (const { fn, arg } of redirectCalls(tree.files.get(dep)!)) {
        const target = literalTarget(arg);
        if (target !== null && under(pages, target)) {
          problems.push(`${rel} -> ${dep}: ${fn}('${target}') is a page under this layout`);
        }
      }
    }
  }
  for (const key of Object.keys(reviewed)) {
    const [rel, arg] = key.split('#') as [string, string];
    const text = tree.files.get(rel);
    if (!text || !redirectCalls(text).some((c) => c.arg === arg)) {
      problems.push(`${key}: listed but no longer there`);
    }
  }
  return problems.sort();
}

/** The body of `function name(...) {...}` up to its closing brace at the start of a line. */
function functionBody(text: string, name: string): string {
  const start = text.search(new RegExp(`\\bfunction ${name}\\b`));
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end === -1 ? undefined : end + 2);
}

/** The body of `export const name = cache(...)` up to the next top-level statement. */
function constBody(text: string, name: string): string {
  const start = text.indexOf(`const ${name} = `);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n});', start);
  return text.slice(start, end === -1 ? undefined : end + 4);
}

describe('authenticator set-up comes first, and no layout redirects for it', () => {
  it('1. requireOrgContext() has one exit, through the set-up question', () => {
    const session = code(REAL.files.get(SESSION)!);
    const body = constBody(session, GATE).replace(/\s+/g, ' ');
    expect(body).toMatch(
      /const \{ ctx, reads \} = await resolveOrgContext\(orgId\); return sendToSetUpWhenOwed\(reads, ctx\); \}\);$/,
    );
    // The resolver is the module's own, and only the two entry points use it.
    expect(session).not.toMatch(/export\s+(const|async function|function)\s+resolveOrgContext\b/);
    expect(session.match(/\bresolveOrgContext\(/g)?.length).toBe(2);
    expect(session).toMatch(/const resolveOrgContext = cache\(/);
    // The set-up question is asked by the wrapper, on the core rule.
    const reach = REAL.graph.reach([
      `${REAL.abs('lib/auth/step-up-gate.ts')}#authenticatorSetUpIsOwed`,
    ]);
    expect(reach.exportReaches(REAL.abs(SESSION), GATE)).toBe(true);
    expect(reach.exportReaches(REAL.abs(SESSION), LAYOUT_GATE)).toBe(false);
    expect(code(REAL.files.get('lib/auth/step-up-gate.ts')!)).toMatch(/authenticatorSetUpOwed\(/);
  });

  it('2. the layout context is used by dashboard layouts only, and still asks the code rule', () => {
    expect(layoutContextOutsideLayouts(REAL)).toEqual([]);
    const users = [...REAL.files.keys()].filter(
      (rel) => dashboardLayout(rel) && code(REAL.files.get(rel)!).includes(LAYOUT_GATE),
    );
    expect(users).toContain('app/(dashboard)/layout.tsx');
    expect(users).toContain('app/(dashboard)/dashboard/settings/layout.tsx');
    const code_ = REAL.graph.reach([`${REAL.abs('lib/auth/step-up-gate.ts')}#stepUpIsOwed`]);
    expect(code_.exportReaches(REAL.abs(SESSION), LAYOUT_GATE)).toBe(true);
  });

  it('2b. the layout set-up answer asks the page question, redirects to nothing and never reaches requireOrgContext()', () => {
    const session = code(REAL.files.get(SESSION)!);
    const helper = constBody(session, LAYOUT_SET_UP_QUESTION).replace(/\s+/g, ' ');
    expect(helper).toMatch(
      /const ctx = await requireOrgContextForLayout\(\); return setUpOwedOnThisPage\(startStepUpReads\(\), ctx\); \}\);$/,
    );
    const question = functionBody(session, 'setUpOwedOnThisPage');
    for (const [name, body] of [
      [LAYOUT_SET_UP_QUESTION, helper],
      ['setUpOwedOnThisPage', question],
    ] as const) {
      expect(redirectCalls(body), `${name} redirects`).toEqual([]);
      expect(body, name).not.toMatch(/\b(sendToSetUpWhenOwed|requireOrgContext)\(/);
    }
    // The page's wrapper asks the same question.
    expect(functionBody(session, 'sendToSetUpWhenOwed')).toMatch(
      /if \(await setUpOwedOnThisPage\(reads, ctx\)\) redirect\(AUTHENTICATOR_SET_UP_URL\);/,
    );
    const gate = REAL.graph.reach([`${REAL.abs(SESSION)}#${GATE}`]);
    expect(gate.exportReaches(REAL.abs(SESSION), LAYOUT_SET_UP_QUESTION)).toBe(false);
    const rule = REAL.graph.reach([
      `${REAL.abs('lib/auth/step-up-gate.ts')}#authenticatorSetUpIsOwed`,
    ]);
    expect(rule.exportReaches(REAL.abs(SESSION), LAYOUT_SET_UP_QUESTION)).toBe(true);
    const users = [...REAL.files.keys()].filter((rel) =>
      new RegExp(`\\b${LAYOUT_SET_UP_QUESTION}\\b`).test(code(REAL.files.get(rel)!)),
    );
    expect(users).toContain('app/(dashboard)/dashboard/purchase-orders/imports/layout.tsx');
    expect(users).toContain('app/(dashboard)/dashboard/purchase-orders/layout.tsx');
  });

  it('3. no layout reaches requireOrgContext(), by a call or a component it renders', () => {
    expect([...REAL.files.keys()].filter(isLayout).length).toBeGreaterThanOrEqual(10);
    expect(layoutsReachingTheGate(REAL)).toEqual([]);
  });

  it('4. no layout redirects to a page under itself', () => {
    expect(pagesUnderLayout(REAL, 'app/(dashboard)/layout.tsx')).toContainEqual([
      'dashboard',
      'settings',
      'security',
    ]);
    expect(layoutRedirectsUnderThemselves(REAL, COMPUTED_LAYOUT_REDIRECTS)).toEqual([]);
    for (const why of Object.values(COMPUTED_LAYOUT_REDIRECTS))
      expect(why.length).toBeGreaterThan(40);
  });

  it('5. the dashboard layout uses the same rule and open pages, and redirects to nothing for set-up', () => {
    const layout = code(REAL.files.get('app/(dashboard)/layout.tsx')!);
    expect(layout).toMatch(/authenticatorSetUpOwed\(/);
    expect(layout).toMatch(/openBeforeAuthenticatorSetUp\(/);
    expect(layout).toMatch(/<AuthenticatorSetUpPanel \/>/);
    expect(layout).not.toMatch(/AUTHENTICATOR_SET_UP_URL|settings\/security/);
  });

  it('6. no other file writes its own prefix test for the open pages', () => {
    const own = 'lib/auth/authenticator-set-up.ts';
    const offenders = [...REAL.files]
      .filter(([rel]) => rel !== own)
      .filter(([, text]) =>
        /startsWith\(\s*['"`]\/dashboard\/settings\/(security|profile)/.test(text),
      )
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it('7. the open pages: the security page and the profile page, exactly or below after a slash', () => {
    expect(OPEN_BEFORE_AUTHENTICATOR_SET_UP).toEqual([
      '/dashboard/settings/security',
      '/dashboard/settings/profile',
    ]);
    expect(AUTHENTICATOR_SET_UP_URL).toBe(`${AUTHENTICATOR_SET_UP_PAGE}?enroll=1`);
    for (const open of [
      '/dashboard/settings/security',
      '/dashboard/settings/security/',
      '/dashboard/settings/security/anything',
      '/dashboard/settings/profile',
    ]) {
      expect(openBeforeAuthenticatorSetUp(open), open).toBe(true);
    }
    for (const closed of [
      null,
      undefined,
      '',
      '/',
      '/dashboard',
      '/dashboard/settings',
      '/dashboard/settings/security-keys',
      '/dashboard/settings/securityx',
      '/dashboard/settings/profile-old',
      '/dashboard/settings/security?enroll=1',
      '/x/dashboard/settings/security',
    ]) {
      expect(openBeforeAuthenticatorSetUp(closed), String(closed)).toBe(false);
    }
  });

  it('8. signing out never asks for the member context', () => {
    const reach = REAL.graph.reach([`${REAL.abs(SESSION)}#${GATE}`]);
    expect(reach.exportReaches(REAL.abs('server/actions/auth.ts'), 'signOutAction')).toBe(false);
    expect(reach.exportReaches(REAL.abs('server/actions/mfa.ts'), 'enrollFactorAction')).toBe(
      false,
    );
    // Control: an action that does ask is seen as asking.
    expect(
      reach.exportReaches(REAL.abs('server/actions/org-switcher.ts'), 'switchOrganizationAction'),
    ).toBe(true);
  });
});

/* ───────────────────── self-test: each rule can fail ───────────────────── */

describe('self-test: a planted violation is reported', () => {
  const ROOT = '/planted';
  const base: Record<string, string> = {
    [SESSION]: `
      export const requireOrgContext = cache(async () => ({ organizationId: 'o' }));
      export const requireOrgContextForLayout = cache(async () => ({ organizationId: 'o' }));`,
    'app/(dashboard)/dashboard/settings/security/page.tsx': `
      import { requireOrgContext } from '@/lib/auth/session';
      export default async function Page() { await requireOrgContext(); return <p>s</p>; }`,
    'app/(dashboard)/dashboard/items/[id]/page.tsx': `
      import { requireOrgContext } from '@/lib/auth/session';
      export default async function Page() { await requireOrgContext(); return <p>i</p>; }`,
    'components/nav.tsx': `
      import { requireOrgContext } from '@/lib/auth/session';
      export async function Nav() { const c = await requireOrgContext(); return <p>{String(c)}</p>; }`,
  };
  const tree = (files: Record<string, string>) =>
    treeOf(
      Object.entries({ ...base, ...files }).map(([k, text]) => ({ path: `${ROOT}/${k}`, text })),
      ROOT,
    );

  it('2. a page or a component that uses a layout-only export is reported; a layout is not', () => {
    const t = tree({
      'app/(dashboard)/layout.tsx': `
        import { requireOrgContextForLayout } from '@/lib/auth/session';
        export default async function L({ children }) { await requireOrgContextForLayout(); return children; }`,
      'app/(dashboard)/dashboard/x/page.tsx': `
        import { requireOrgContextForLayout } from '@/lib/auth/session';
        export default async function Page() { await requireOrgContextForLayout(); return <p>x</p>; }`,
      'components/bar.tsx': `
        import { requireOrgContextForLayout } from '@/lib/auth/session';
        export async function Bar() { await requireOrgContextForLayout(); return null; }`,
      'app/(dashboard)/dashboard/y/page.tsx': `
        import { authenticatorSetUpOwedForLayout } from '@/lib/auth/session';
        export default async function Page() { return (await authenticatorSetUpOwedForLayout()) ? null : <p>y</p>; }`,
      'app/(dashboard)/dashboard/y/layout.tsx': `
        import { authenticatorSetUpOwedForLayout } from '@/lib/auth/session';
        export default async function L({ children }) { await authenticatorSetUpOwedForLayout(); return children; }`,
    });
    expect(layoutContextOutsideLayouts(t)).toEqual([
      'app/(dashboard)/dashboard/x/page.tsx',
      'app/(dashboard)/dashboard/y/page.tsx',
      'components/bar.tsx',
    ]);
  });

  it('3. a layout that asks requireOrgContext(), or renders a component that does, is reported', () => {
    const t = tree({
      'app/(dashboard)/layout.tsx': `
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function L({ children }) { await requireOrgContext(); return children; }`,
      'app/(dashboard)/dashboard/settings/layout.tsx': `
        import { Nav } from '@/components/nav';
        export default function L({ children }) { return <><Nav />{children}</>; }`,
      'app/(dashboard)/dashboard/reports/layout.tsx': `
        import { requireOrgContextForLayout } from '@/lib/auth/session';
        export default async function L({ children }) { await requireOrgContextForLayout(); return children; }`,
    });
    expect(layoutsReachingTheGate(t).map((l) => l.split(':')[0])).toEqual([
      'app/(dashboard)/dashboard/settings/layout.tsx',
      'app/(dashboard)/layout.tsx',
    ]);
  });

  it('4. a layout that redirects to a page under itself, or to a target nobody read, is reported', () => {
    const t = tree({
      'app/(dashboard)/layout.tsx': `
        import { gate } from '@/lib/gate';
        import { Guard } from './guard';
        export default async function L({ children }) {
          if (a) redirect('/dashboard/settings/security?enroll=1');
          if (b) redirect('/signin/mfa');
          if (c) redirect(someTarget());
          if (d) return redirect('/dashboard/settings/profile')
          if (e) permanentRedirect('/dashboard/items/7');
          if (f) redirect(
            '/dashboard/items/8',
          );
          if (g) return NextResponse.redirect('/dashboard/items/9');
          await gate();
          return <Guard>{children}</Guard>;
        }`,
      'lib/gate.ts': `
        export async function gate() { if (x) redirect('/dashboard/items/10'); redirect(elsewhere()); }`,
      'app/(dashboard)/guard.tsx': `
        export async function Guard({ children }) { if (y) permanentRedirect('/dashboard'); return children; }`,
      'app/(dashboard)/dashboard/page.tsx': `export default function P() { return null; }`,
      'app/(dashboard)/dashboard/settings/profile/page.tsx': `export default function P() { return null; }`,
      'app/(dashboard)/dashboard/items/layout.tsx': `
        export default async function L({ children }) {
          if (a) redirect('/dashboard/items/42');
          if (b) redirect('/dashboard');
          return children;
        }`,
    });
    expect(
      layoutRedirectsUnderThemselves(t, { 'app/(dashboard)/layout.tsx#gone()': 'x'.repeat(41) }),
    ).toEqual([
      "app/(dashboard)/dashboard/items/layout.tsx: redirect('/dashboard/items/42') is a page under this layout",
      "app/(dashboard)/layout.tsx -> app/(dashboard)/guard.tsx: permanentRedirect('/dashboard') is a page under this layout",
      "app/(dashboard)/layout.tsx -> lib/gate.ts: redirect('/dashboard/items/10') is a page under this layout",
      'app/(dashboard)/layout.tsx#gone(): listed but no longer there',
      "app/(dashboard)/layout.tsx: permanentRedirect('/dashboard/items/7') is a page under this layout",
      "app/(dashboard)/layout.tsx: redirect('/dashboard/items/8') is a page under this layout",
      "app/(dashboard)/layout.tsx: redirect('/dashboard/settings/profile') is a page under this layout",
      "app/(dashboard)/layout.tsx: redirect('/dashboard/settings/security?enroll=1') is a page under this layout",
      'app/(dashboard)/layout.tsx: redirect(someTarget()) has a target this guard cannot read',
    ]);
  });
});
