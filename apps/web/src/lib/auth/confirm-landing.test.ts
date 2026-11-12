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
 * harness link to carrying `r`.
 */

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

  const SOURCES = sources(WEB_SRC).map((f) => ({
    rel: path.relative(WEB_SRC, f).split(path.sep).join('/'),
    src: readFileSync(f, 'utf8'),
  }));

  /** One confirmLinkUrl({...}) call: each property as written in the source. */
  type LinkCall = Record<'type' | 'tokenHash' | 'userId' | 'next', string | undefined>;

  function linkCalls(rel: string, src: string): LinkCall[] {
    const file = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls: LinkCall[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'confirmLinkUrl'
      ) {
        const [arg] = node.arguments;
        const call: LinkCall = {
          type: undefined,
          tokenHash: undefined,
          userId: undefined,
          next: undefined,
        };
        if (!arg || !ts.isObjectLiteralExpression(arg)) {
          call.type = `<not an object literal: ${arg?.getText(file) ?? 'none'}>`;
        } else {
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
        }
        calls.push(call);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return calls;
  }

  it('only confirmLinkUrl writes an /auth/confirm link (a builder cannot leave out r)', () => {
    const writers = SOURCES.filter(({ src }) => /\/auth\/confirm\?token_hash=\$\{/.test(src)).map(
      ({ rel }) => rel,
    );
    expect(writers).toEqual(['lib/auth/confirm-link.ts']);
  });

  it('the builders are the five reviewed ones (a new one must be checked against the landings)', () => {
    const builders = SOURCES.filter(
      ({ rel, src }) => rel !== 'lib/auth/confirm-link.ts' && linkCalls(rel, src).length > 0,
    ).map(({ rel }) => rel);
    expect(builders.sort()).toEqual([
      'app/api/admin/qa-recovery-link/route.ts',
      'lib/auth/password-reset-email.ts',
      'server/actions/platform-admin.ts',
      'server/services/customers.ts',
      'server/services/email-change.ts',
    ]);
    // Nothing else names the builder without calling it the way the sweep reads.
    for (const { rel, src } of SOURCES) {
      if (rel === 'lib/auth/confirm-link.ts') continue;
      const named = (src.match(/\bconfirmLinkUrl\(/g) ?? []).length;
      expect(linkCalls(rel, src).length, rel).toBe(named);
    }
  });

  /**
   * Whether a source asks GoTrue for an emailed-link token: a use of
   * auth.admin.generateLink, or of the admin API's generate_link path. Read on
   * the syntax tree, so a comment naming either is not a use.
   */
  function asksGoTrueForALink(rel: string, src: string): boolean {
    // Most sources name neither; only those that do are parsed.
    if (!/generate_link|generateLink/.test(src)) return false;
    const file = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let asks = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === 'generateLink') asks = true;
      else if (
        (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
        /generate_link|generateLink/.test(node.text)
      ) {
        asks = true;
      }
      if (!asks) ts.forEachChild(node, visit);
    };
    visit(file);
    return asks;
  }

  it('only the five builders ask GoTrue for a link token (a new one must write its link through confirmLinkUrl)', () => {
    const minters = SOURCES.filter(({ rel, src }) => asksGoTrueForALink(rel, src)).map(
      ({ rel }) => rel,
    );
    expect(minters.sort()).toEqual([
      'app/api/admin/qa-recovery-link/route.ts',
      'lib/auth/password-reset-email.ts',
      'server/actions/platform-admin.ts',
      'server/services/customers.ts',
      'server/services/email-change.ts',
    ]);
    // The reading is not blind: a comment is no use, a call or the path is.
    expect(asksGoTrueForALink('a.ts', '// admin.generateLink({ type })\nexport {};')).toBe(false);
    expect(asksGoTrueForALink('a.ts', 'await admin.auth.admin.generateLink({ type });')).toBe(true);
    expect(asksGoTrueForALink('a.ts', "await admin.auth.admin['generateLink']({ type });")).toBe(
      true,
    );
    expect(asksGoTrueForALink('a.ts', 'fetch(`${base}/auth/v1/admin/generate_link`);')).toBe(true);
  });

  it('each builder sends a kept landing, signed for the user id GoTrue gave it for the link', () => {
    const found = Object.fromEntries(
      SOURCES.filter(({ rel }) => rel !== 'lib/auth/confirm-link.ts')
        .map(({ rel, src }) => [rel, linkCalls(rel, src)] as const)
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
// a run stops at sign-in.
describe("the repository's sign-in harnesses land where they wait", () => {
  const WEB_ROOT = path.resolve(__dirname, '../../..');

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules') out.push(...files(full));
      } else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('each (type, next) a harness opens is a landing the route keeps, and carries r', () => {
    const pairs: string[] = [];
    for (const file of [
      ...files(path.join(WEB_ROOT, 'tests')),
      ...files(path.join(WEB_ROOT, 'scripts')),
    ]) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /\/auth\/confirm\?token_hash=[^&\s]+&type=([a-z_]+)&next=([^`'"&\s]+)(&r=\$\{[^}]+\})?/g,
      )) {
        const next = decodeURIComponent(m[2]!);
        const rel = path.relative(WEB_ROOT, file).split(path.sep).join('/');
        pairs.push(`${rel} ${m[1]} ${next}${m[3] ? ' r' : ''}`);
        expect([file, confirmLanding(m[1]!, next)]).toEqual([file, next]);
      }
    }
    expect(pairs.sort()).toEqual([
      'scripts/perf-lab/lab/trace-nav.mjs magiclink /dashboard r',
      'tests/perf/auth.setup.ts magiclink /dashboard r',
    ]);
  });

  it('only those two harnesses ask GoTrue for a link token', () => {
    const minters = [
      ...files(path.join(WEB_ROOT, 'tests')),
      ...files(path.join(WEB_ROOT, 'scripts')),
    ]
      .filter((file) => /generate_link|generateLink/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'));
    expect(minters.sort()).toEqual([
      'scripts/perf-lab/lab/trace-nav.mjs',
      'tests/perf/auth.setup.ts',
    ]);
  });

  it('each signs r with the same construction as the app', () => {
    const setup = readFileSync(path.join(WEB_ROOT, 'tests/perf/auth.setup.ts'), 'utf8');
    expect(setup).toContain("from '../../src/lib/auth/confirm-recipient';");
    const trace = readFileSync(path.join(WEB_ROOT, 'scripts/perf-lab/lab/trace-nav.mjs'), 'utf8');
    // A plain-JavaScript copy; confirm-recipient.test.ts holds it to the
    // app's known-answer vector.
    expect(trace).toContain("from './confirm-recipient.mjs';");
  });

  it('each waits for the press gate to arm before it presses', () => {
    for (const rel of ['tests/perf/auth.setup.ts', 'scripts/perf-lab/lab/trace-nav.mjs']) {
      const src = readFileSync(path.join(WEB_ROOT, rel), 'utf8');
      expect(src, rel).toContain(`button[aria-disabled="false"]`);
    }
  });
});
