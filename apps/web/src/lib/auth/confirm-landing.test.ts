import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CONFIRM_FALLBACK_LANDING, CONFIRM_LANDINGS, confirmLanding } from './confirm-landing';

/**
 * Security invariant (docket S14 review, INV-E5): where an emailed
 * confirmation link lands is fixed by its type, not chosen by the link.
 *
 * Any page can send a browser to /auth/confirm with a link it holds for its
 * own account and its own `next`; the person then presses the button on the
 * app's own page (the post is same-origin, so Sec-Fetch-Site cannot tell). With
 * `next` free, that page also chose where its account opened: a data-entry
 * page, Billing, an integration to connect. Each type now lands where the app's
 * own emails and its sign-in tools send it, and the sweeps below fail when an
 * email or a test harness starts sending another landing without this list
 * being changed with it.
 *
 * Docket S25: every link also carries `r`, the account it is for, signed by
 * our server, so the page can name that account before anyone presses. The
 * sweeps hold every link the app emails to the one function that signs it
 * (confirmLinkUrl), with the user id GoTrue gave for the link, and every
 * harness link to carrying `r`. They read the syntax tree of every source
 * that names a link, the writer or GoTrue's link call, so that:
 *   - the reviewed builders are the only sources that ask GoTrue for a link
 *     token, each as many times as reviewed, and each writes its link through
 *     confirmLinkUrl;
 *   - no other source names the page's path, however it would write a link;
 *   - outside the app's sources, only the two sign-in harnesses do either.
 * And the page is the only place a link's token is spent: one verifyOtp call
 * in the whole repository, reached only after the page's POST has asked for
 * the field its press gate adds to a press it let through.
 */

// ─────────────────────────────────────────────────────────────────────────
// What the sweeps read in a source, on its syntax tree: a comment is no use.
// ─────────────────────────────────────────────────────────────────────────

/** One confirmLinkUrl({...}) call: each property as written in the source. */
type LinkCall = Record<'type' | 'tokenHash' | 'userId' | 'next', string | undefined>;

interface Reading {
  /** The confirmLinkUrl({...}) calls. */
  calls: LinkCall[];
  /**
   * The link tokens it asks GoTrue for: calls of auth.admin.generateLink, and
   * literals that name the admin API's generate_link path.
   */
  mints: number;
  /** Uses of generateLink that are not such a call (an alias, a reference handed on): read by hand. */
  unread: string[];
  /** Whether it names GoTrue's link call at all, in code or in a literal. */
  namesTheMint: boolean;
  /** Its string, template and JSX text literals that name the /auth/confirm path. */
  paths: string[];
}

/** The reading of a source that names nothing the sweeps read. It is never parsed. */
const NOTHING: Reading = { calls: [], mints: 0, unread: [], namesTheMint: false, paths: [] };

/** A source that names none of these holds nothing the sweeps read. */
const NAMES_A_LINK = /confirmLinkUrl|generateLink|generate_link|auth\/confirm/;
/** The page's path in a literal, not the modules beside it (auth/confirm-link, -landing, -recipient). */
const CONFIRM_PATH = /\bauth\/confirm(?![\w-])/;
/** The admin API's path in a literal: the path itself or the end of a URL, not a sentence about it. */
const MINT_PATH = /(?:^|\/)generate_link(?![\w ])/;

function scriptKind(name: string): ts.ScriptKind {
  if (/\.tsx$/.test(name)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(name)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(name)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function linkCall(node: ts.CallExpression, file: ts.SourceFile): LinkCall {
  const [arg] = node.arguments;
  const call: LinkCall = {
    type: undefined,
    tokenHash: undefined,
    userId: undefined,
    next: undefined,
  };
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    call.type = `<not an object literal: ${arg?.getText(file) ?? 'none'}>`;
    return call;
  }
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const key = prop.name.text as keyof LinkCall;
      if (key in call) call[key] = prop.initializer.getText(file);
      else call.type = `<unexpected property ${key}>`;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text as keyof LinkCall;
      if (key in call) call[key] = prop.name.text;
      else call.type = `<unexpected property ${key}>`;
    } else {
      call.type = `<unreadable property: ${prop.getText(file)}>`;
    }
  }
  return call;
}

function readSource(name: string, src: string): Reading {
  const file = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, scriptKind(name));
  const reading: Reading = { calls: [], mints: 0, unread: [], namesTheMint: false, paths: [] };
  const where = (node: ts.Node) =>
    `line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${node.parent
      .getText(file)
      .replace(/\s+/g, ' ')
      .slice(0, 80)}`;
  /** Whether `access` (x.generateLink or x['generateLink']) is what a call calls. */
  const called = (access: ts.Node) =>
    ts.isCallExpression(access.parent) && access.parent.expression === access;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'confirmLinkUrl'
    ) {
      reading.calls.push(linkCall(node, file));
    }
    if (ts.isIdentifier(node) && node.text === 'generateLink') {
      reading.namesTheMint = true;
      const access = node.parent;
      if (ts.isPropertyAccessExpression(access) && access.name === node && called(access)) {
        reading.mints += 1;
      } else {
        reading.unread.push(where(node));
      }
    } else if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateLiteralToken(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text;
      if (/generate_link|generateLink/.test(text)) reading.namesTheMint = true;
      if (text === 'generateLink') {
        const access = node.parent;
        if (
          ts.isElementAccessExpression(access) &&
          access.argumentExpression === node &&
          called(access)
        ) {
          reading.mints += 1;
        } else {
          reading.unread.push(where(node));
        }
      } else if (MINT_PATH.test(text)) {
        reading.mints += 1;
      }
      // An import names a module, not a page.
      const names = !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent);
      if (names && CONFIRM_PATH.test(text)) reading.paths.push(text.replace(/\s+/g, ' ').trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reading;
}

/**
 * How many times a source uses GoTrue's token-spending call in code: the
 * name as an identifier or as a quoted property name. A comment is no use.
 */
function spends(name: string, src: string): number {
  const file = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, scriptKind(name));
  let uses = 0;
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
      node.text === 'verifyOtp'
    ) {
      uses += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}

/**
 * A file's reading, made once. Only a file that names something the sweeps
 * read is parsed: parsing every source for each sweep took most of the
 * suite's time limit on a busy machine.
 */
const READINGS = new Map<string, Reading>();
function reading(file: string, src: string): Reading {
  let found = READINGS.get(file);
  if (!found) {
    found = NAMES_A_LINK.test(src) ? readSource(file, src) : NOTHING;
    READINGS.set(file, found);
  }
  return found;
}

describe('confirmLanding', () => {
  it("each type keeps the landings the app's own emails and sign-in tools use", () => {
    expect(confirmLanding('recovery', '/reset/complete')).toBe('/reset/complete');
    expect(confirmLanding('invite', '/reset/complete')).toBe('/reset/complete');
    expect(confirmLanding('invite', '/portal')).toBe('/portal');
    expect(confirmLanding('magiclink', '/portal')).toBe('/portal');
    expect(confirmLanding('magiclink', '/dashboard')).toBe('/dashboard');
  });

  it('any other next lands on the first landing of its type: never a page inside the account', () => {
    for (const next of [
      '/dashboard/items/new',
      '/dashboard/settings/billing',
      '/dashboard/settings/integrations',
      '/portal/x',
      '/',
      '',
    ]) {
      expect(confirmLanding('recovery', next), next).toBe('/reset/complete');
      expect(confirmLanding('invite', next), next).toBe('/reset/complete');
      expect(confirmLanding('magiclink', next), next).toBe('/dashboard');
    }
    expect(confirmLanding('recovery', '/dashboard')).toBe('/reset/complete');
    expect(confirmLanding('invite', '/dashboard')).toBe('/reset/complete');
    expect(confirmLanding('recovery', null)).toBe('/reset/complete');
    expect(confirmLanding('magiclink', undefined)).toBe('/dashboard');
  });

  it('only an exact landing matches (no prefix, case, whitespace or protocol-relative variant)', () => {
    for (const next of [
      '/portal/',
      '/Portal',
      ' /portal',
      '/portal\t',
      '//portal',
      '/reset/complete?x=1',
      'https://evil.example/portal',
      '/dashboard/',
      '/Dashboard',
      '/dashboard#x',
    ]) {
      expect(confirmLanding('magiclink', next), JSON.stringify(next)).toBe('/dashboard');
      expect(confirmLanding('recovery', next), JSON.stringify(next)).toBe('/reset/complete');
    }
  });

  it('a type the list does not know lands on the default, never on next (and never throws)', () => {
    for (const type of ['signup', 'email_change', 'constructor', '__proto__', 'toString', '']) {
      expect(confirmLanding(type, '/dashboard/items/new'), type).toBe(CONFIRM_FALLBACK_LANDING);
    }
    expect(CONFIRM_FALLBACK_LANDING).toBe('/dashboard');
  });

  it('every landing is a path on this origin', () => {
    for (const landings of Object.values(CONFIRM_LANDINGS)) {
      for (const landing of landings) expect(landing).toMatch(/^\/[a-z]/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The builders. Every /auth/confirm link the app emails is written by ONE
// function, confirmLinkUrl (lib/auth/confirm-link.ts), which signs `r`, the
// account the link is for (docket S25). Each builder hands it a (type, next)
// that must be a landing the route keeps, or the route would quietly send
// that email's readers somewhere else, and the user id GoTrue gave it for the
// link, or the page would name the wrong account.
// ─────────────────────────────────────────────────────────────────────────
describe("the app's confirmation emails land where the route sends them", () => {
  const WEB_SRC = path.resolve(__dirname, '../..');

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  const SOURCES = sources(WEB_SRC).map((file) => ({
    file,
    rel: path.relative(WEB_SRC, file).split(path.sep).join('/'),
    src: readFileSync(file, 'utf8'),
  }));

  const WRITER = 'lib/auth/confirm-link.ts';
  const ROUTE = 'app/auth/confirm/route.ts';

  /**
   * The reviewed builders, and how many link tokens each asks GoTrue for. One
   * list for every sweep below: a builder is a source that asks GoTrue for a
   * link token AND writes its link through confirmLinkUrl. A new builder, or
   * one more token in a builder listed here, is checked against the landings
   * and the user id before this list changes.
   */
  const BUILDERS: Record<string, number> = {
    'app/api/admin/qa-recovery-link/route.ts': 1,
    'lib/auth/password-reset-email.ts': 1,
    'server/actions/platform-admin.ts': 1,
    // An invite, or a sign-in link when the address already has an account:
    // two tokens asked for at most, one link written.
    'server/services/customers.ts': 2,
    // One token for each address, and a link for each.
    'server/services/email-change.ts': 2,
  };

  it('only confirmLinkUrl writes an /auth/confirm link (a builder cannot leave out r)', () => {
    const writers = SOURCES.filter(({ src }) => /\/auth\/confirm\?token_hash=\$\{/.test(src)).map(
      ({ rel }) => rel,
    );
    expect(writers).toEqual([WRITER]);
  });

  it("no other source names the page's path, however it would write a link", () => {
    const naming = Object.fromEntries(
      SOURCES.map(({ file, rel, src }) => [rel, reading(file, src).paths] as const).filter(
        ([, paths]) => paths.length > 0,
      ),
    );
    expect(Object.keys(naming).sort()).toEqual([ROUTE, WRITER]);
    // The writer names it once, in the link it writes.
    expect(naming[WRITER]).toEqual(['/auth/confirm?token_hash=']);
    // The page names itself in its form's action and in its log lines.
    expect(
      naming[ROUTE]!.filter(
        (text) => !text.includes('action="/auth/confirm"') && !text.startsWith('[auth/confirm] '),
      ),
    ).toEqual([]);
    // The reading is not blind: the URL API, another parameter order and the
    // text of an email's markup are read; a comment and a module are not.
    const paths = (name: string, src: string) => readSource(name, src).paths.length;
    expect(paths('a.ts', "new URL('/auth/confirm', base);")).toBe(1);
    expect(paths('a.ts', 'const u = `${base}/auth/confirm?type=recovery&token_hash=${h}`;')).toBe(
      1,
    );
    expect(paths('a.tsx', 'const a = <p>{base}/auth/confirm?token_hash={h}</p>;')).toBe(1);
    expect(
      paths('a.ts', "// /auth/confirm\nimport { x } from '@/app/auth/confirm/press-gate';"),
    ).toBe(0);
    expect(paths('a.ts', "const m = await import('@/lib/auth/confirm-link');")).toBe(0);
  });

  it("only the confirmation page spends a link's token, once, after it has asked for the press gate's field", () => {
    const spenders = Object.fromEntries(
      SOURCES.filter(({ src }) => src.includes('verifyOtp'))
        .map(({ rel, src }) => [rel, spends(rel, src)] as const)
        .filter(([, uses]) => uses > 0),
    );
    expect(spenders).toEqual({ [ROUTE]: 1 });
    // In the page's POST, the question comes before the link's account
    // reference is read, before the session client exists and before the
    // token is spent.
    const route = SOURCES.find(({ rel }) => rel === ROUTE)!.src;
    const post = route.slice(route.indexOf('export async function POST('));
    const asked = post.indexOf(
      'if (form?.get(PRESS_GATE_PASSED_FIELD) !== PRESS_GATE_PASSED_VALUE) {',
    );
    expect(asked).toBeGreaterThan(-1);
    for (const later of ['verifyConfirmRecipient(', 'createClient(', '.verifyOtp(']) {
      expect(post.indexOf(later), later).toBeGreaterThan(asked);
    }
    // The reading is not blind: a call and a quoted property name are read, a
    // comment is not.
    expect(spends('a.ts', 'await supabase.auth.verifyOtp({ type, token_hash });')).toBe(1);
    expect(spends('a.ts', "await supabase.auth['verifyOtp'](args);")).toBe(1);
    expect(spends('a.ts', 'const { verifyOtp: spend } = supabase.auth;')).toBe(1);
    expect(spends('a.ts', '// verifyOtp runs in the page only\nexport {};')).toBe(0);
  });

  it('the builders are the five reviewed ones (a new one must be checked against the landings)', () => {
    const builders = SOURCES.filter(
      ({ file, rel, src }) => rel !== WRITER && reading(file, src).calls.length > 0,
    ).map(({ rel }) => rel);
    expect(builders.sort()).toEqual(Object.keys(BUILDERS).sort());
    // Nothing else names the builder without calling it the way the sweep reads.
    for (const { file, rel, src } of SOURCES) {
      if (rel === WRITER) continue;
      const named = (src.match(/\bconfirmLinkUrl\(/g) ?? []).length;
      expect(reading(file, src).calls.length, rel).toBe(named);
    }
  });

  it('only those builders ask GoTrue for a link token, each as many times as reviewed', () => {
    // The same list as the callers of confirmLinkUrl above: a source cannot
    // be listed as one and not be the other.
    const minters = SOURCES.filter(({ file, src }) => reading(file, src).namesTheMint).map(
      ({ rel }) => rel,
    );
    expect(minters.sort()).toEqual(Object.keys(BUILDERS).sort());
    // One more token in a listed builder changes its count.
    const mints = Object.fromEntries(
      SOURCES.map(({ file, rel, src }) => [rel, reading(file, src).mints] as const).filter(
        ([, count]) => count > 0,
      ),
    );
    expect(mints).toEqual(BUILDERS);
    expect(
      SOURCES.flatMap(({ file, rel, src }) =>
        reading(file, src).unread.map((use) => `${rel} ${use}`),
      ),
    ).toEqual([]);
    // The reading is not blind: a comment is no use, a call or the path is.
    const read = (src: string) => {
      const { mints: count, unread, namesTheMint } = readSource('a.ts', src);
      return [count, unread.length, namesTheMint];
    };
    expect(read('// admin.generateLink({ type })\nexport {};')).toEqual([0, 0, false]);
    expect(read('await admin.auth.admin.generateLink({ type });')).toEqual([1, 0, true]);
    expect(read("await admin.auth.admin['generateLink']({ type });")).toEqual([1, 0, true]);
    expect(read('fetch(`${base}/auth/v1/admin/generate_link`);')).toEqual([1, 0, true]);
    expect(read("fetch(new URL('generate_link', adminApi));")).toEqual([1, 0, true]);
    // One name can be called any number of times: not counted, read by hand.
    expect(read('const mint = admin.auth.admin.generateLink.bind(admin.auth.admin);')).toEqual([
      0,
      1,
      true,
    ]);
    expect(read("const mint = admin.auth.admin['generateLink'];")).toEqual([0, 1, true]);
    // A sentence about the call asks for nothing, but the source names it.
    expect(read("throw new Error('generateLink(recovery) returned no hashed_token');")).toEqual([
      0,
      0,
      true,
    ]);
    expect(read('throw new Error(`generate_link ${res.status}`);')).toEqual([0, 0, true]);
  });

  it('each builder sends a kept landing, signed for the user id GoTrue gave it for the link', () => {
    const found = Object.fromEntries(
      SOURCES.filter(({ rel }) => rel !== WRITER)
        .map(({ file, rel, src }) => [rel, reading(file, src).calls] as const)
        .filter(([, calls]) => calls.length > 0)
        .map(([rel, calls]) => [rel, calls.map(({ tokenHash: _t, ...rest }) => rest)]),
    );
    expect(found).toEqual({
      'app/api/admin/qa-recovery-link/route.ts': [
        { type: "'recovery'", next: "'/reset/complete'", userId: 'data?.user?.id' },
      ],
      'lib/auth/password-reset-email.ts': [
        { type: "'recovery'", next: "'/reset/complete'", userId: 'data?.user?.id' },
      ],
      'server/actions/platform-admin.ts': [
        { type: "'invite'", next: "'/reset/complete'", userId: 'newUserId' },
      ],
      'server/services/customers.ts': [
        { type: 'linkType', next: "'/portal'", userId: 'authUserId' },
      ],
      // The email change carries no next: the route fixes its destination.
      'server/services/email-change.ts': [
        { type: "'email_change'", next: undefined, userId: 'userId' },
        { type: "'email_change'", next: undefined, userId: 'userId' },
      ],
    });
    for (const [rel, calls] of Object.entries(found)) {
      for (const { type, next } of calls) {
        if (!type?.startsWith("'") || !next) continue;
        const [t, n] = [type.slice(1, -1), next.slice(1, -1)];
        expect([rel, confirmLanding(t, n)]).toEqual([rel, n]);
      }
    }
  });

  it('the sweeps parse only the sources that name a link, the writer or GoTrue link call', () => {
    // Every source was once parsed for each sweep, which took most of the
    // suite's time limit on a busy machine. A source that names none of the
    // three holds nothing the sweeps read, so it is never parsed.
    const parsed = SOURCES.filter(({ file, src }) => reading(file, src) !== NOTHING).length;
    expect(SOURCES.length).toBeGreaterThan(1000);
    expect(parsed).toBeGreaterThanOrEqual(Object.keys(BUILDERS).length + 2);
    expect(parsed).toBeLessThan(SOURCES.length / 10);
  });

  it('the user ids are the ones GoTrue returned with each link', () => {
    const src = (rel: string) => SOURCES.find((s) => s.rel === rel)!.src;
    // The recovery links: generateLink's own answer (data.user is the account).
    for (const rel of [
      'lib/auth/password-reset-email.ts',
      'app/api/admin/qa-recovery-link/route.ts',
    ]) {
      expect(src(rel), rel).toMatch(
        /const \{ data, error(?:: \w+)? \} = await admin\.auth\.admin\.generateLink\(\{\s+type: 'recovery',/,
      );
    }
    expect(src('server/actions/platform-admin.ts')).toContain('const newUserId = invited.user.id;');
    expect(src('server/services/customers.ts')).toContain(
      'const authUserId = linkRes.data?.user?.id;',
    );
    // The email change: the account whose change it is, which both links belong to.
    const change = src('server/services/email-change.ts');
    expect(change).toContain(
      'const links = await mintEmailChangeLinks(currentEmail, newEmail, args.userId);',
    );
    expect(change).toContain(
      'const links = await mintEmailChangeLinks(user.email, pending, args.userId);',
    );
  });

  it('the portal invite (invite for a new user, magiclink for an existing one) lands on /portal under both types', () => {
    const src = readFileSync(path.join(WEB_SRC, 'server/services/customers.ts'), 'utf8');
    expect(src).toMatch(/let linkType: 'invite' \| 'magiclink' = 'invite';/);
    expect(confirmLanding('invite', '/portal')).toBe('/portal');
    expect(confirmLanding('magiclink', '/portal')).toBe('/portal');
  });

  it('the portal invite signs its link before it maps the person to the customer', () => {
    const src = readFileSync(path.join(WEB_SRC, 'server/services/customers.ts'), 'utf8');
    const signed = src.indexOf('confirmLinkUrl({');
    const mapped = src.indexOf(".from('customer_users')\n      .upsert(");
    expect(signed).toBeGreaterThan(-1);
    expect(mapped).toBeGreaterThan(signed);
  });
});

// The test harnesses sign in the same way, with links they mint through the
// admin API (never emailed): the perf harness and the lab's trace-nav open a
// magic link and wait for the dashboard. Their landings must be kept, and each
// link must carry r, signed with the stack's own service key (docket S25), or
// a run stops at sign-in. The sweeps read every code file of the repository
// outside the app's sources (the phone app, the packages, the scripts, the
// load tests, the database files, the workflows), so a new harness anywhere,
// or anything else there that mints or opens such a link, is seen.
describe("the repository's sign-in harnesses land where they wait", () => {
  const REPO = path.resolve(__dirname, '../../../../..');
  const WEB_SRC = path.join(REPO, 'apps/web/src');
  const TRACE = 'apps/web/scripts/perf-lab/lab/trace-nav.mjs';
  const SETUP = 'apps/web/tests/perf/auth.setup.ts';

  /** Folders that hold none of the repository's code: installed packages, build output, local state. */
  const NOT_CODE = new Set([
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'logs',
    'secrets',
    'playwright-report',
    'test-results',
    'perf-results',
    '__pycache__',
    'Pods',
  ]);
  const GENERATED = new Set(['apps/mobile/ios', 'apps/mobile/android', 'load-tests/results']);
  /** Files the syntax tree reads: comments in them are not uses. */
  const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
  /** Other files that can run, or that a deploy reads: taken as plain text. */
  const OTHER_CODE = /\.(?:sh|bash|zsh|py|rb|ya?ml|json|toml|sql|html?)$/;

  const relative = (file: string) => path.relative(REPO, file).split(path.sep).join('/');

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The app's sources have their own sweeps, above. Hidden folders are
        // tools' own state, the workflows aside.
        const hidden = entry.name.startsWith('.') && entry.name !== '.github';
        if (hidden || NOT_CODE.has(entry.name) || GENERATED.has(relative(full))) continue;
        if (full !== WEB_SRC) out.push(...files(full));
      } else if (
        entry.isFile() &&
        // Never a settings file, whatever it is called.
        !entry.name.startsWith('.env') &&
        (SCRIPT.test(entry.name) || OTHER_CODE.test(entry.name))
      ) {
        out.push(full);
      }
    }
    return out;
  }

  const OUTSIDE = files(REPO).map((file) => ({
    file,
    rel: relative(file),
    src: readFileSync(file, 'utf8'),
  }));
  const SCRIPTS = OUTSIDE.filter(({ rel }) => SCRIPT.test(rel));

  it('the sweep reads the whole repository outside the app sources', () => {
    const folders = new Set(OUTSIDE.map(({ rel }) => rel.split('/').slice(0, 2).join('/')));
    for (const folder of [
      'apps/mobile',
      'apps/web',
      'packages/core',
      'scripts/security-test.sh',
      'load-tests/k6',
      'supabase/migrations',
      '.github/workflows',
    ]) {
      expect(folders.has(folder), folder).toBe(true);
    }
    expect(OUTSIDE.some(({ rel }) => rel.startsWith('apps/web/src/'))).toBe(false);
    expect(OUTSIDE.some(({ rel }) => /(^|\/)(node_modules|\.env[^/]*)(\/|$)/.test(rel))).toBe(
      false,
    );
  });

  it('each (type, next) a harness opens is a landing the route keeps, and carries r', () => {
    const pairs: string[] = [];
    for (const { rel, src } of OUTSIDE) {
      for (const m of src.matchAll(
        /\/auth\/confirm\?token_hash=[^&\s]+&type=([a-z_]+)&next=([^`'"&\s]+)(&r=\$\{[^}]+\})?/g,
      )) {
        const next = decodeURIComponent(m[2]!);
        pairs.push(`${rel} ${m[1]} ${next}${m[3] ? ' r' : ''}`);
        expect([rel, confirmLanding(m[1]!, next)]).toEqual([rel, next]);
      }
    }
    expect(pairs.sort()).toEqual([
      `${TRACE} magiclink /dashboard r`,
      `${SETUP} magiclink /dashboard r`,
    ]);
  });

  it('only those two harnesses ask GoTrue for a link token, once each', () => {
    // Named anywhere in the file, a comment included.
    const minters = OUTSIDE.filter(({ src }) => /generate_link|generateLink/.test(src)).map(
      ({ rel }) => rel,
    );
    expect(minters.sort()).toEqual([TRACE, SETUP]);
    // One more token in a listed harness changes its count.
    const mints = Object.fromEntries(
      SCRIPTS.map(({ file, rel, src }) => [rel, reading(file, src).mints] as const).filter(
        ([, count]) => count > 0,
      ),
    );
    expect(mints).toEqual({ [TRACE]: 1, [SETUP]: 1 });
    expect(
      SCRIPTS.flatMap(({ file, rel, src }) =>
        reading(file, src).unread.map((use) => `${rel} ${use}`),
      ),
    ).toEqual([]);
  });

  it("and only those two name the page's path, each in the one link it opens", () => {
    const naming = Object.fromEntries(
      SCRIPTS.map(({ file, rel, src }) => [rel, reading(file, src).paths] as const).filter(
        ([, paths]) => paths.length > 0,
      ),
    );
    // One literal each: the link the sweep above holds to a kept landing and r.
    expect(naming).toEqual({
      [TRACE]: ['/auth/confirm?token_hash='],
      [SETUP]: ['/auth/confirm?token_hash='],
    });
    // A shell script, a workflow or a database file has no syntax tree here.
    // None names the path, other than as the folder of the page's own tests
    // (scripts/security-test.sh lists auth/confirm/route.test.ts).
    const others = OUTSIDE.filter(
      ({ rel, src }) => !SCRIPT.test(rel) && /\bauth\/confirm(?![\w/-])/.test(src),
    ).map(({ rel }) => rel);
    expect(others).toEqual([]);
  });

  it("no file outside the app's sources spends a link's token, by the client call or by GoTrue's verify path", () => {
    const spenders = OUTSIDE.filter(({ src }) =>
      /verifyOtp|verify_otp|auth\/v1\/verify\b/.test(src),
    ).map(({ rel }) => rel);
    expect(spenders).toEqual([]);
  });

  it('each signs r with the same construction as the app', () => {
    const setup = readFileSync(path.join(REPO, SETUP), 'utf8');
    expect(setup).toContain("from '../../src/lib/auth/confirm-recipient';");
    const trace = readFileSync(path.join(REPO, TRACE), 'utf8');
    // A plain-JavaScript copy; confirm-recipient.test.ts holds it to the
    // app's known-answer vector.
    expect(trace).toContain("from './confirm-recipient.mjs';");
  });

  it('each waits for the press gate to arm before it presses', () => {
    for (const rel of [SETUP, TRACE]) {
      const src = readFileSync(path.join(REPO, rel), 'utf8');
      expect(src, rel).toContain(`button[aria-disabled="false"]`);
    }
  });
});
