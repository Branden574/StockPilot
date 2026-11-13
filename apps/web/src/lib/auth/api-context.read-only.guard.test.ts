import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * withApiContext WRITES NOTHING: the premise the API context gate's marker
 * rests on (docket S26, recurring pattern #27: a premise is pinned, not
 * assumed).
 *
 * The gate (server/lib/api-context-gate.ts) answers a 503 whose details say
 * `nothingWritten` when withApiContext refuses a request because it could not
 * read the caller's account status or permission overrides, and the phone
 * then sends that request again: a stock adjustment or a rental checkout,
 * neither of which carries an idempotency key. That is only safe while
 * building the context does none of the request's work, so a change that
 * taught withApiContext (or anything it loads) to write would make the phone
 * apply an adjustment twice.
 *
 * Two halves:
 *   1. STATIC. The value-import closure of lib/auth/api-context.ts inside
 *      apps/web/src (type-only imports skipped) is pinned, so a new module is
 *      a reviewed change. Over that closure, read on the syntax tree (a comment
 *      or a string never counts), there is no `.insert(`, `.update(` or
 *      `.upsert(` call, no `.delete(` but the three reviewed ones (a Set and two
 *      Headers), no `.rpc(` but the context read itself, no `auth.admin`,
 *      nothing done with a client's auth object but calling one of its three
 *      reads, no other part of a client (storage, functions, realtime, a
 *      channel), and no `fetch` that can write but the error webhook. This half
 *      is the only one that reads the lines no request below runs.
 *   2. BEHAVIOUR. withApiContext runs on both paths, for every way the one
 *      round trip falls back to the separate reads, into both refusals and the
 *      owner's path, for a member with no authenticator and for one whose
 *      session has its code, and for every way the cookie session's level read
 *      can end, against a client that records every call: nothing but reads,
 *      and no other RPC.
 * Plants prove the static half can fail.
 */

const refs = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { AccountStatusUnavailableError } from './account-status';
import { withApiContext } from './api-context';
import { PermissionsUnavailableError } from './effective-permissions';

const WEB_SRC = path.resolve(__dirname, '../..');
const ENTRY = 'lib/auth/api-context.ts';

/* ───────────────────────────── 1. the static half ───────────────────────────── */

/**
 * The value-import closure of lib/auth/api-context.ts, apps/web/src-relative.
 * Re-derived for docket S26 from the import statements (21 modules). A module
 * added here must be read for writes before this list is changed.
 *
 * Read when they joined the closure:
 *   lib/auth/verified-claims.ts  the cookie session's assurance level
 *     (api-context.ts cookieSessionLevel): it loads the session for its access
 *     token (auth.getSession), checks the token (auth.getClaims, or
 *     auth.getUser(token) when the key set cannot be read) and compares the
 *     subject. It loads lib/supabase/server.ts, already listed. The Bearer
 *     path, the phone's, never reaches it: its level is the token's own claim.
 *   lib/error-text.ts  the text of a report (error-reporter-core.ts): strings
 *     in, a string or an Error out. It loads lib/redact-urls.ts, already listed.
 *   lib/chat-text.ts  the text of a report as a chat channel shows it
 *     (error-reporter-core.ts): strings in, strings out. It imports nothing.
 */
const REVIEWED_CLOSURE = [
  'lib/auth/account-status.ts',
  'lib/auth/api-context.ts',
  'lib/auth/cross-site-request.ts',
  'lib/auth/effective-permissions.ts',
  'lib/auth/mfa-policy.ts',
  'lib/auth/request-context-bundle.ts',
  'lib/auth/verified-claims.ts',
  'lib/chat-text.ts',
  'lib/env.ts',
  'lib/error-reporter-core.ts',
  'lib/error-reporter.ts',
  'lib/error-text.ts',
  'lib/modules/effective-modules.ts',
  'lib/redact-urls.ts',
  'lib/share-paths.ts',
  'lib/supabase/middleware.ts',
  'lib/supabase/server.ts',
  'lib/supabase/session-cookies.ts',
  'lib/supabase/url-length-guard.server.ts',
  'lib/supabase/url-length-guard.ts',
  'server/services/lib/defer.ts',
];

/** The three reviewed `.delete(` calls, none on a database: a Set and two Headers. */
const ALLOWED_DELETES = new Set([
  "hosts.delete('')",
  'requestHeaders.delete(SESSION_HEADER_USER_ID)',
  'requestHeaders.delete(SESSION_HEADER_USER_EMAIL)',
]);

/**
 * The reads the context makes on a client's auth object: who the request is
 * (getUser) and, for a cookie session, its assurance level (getSession, then
 * getClaims, then getUser(token) when the token cannot be checked on the
 * server itself: lib/auth/verified-claims.ts). Every other member of that
 * object can change an account or a session.
 */
const AUTH_READS = ['getUser', 'getSession', 'getClaims'];

/**
 * The other parts of a Supabase client. An upload, a function call and a
 * broadcast are none of the methods the rules below name, so reaching one of
 * these parts at all is the finding. Nothing the context loads does.
 */
const OTHER_CLIENT_PARTS = ['storage', 'functions', 'realtime', 'channel'];

/** The error webhook, which writes to no database (lib/error-reporter-core.ts). */
const WEBHOOK_FILE = 'lib/error-reporter-core.ts';

/**
 * The Supabase client's own transport (lib/supabase/url-length-guard.ts): the
 * method is the client's, and every database call it carries is one of the
 * calls this guard reads (a `.from(...)` chain or `.rpc(...)`).
 */
const CLIENT_TRANSPORT = { file: 'lib/supabase/url-length-guard.ts', call: 'fetch(input,init)' };

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

type Resolve = (fromFile: string, specifier: string) => string | null;

/**
 * A resolver over the files `exists` knows: a specifier as an
 * apps/web/src-relative file, null for a package, or `unresolved:<path>`.
 */
function resolverOver(exists: (file: string) => boolean): Resolve {
  return (fromFile, specifier) => {
    let target: string;
    if (specifier.startsWith('@/')) target = specifier.slice(2);
    else if (specifier.startsWith('.'))
      target = path.posix.join(path.posix.dirname(fromFile), specifier);
    else return null;
    target = path.posix.normalize(target).replace(/\.(ts|tsx|js|mjs)$/, '');
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (exists(target + ext)) return target + ext;
    }
    return `unresolved:${target}`;
  };
}

const resolveFile = resolverOver((file) => existsSync(path.join(WEB_SRC, file)));

/** Imports that load code: not `import type`, not an import of types only. */
function loadsCode(st: ts.ImportDeclaration): boolean {
  const clause = st.importClause;
  if (!clause) return true; // `import 'x'`: run for its effects
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.length === 0 || bindings.elements.some((el) => !el.isTypeOnly);
}

/** The modules a file loads, as written: imports, re-exports and dynamic imports. */
function loadedSpecifiers(
  fileName: string,
  source: string,
): { specifiers: string[]; unreadable: string[] } {
  const sf = parse(fileName, source);
  const specifiers: string[] = [];
  const unreadable: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && loadsCode(st)) {
      specifiers.push(st.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
      if (ts.isStringLiteral(st.moduleSpecifier)) specifiers.push(st.moduleSpecifier.text);
    }
  }
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
      else unreadable.push(`${fileName}: a module loaded by an expression, ${n.getText(sf)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { specifiers, unreadable };
}

/** Every apps/web/src module `entry` loads, transitively, and what could not be followed. */
function valueImportClosure(
  entry: string,
  read: (file: string) => string,
  resolve: Resolve = resolveFile,
): { files: string[]; unreadable: string[] } {
  const seen = new Set<string>();
  const unreadable: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const loaded = loadedSpecifiers(file, read(file));
    unreadable.push(...loaded.unreadable);
    for (const specifier of loaded.specifiers) {
      const target = resolve(file, specifier);
      if (target === null) continue;
      if (target.startsWith('unresolved:'))
        unreadable.push(`${file}: ${specifier} does not resolve`);
      else queue.push(target);
    }
  }
  return { files: [...seen].sort(), unreadable };
}

/** The member an access names: `x.m` or `x['m']`. Null for anything else, a computed name included. */
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
    return n.argumentExpression.text;
  }
  return null;
}

/** The method a call names: `x.m(...)` or `x['m'](...)`. */
function calledMethod(call: ts.CallExpression): string | null {
  return memberName(call.expression);
}

/** `rpc('get_request_context', undefined, { get: true })`: the context read, as a GET. */
function isContextRead(call: ts.CallExpression): boolean {
  const [name, args, opts, ...rest] = call.arguments;
  if (rest.length > 0 || !name || !args || !opts) return false;
  if (!ts.isStringLiteralLike(name) || name.text !== 'get_request_context') return false;
  if (!ts.isIdentifier(args) || args.text !== 'undefined') return false;
  if (!ts.isObjectLiteralExpression(opts) || opts.properties.length !== 1) return false;
  const [get] = opts.properties;
  return (
    !!get &&
    ts.isPropertyAssignment(get) &&
    ts.isIdentifier(get.name) &&
    get.name.text === 'get' &&
    get.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

/** `fetch(...)` or `<x>.fetch(...)`. */
function isFetch(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === 'fetch') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch')
  );
}

/** What a fetch asks for: 'read' (no init, or a GET/HEAD), 'write' (any other method), 'unknown' (an init it cannot read). */
function fetchKind(call: ts.CallExpression): 'read' | 'write' | 'unknown' {
  const init = call.arguments[1];
  if (!init) return 'read';
  if (!ts.isObjectLiteralExpression(init)) return 'unknown';
  if (init.properties.some((p) => ts.isSpreadAssignment(p))) return 'unknown';
  const method = init.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method',
  ) as ts.PropertyAssignment | undefined;
  if (!method) return 'read';
  if (!ts.isStringLiteralLike(method.initializer)) return 'unknown';
  return ['GET', 'HEAD'].includes(method.initializer.text.toUpperCase()) ? 'read' : 'write';
}

/** `auth.admin` or `auth['admin']`, on any object. */
function isAuthAdmin(n: ts.Node): boolean {
  const owner = (e: ts.Expression) =>
    (ts.isIdentifier(e) && e.text === 'auth') ||
    (ts.isPropertyAccessExpression(e) && e.name.text === 'auth');
  if (ts.isPropertyAccessExpression(n)) return n.name.text === 'admin' && owner(n.expression);
  if (ts.isElementAccessExpression(n)) {
    return (
      ts.isStringLiteralLike(n.argumentExpression) &&
      n.argumentExpression.text === 'admin' &&
      owner(n.expression)
    );
  }
  return false;
}

/**
 * What is done with a client's auth object where it is reached (`<x>.auth` or
 * `<x>['auth']`), when that is anything but calling one of AUTH_READS on it:
 * another member, a member under a computed name, a read that is taken and
 * not called, or the object itself kept or handed on. Null for a call of a
 * read. `auth.admin` is the rule above.
 */
function authUse(n: ts.Node): string | null {
  if (memberName(n) !== 'auth') return null;
  const use = n.parent;
  const takesMember =
    (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use)) &&
    use.expression === n;
  if (!takesMember) return 'an auth object kept or handed on, not called for one of its reads';
  const member = memberName(use);
  if (member === null) return 'a member of an auth object under a computed name';
  if (member === 'admin') return null;
  if (!AUTH_READS.includes(member)) {
    return `auth.${member}, not one of the reads (${AUTH_READS.join(', ')})`;
  }
  const called = ts.isCallExpression(use.parent) && use.parent.expression === use;
  return called ? null : `auth.${member} taken and not called`;
}

/** A part of a client taken out of an object by name in a binding: `{ auth }`, `{ storage: files }`. */
function partTakenOut(n: ts.Node): string | null {
  if (!ts.isBindingElement(n) || !ts.isObjectBindingPattern(n.parent)) return null;
  if (n.dotDotDotToken) return null; // `{ ...rest }` names what is left, not a member
  const key = n.propertyName ?? n.name;
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return null;
  return key.text === 'auth' || OTHER_CLIENT_PARTS.includes(key.text) ? key.text : null;
}

/** Everything in one file that could write, other than what is reviewed above. */
function writeFindings(fileName: string, source: string): string[] {
  const sf = parse(fileName, source);
  const found: string[] = [];
  const at = (n: ts.Node, what: string) =>
    found.push(`${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${what}`);
  const flat = (n: ts.Node) => n.getText(sf).replace(/\s+/g, '');
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const method = calledMethod(n);
      if (method === 'insert' || method === 'update' || method === 'upsert')
        at(n, `.${method}( call`);
      if (method === 'delete' && !ALLOWED_DELETES.has(flat(n))) at(n, `.delete( call ${flat(n)}`);
      if (method === 'rpc' && !isContextRead(n)) at(n, `.rpc( call ${flat(n)}`);
      if (isFetch(n)) {
        const kind = fetchKind(n);
        const transport = fileName === CLIENT_TRANSPORT.file && flat(n) === CLIENT_TRANSPORT.call;
        if (kind === 'write' && fileName !== WEBHOOK_FILE) at(n, 'fetch with a write method');
        if (kind === 'unknown' && !transport)
          at(n, `fetch with an init this guard cannot read: ${flat(n)}`);
      }
    }
    if (isAuthAdmin(n)) at(n, 'auth.admin');
    const onAuth = authUse(n);
    if (onAuth) at(n, onAuth);
    const part = memberName(n);
    if (part !== null && OTHER_CLIENT_PARTS.includes(part))
      at(n, `.${part}, a part of a client the context does not use`);
    const taken = partTakenOut(n);
    if (taken) at(n, `{ ${taken} } taken out of an object by name`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const readWeb = (file: string) => readFileSync(path.join(WEB_SRC, file), 'utf8');

describe('withApiContext writes nothing: what it loads (static)', () => {
  const closure = valueImportClosure(ENTRY, readWeb);

  it('loads exactly the reviewed modules, every one followed', () => {
    expect(closure.unreadable).toEqual([]);
    expect(closure.files).toEqual(REVIEWED_CLOSURE);
  });

  it("none of them inserts, updates, upserts, deletes, calls another RPC, reaches auth.admin, does anything with a client's auth object but call its reads, reaches another part of a client or fetches a write", () => {
    expect(closure.files.flatMap((file) => writeFindings(file, readWeb(file)))).toEqual([]);
  });

  // A scan that read nothing would pass the rule above: the reviewed calls it
  // allows are really there, where the plan found them.
  it('finds the reviewed calls it allows', () => {
    const all = (needle: RegExp) =>
      closure.files.flatMap((file) =>
        readWeb(file)
          .split('\n')
          .flatMap((line, i) =>
            needle.test(line) && !/^\s*(\*|\/\/)/.test(line) ? [`${file}:${i + 1}`] : [],
          ),
      );
    expect(all(/\.delete\(/)).toHaveLength(3);
    expect(all(/\.rpc\('get_request_context', undefined, \{ get: true \}\)/)).toHaveLength(2);
    // Every read on the auth list is one these modules really make.
    for (const read of AUTH_READS) {
      expect(all(new RegExp(`\\.auth\\.${read}\\(`)), read).not.toEqual([]);
    }
    expect(readWeb(WEBHOOK_FILE)).toMatch(/await fetch\(url, \{\s*method: 'POST'/);
    expect(readWeb(CLIENT_TRANSPORT.file)).toContain('return fetch(input, init);');
  });
});

describe('self-test: the static reading fails on a write', () => {
  const FILE = 'lib/auth/planted.ts';

  it.each([
    ["supabase.from('x').insert({})", '.insert( call'],
    ["supabase.from('x').update({ a: 1 }).eq('id', 1)", '.update( call'],
    ["supabase.from('x').upsert({})", '.upsert( call'],
    ["supabase.from('x')['insert']({})", '.insert( call'],
    ["supabase.from('x').delete().eq('id', 1)", ".delete( call supabase.from('x').delete()"],
    ["x.rpc('adjust_stock')", ".rpc( call x.rpc('adjust_stock')"],
    ["supabase.rpc('get_request_context')", ".rpc( call supabase.rpc('get_request_context')"],
    ["supabase.rpc('get_request_context', undefined, { get: false })", '.rpc( call'],
    ['supabase.auth.admin.deleteUser(id)', 'auth.admin'],
    [
      'supabase.auth.signOut()',
      'auth.signOut, not one of the reads (getUser, getSession, getClaims)',
    ],
    ['(supabase as any).auth.refreshSession()', 'auth.refreshSession, not one of the reads'],
    ['supabase.auth.updateUser({ data: {} })', 'auth.updateUser, not one of the reads'],
    ['supabase.auth.mfa.unenroll({ factorId: id })', 'auth.mfa, not one of the reads'],
    ["supabase['auth'].signOut()", 'auth.signOut, not one of the reads'],
    ["supabase.auth['setSession'](x)", 'auth.setSession, not one of the reads'],
    ['supabase.auth[name]()', 'a member of an auth object under a computed name'],
    ['x(supabase.auth)', 'an auth object kept or handed on'],
    ['x(supabase.auth.getUser)', 'auth.getUser taken and not called'],
    ['(({ auth }: any) => auth.signOut())(supabase)', '{ auth } taken out of an object by name'],
    ["supabase.storage.from('item-images').upload('p', 'x')", '.storage, a part of a client'],
    ["supabase.functions.invoke('notify')", '.functions, a part of a client'],
    ["supabase.channel('org').send({ type: 'broadcast', event: 'e' })", '.channel, a part of'],
    ['supabase.realtime.setAuth()', '.realtime, a part of a client'],
    ['(({ storage: files }: any) => files)(supabase)', '{ storage } taken out of an object'],
    ["fetch(url, { method: 'POST', body: '{}' })", 'fetch with a write method'],
    ["globalThis.fetch(url, { method: 'delete' })", 'fetch with a write method'],
    ['fetch(url, init)', 'fetch with an init this guard cannot read'],
  ])('%s is a finding', (code, finding) => {
    const found = writeFindings(
      FILE,
      `export async function f(supabase: any, x: any, url: string, id: string, init: any, name: string) { await ${code}; }`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(finding);
  });

  it.each([
    ["hosts.delete('')"],
    ['requestHeaders.delete(SESSION_HEADER_USER_ID)'],
    ["supabase.rpc('get_request_context', undefined, { get: true })"],
    ["supabase.from('x').select('a').eq('id', 1).maybeSingle()"],
    ['fetch(url)'],
    ["fetch(url, { method: 'GET' })"],
    ['supabase.auth.getUser()'],
    ['adminAuth.auth.getUser(bearer)'],
    ['supabase.auth.getSession()'],
    ['supabase.auth.getClaims(token)'],
    // A string that happens to be named auth (lib/auth/cross-site-request.ts).
    ['auth?.match(/^Bearer/)'],
    // A client's own settings (lib/auth/api-context.ts).
    ['createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })'],
    ["// supabase.from('x').insert({})"],
    ["'.insert( and auth.admin in a string'"],
    ["// supabase.auth.signOut(); supabase.storage.from('x')"],
    ["'supabase.auth.signOut() and .storage in a string'"],
    // What is left of an object under the name auth, not its auth member.
    ['(({ id, ...auth }: any) => auth)(x)'],
  ])('%s is not', (code) => {
    expect(
      writeFindings(
        FILE,
        `export async function f(supabase: any, hosts: Set<string>, requestHeaders: Headers, url: string) {\n${code};\n}`,
      ),
    ).toEqual([]);
  });

  it('a fetch that writes is allowed only in the error webhook, and the pass-through only as the client transport', () => {
    expect(
      writeFindings(
        WEBHOOK_FILE,
        "export async function f(url: string) { await fetch(url, { method: 'POST' }); }",
      ),
    ).toEqual([]);
    expect(
      writeFindings(
        CLIENT_TRANSPORT.file,
        'export function f(input: any, init: any) { return fetch(input, init); }',
      ),
    ).toEqual([]);
    expect(
      writeFindings(
        CLIENT_TRANSPORT.file,
        'export function f(input: any, opts: any) { return fetch(input, opts); }',
      ),
    ).toHaveLength(1);
  });

  it('the closure follows imports, re-exports and dynamic imports, skips type-only ones, and reports what it cannot follow', () => {
    const files: Record<string, string> = {
      'lib/auth/a.ts': `
        import type { T } from './types-only';
        import { type U } from './also-types';
        import { v } from './b';
        export { w } from '../c';
        export type { X } from './types-too';
        export async function f(name: string) { await import('./d'); await import(name); }`,
      'lib/auth/b.ts': `import './side-effect'; import x from 'a-package';`,
      'lib/c.ts': '',
      'lib/auth/d.ts': `import { z } from './missing';`,
      'lib/auth/side-effect.ts': '',
    };
    const read = (file: string) => {
      const source = files[file];
      if (source === undefined) throw new Error(`the closure read ${file}, which it should not`);
      return source;
    };
    expect(
      valueImportClosure(
        'lib/auth/a.ts',
        read,
        resolverOver((file) => file in files),
      ),
    ).toEqual({
      files: [
        'lib/auth/a.ts',
        'lib/auth/b.ts',
        'lib/auth/d.ts',
        'lib/auth/side-effect.ts',
        'lib/c.ts',
      ],
      unreadable: [
        'lib/auth/a.ts: a module loaded by an expression, import(name)',
        'lib/auth/d.ts: ./missing does not resolve',
      ],
    });
    expect(resolveFile('lib/auth/api-context.ts', '@/lib/env')).toBe('lib/env.ts');
  });
});

/* ──────────────────────────── 2. the behavioural half ──────────────────────────── */

const USER = '99999999-9999-4999-8999-999999999999';
const OTHER_USER = '88888888-8888-4888-8888-888888888888';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';

/** How the one round trip fails over to the separate reads. */
type Trigger = 'off' | 'error' | 'junk' | 'no profile' | 'hidden organization' | 'throw';
/** Where the separate reads end. */
type Ending = 'permissions refused' | 'status refused' | 'owner served';
/** The cookie session as the client has it stored (auth.getSession). */
type StoredSession = 'held' | 'none' | 'unreadable';
/**
 * How the check of the cookie session's token on the server itself goes
 * (auth.getClaims): it passes, it passes for a token of another account, it
 * refuses the token, or it cannot be made (the key set cannot be read, as an
 * answer or as a throw).
 */
type LocalCheck = 'passes' | 'another account' | 'refuses' | 'cannot be made' | 'throws';
/** What the Auth server says about a token it is handed (auth.getUser(token)). */
type AuthServerAnswer = 'accepts' | 'another account' | 'refuses' | 'throws';

const world = {
  trigger: 'error' as Trigger,
  role: 'staff' as 'staff' | 'owner',
  statusReadFails: false,
  overrideReadFails: false,
  /** The account has a verified authenticator factor. */
  enrolled: false,
  /** The level of the session the request comes with (the token's claim, or the cookie session's). */
  aal: 'aal1' as 'aal1' | 'aal2',
  /** How the cookie session's level read goes: the plain way unless a case sets one of these. */
  session: 'held' as StoredSession,
  localCheck: 'passes' as LocalCheck,
  authServer: 'accepts' as AuthServerAnswer,
  calls: [] as string[],
};

function bundle(opts: { profile: boolean; organization: boolean }) {
  return {
    user_id: USER,
    profile: opts.profile
      ? {
          id: USER,
          email: 'person@example.test',
          full_name: null,
          avatar_url: null,
          default_organization_id: ORG,
          disabled_at: null,
        }
      : null,
    memberships: [
      {
        organization_id: ORG,
        role: world.role,
        organization: opts.organization
          ? {
              id: ORG,
              name: 'Org',
              logo_url: null,
              terminology: null,
              mfa_policy: 'optional',
              timezone: null,
              nav_overrides: null,
              dashboard_layout: null,
              order_status_config: null,
              all_modules_comp: false,
              order_catalog_last_hide_at: null,
            }
          : null,
        role_overrides: [],
        user_overrides: [],
        enabled_modules: [],
      },
    ],
  };
}

/** What each table answers on the separate reads. */
function answerFor(table: string): { single: unknown; list: unknown[]; error: unknown } {
  const failed = {
    single: null,
    list: [],
    error: { code: '57014', message: 'canceling statement' },
  };
  if (table === 'user_profiles') {
    return world.statusReadFails
      ? failed
      : { single: { default_organization_id: ORG, disabled_at: null }, list: [], error: null };
  }
  if (table === 'organization_members') {
    return { single: { organization_id: ORG, role: world.role }, list: [], error: null };
  }
  if (table === 'organizations') {
    return { single: { mfa_policy: 'optional', all_modules_comp: false }, list: [], error: null };
  }
  if (table === 'role_permission_overrides' || table === 'user_permission_overrides') {
    return world.overrideReadFails ? failed : { single: null, list: [], error: null };
  }
  return { single: null, list: [], error: null };
}

/**
 * A query builder that records every method called on it, whatever its name,
 * so a write is recorded before anything could fail on it. Awaited, it
 * answers the table's rows.
 */
function recordingBuilder(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          const a = answerFor(table);
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({
              data: a.error ? null : a.list,
              error: a.error,
              status: a.error ? 500 : 200,
            }).then(resolve, reject);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => {
            world.calls.push(`${table}.${prop}`);
            const a = answerFor(table);
            return Promise.resolve({ data: a.error ? null : a.single, error: a.error });
          };
        }
        return () => {
          world.calls.push(`${table}.${prop}`);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

/** Anything reached on the client that is not `from`, `rpc` or `auth`: recorded, and inert. */
function recordingAnything(name: string): unknown {
  return new Proxy(function inert() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      world.calls.push(`${name}.${prop}`);
      return recordingAnything(`${name}.${prop}`);
    },
    apply() {
      world.calls.push(`${name}()`);
      return recordingAnything(`${name}()`);
    },
  });
}

function recordingClient(): unknown {
  const known = {
    from: (table: string) => {
      world.calls.push(`from:${table}`);
      return recordingBuilder(table);
    },
    rpc: async (name: string, args?: unknown, opts?: unknown) => {
      world.calls.push(
        `rpc:${name} ${JSON.stringify(args ?? null)} ${JSON.stringify(opts ?? null)}`,
      );
      if (world.trigger === 'error') return { data: null, error: { code: 'PGRST301' } };
      if (world.trigger === 'throw') throw new Error('socket closed');
      if (world.trigger === 'junk') {
        return { data: { user_id: USER, memberships: 'nope' }, error: null };
      }
      if (world.trigger === 'no profile') {
        return { data: bundle({ profile: false, organization: true }), error: null };
      }
      if (world.trigger === 'hidden organization') {
        return { data: bundle({ profile: true, organization: false }), error: null };
      }
      return { data: bundle({ profile: true, organization: true }), error: null };
    },
    auth: new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          if (prop === 'getUser') {
            return async (token?: string) => {
              world.calls.push('auth.getUser');
              const factors = world.enrolled ? [{ status: 'verified' }] : [];
              // Handed a token, the Auth server answers about that token:
              // the Bearer path's identity read, and the cookie session's
              // level read when the token could not be checked on the server
              // itself. Only the cases about that level read change the answer.
              if (token !== undefined && world.authServer !== 'accepts') {
                if (world.authServer === 'throws') throw new Error('socket closed');
                if (world.authServer === 'refuses') {
                  return { data: { user: null }, error: { name: 'AuthApiError', status: 401 } };
                }
                return { data: { user: { id: OTHER_USER, factors } }, error: null };
              }
              return { data: { user: { id: USER, factors } }, error: null };
            };
          }
          // The cookie session's level (lib/auth/verified-claims.ts): the
          // session's access token, then that token's checked claims.
          if (prop === 'getSession') {
            return async () => {
              world.calls.push('auth.getSession');
              if (world.session === 'unreadable') throw new Error('the cookie would not parse');
              if (world.session === 'none') return { data: { session: null }, error: null };
              return { data: { session: { access_token: tokenWith(world.aal) } }, error: null };
            };
          }
          if (prop === 'getClaims') {
            return async () => {
              world.calls.push('auth.getClaims');
              if (world.localCheck === 'throws') throw new Error('the key would not import');
              if (world.localCheck === 'cannot be made') {
                return { data: null, error: { name: 'AuthRetryableFetchError', status: 503 } };
              }
              if (world.localCheck === 'refuses') {
                return { data: null, error: { name: 'AuthInvalidJwtError', status: 400 } };
              }
              const sub = world.localCheck === 'another account' ? OTHER_USER : USER;
              return { data: { claims: { sub, aal: world.aal } }, error: null };
            };
          }
          world.calls.push(`auth.${prop}`);
          return recordingAnything(`auth.${prop}`);
        },
      },
    ),
  };
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop in target) return target[prop as keyof typeof target];
      world.calls.push(`client.${prop}`);
      return recordingAnything(`client.${prop}`);
    },
  });
}

/** A token whose unverified `aal` claim the Bearer path reads (it is never verified here). */
function tokenWith(aal: 'aal1' | 'aal2'): string {
  return `h.${Buffer.from(JSON.stringify({ sub: USER, aal }), 'utf8').toString('base64url')}.sig`;
}

/** A Bearer request from the phone, and a same-origin cookie request from the web: both POSTs. */
const bearer = () =>
  new Request('https://app.test/api/v1/items/x/adjust', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenWith(world.aal)}`, 'x-organization-id': ORG },
  });
const cookie = () =>
  new Request('https://app.test/api/v1/items/x/adjust', {
    method: 'POST',
    headers: {
      cookie: 'sb-example-auth-token=abc',
      origin: 'https://app.test',
      'sec-fetch-site': 'same-origin',
    },
  });

/** The calls a read-only context is allowed: reads, the context RPC as a GET, and the auth reads. */
function writesIn(calls: string[]): string[] {
  return calls.filter((c) => {
    if (/^from:[a-z_]+$/.test(c)) return false;
    if (/^[a-z_]+\.(select|eq|neq|is|not|in|limit|order|maybeSingle|single)$/.test(c)) return false;
    if (c === 'rpc:get_request_context null {"get":true}') return false;
    if (c === 'auth.getUser' || c === 'auth.getSession' || c === 'auth.getClaims') return false;
    return true;
  });
}

const TRIGGERS: Trigger[] = ['off', 'error', 'junk', 'no profile', 'hidden organization', 'throw'];
const ENDINGS: Ending[] = ['permissions refused', 'status refused', 'owner served'];
const PATHS = [
  ['bearer', bearer],
  ['cookie', cookie],
] as const;

/**
 * Every way the cookie session's level read (lib/auth/verified-claims.ts) can
 * end other than the plain one the cases above take (the token checks out on
 * the server itself): what is set, the auth calls the read then makes after
 * the identity read, and whether it answers the session's level or nothing.
 * No answer counts as not verified, and a member with an authenticator gets
 * no context for it.
 */
interface LevelRead {
  name: string;
  set: { session?: StoredSession; localCheck?: LocalCheck; authServer?: AuthServerAnswer };
  asks: string[];
  answers: boolean;
}
const LEVEL_READS: LevelRead[] = [
  {
    name: 'the server cannot check the token, and the Auth server accepts it',
    set: { localCheck: 'cannot be made' },
    asks: ['auth.getSession', 'auth.getClaims', 'auth.getUser'],
    answers: true,
  },
  {
    name: 'the check of the token throws, and the Auth server accepts it',
    set: { localCheck: 'throws' },
    asks: ['auth.getSession', 'auth.getClaims', 'auth.getUser'],
    answers: true,
  },
  {
    name: 'the server cannot check the token, and the Auth server refuses it',
    set: { localCheck: 'cannot be made', authServer: 'refuses' },
    asks: ['auth.getSession', 'auth.getClaims', 'auth.getUser'],
    answers: false,
  },
  {
    name: 'the server cannot check the token, and the Auth server answers for another account',
    set: { localCheck: 'cannot be made', authServer: 'another account' },
    asks: ['auth.getSession', 'auth.getClaims', 'auth.getUser'],
    answers: false,
  },
  {
    name: 'the check of the token throws, and the Auth server cannot be reached',
    set: { localCheck: 'throws', authServer: 'throws' },
    asks: ['auth.getSession', 'auth.getClaims', 'auth.getUser'],
    answers: false,
  },
  {
    name: 'the server refuses the token itself',
    set: { localCheck: 'refuses' },
    asks: ['auth.getSession', 'auth.getClaims'],
    answers: false,
  },
  {
    name: 'the token is of another account',
    set: { localCheck: 'another account' },
    asks: ['auth.getSession', 'auth.getClaims'],
    answers: false,
  },
  {
    name: 'no session is stored',
    set: { session: 'none' },
    asks: ['auth.getSession'],
    answers: false,
  },
  {
    name: 'the stored session cannot be read',
    set: { session: 'unreadable' },
    asks: ['auth.getSession'],
    answers: false,
  },
];

describe('withApiContext writes nothing: what it does (behaviour)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('this test makes no request');
      }),
    );
    delete process.env.REQUEST_CONTEXT_RPC;
    world.enrolled = false;
    world.aal = 'aal1';
    world.session = 'held';
    world.localCheck = 'passes';
    world.authServer = 'accepts';
    world.calls = [];
    refs.client = recordingClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.REQUEST_CONTEXT_RPC;
  });

  const cases = PATHS.flatMap(([pathName, make]) =>
    TRIGGERS.flatMap((trigger) =>
      ENDINGS.map((ending) => [pathName, trigger, ending, make] as const),
    ),
  );

  it.each(cases)('%s, fallback "%s", %s: reads only', async (_path, trigger, ending, make) => {
    world.trigger = trigger;
    if (trigger === 'off') process.env.REQUEST_CONTEXT_RPC = 'off';
    world.role = ending === 'owner served' ? 'owner' : 'staff';
    world.statusReadFails = ending === 'status refused';
    world.overrideReadFails = ending !== 'status refused';

    const outcome = await withApiContext(make()).then(
      (ctx) => ({ ctx }),
      (error: unknown) => ({ error }),
    );

    if (ending === 'permissions refused') {
      expect(outcome).toEqual({ error: expect.any(PermissionsUnavailableError) });
    } else if (ending === 'status refused') {
      expect(outcome).toEqual({ error: expect.any(AccountStatusUnavailableError) });
    } else {
      expect('ctx' in outcome && outcome.ctx?.role).toBe('owner');
    }
    // It really took the separate reads, and got as far as the refusal's read.
    expect(world.calls).toContain('from:user_profiles');
    expect(world.calls).toContain(
      ending === 'status refused' ? 'user_profiles.maybeSingle' : 'from:user_permission_overrides',
    );
    expect(world.calls.some((c) => c.startsWith('rpc:'))).toBe(trigger !== 'off');
    // And nothing but reads.
    expect(writesIn(world.calls)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  // A member with an authenticator whose session has its code: the level is
  // read on the way (the Bearer token's own claim; on the cookie path the
  // session's checked token, lib/auth/verified-claims.ts), and it is a read.
  it.each(cases)(
    'a session with its authenticator code: %s, fallback "%s", %s: reads only',
    async (pathName, trigger, ending, make) => {
      world.enrolled = true;
      world.aal = 'aal2';
      world.trigger = trigger;
      if (trigger === 'off') process.env.REQUEST_CONTEXT_RPC = 'off';
      world.role = ending === 'owner served' ? 'owner' : 'staff';
      world.statusReadFails = ending === 'status refused';
      world.overrideReadFails = ending !== 'status refused';

      const outcome = await withApiContext(make()).then(
        (ctx) => ({ ctx }),
        (error: unknown) => ({ error }),
      );

      if (ending === 'permissions refused') {
        expect(outcome).toEqual({ error: expect.any(PermissionsUnavailableError) });
      } else if (ending === 'status refused') {
        expect(outcome).toEqual({ error: expect.any(AccountStatusUnavailableError) });
      } else {
        expect('ctx' in outcome && outcome.ctx?.role).toBe('owner');
        expect('ctx' in outcome && outcome.ctx?.mfaSatisfied).toBe(true);
      }
      expect(world.calls).toContain('from:user_profiles');
      // The cookie path read the session's level; the Bearer path has no session to load.
      expect(world.calls.includes('auth.getSession')).toBe(pathName === 'cookie');
      expect(world.calls.includes('auth.getClaims')).toBe(pathName === 'cookie');
      expect(writesIn(world.calls)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  // The same member before the code: no context at all (the route's own 401),
  // and no database call was made for it.
  it.each(PATHS)(
    'a session that still owes its authenticator code: %s gets no context, and nothing is read from the database',
    async (_path, make) => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      world.enrolled = true;
      world.aal = 'aal1';
      await expect(withApiContext(make())).resolves.toBeNull();
      expect(world.calls.filter((c) => c.startsWith('from:') || c.startsWith('rpc:'))).toEqual([]);
      expect(writesIn(world.calls)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  // The cookie session's level read, every other way it can end, for a member
  // with an authenticator whose session has its code. The Bearer path never
  // makes this read: its level is the token's own claim.
  const levelCases = LEVEL_READS.flatMap(
    (read): Array<[string, Ending | 'no context', LevelRead]> =>
      read.answers
        ? ENDINGS.map((ending) => [read.name, ending, read])
        : [[read.name, 'no context', read]],
  );

  it.each(levelCases)(
    "the cookie session's level read, when %s, %s: reads only",
    async (_name, ending, read) => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      world.enrolled = true;
      world.aal = 'aal2';
      Object.assign(world, read.set);
      world.trigger = 'error';
      world.role = ending === 'owner served' ? 'owner' : 'staff';
      world.statusReadFails = ending === 'status refused';
      world.overrideReadFails = ending !== 'status refused';

      const outcome = await withApiContext(cookie()).then(
        (ctx) => ({ ctx }),
        (error: unknown) => ({ error }),
      );

      const database = world.calls.filter((c) => c.startsWith('from:') || c.startsWith('rpc:'));
      if (ending === 'no context') {
        // Not verified: no context, and nothing was read from the database for it.
        expect(outcome).toEqual({ ctx: null });
        expect(database).toEqual([]);
      } else if (ending === 'permissions refused') {
        expect(outcome).toEqual({ error: expect.any(PermissionsUnavailableError) });
      } else if (ending === 'status refused') {
        expect(outcome).toEqual({ error: expect.any(AccountStatusUnavailableError) });
      } else {
        expect('ctx' in outcome && outcome.ctx?.role).toBe('owner');
        expect('ctx' in outcome && outcome.ctx?.mfaSatisfied).toBe(true);
      }
      if (ending !== 'no context') expect(database).toContain('from:user_profiles');
      // It really took this way through the read: the identity, then exactly these.
      expect(world.calls.filter((c) => c.startsWith('auth.'))).toEqual([
        'auth.getUser',
        ...read.asks,
      ]);
      expect(writesIn(world.calls)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('the recording client does record a write, so the rule above can fail', async () => {
    world.trigger = 'error';
    const client = recordingClient() as {
      from: (t: string) => { insert: (r: unknown) => unknown };
      rpc: (n: string) => Promise<unknown>;
      storage: { from: (b: string) => { upload: () => unknown } };
      auth: { admin: { deleteUser: (id: string) => unknown }; signOut: () => unknown };
    };
    client.from('stock_movements').insert({});
    await client.rpc('adjust_stock');
    client.storage.from('item-images').upload();
    client.auth.admin.deleteUser(USER);
    client.auth.signOut();
    expect(writesIn(world.calls)).toEqual([
      'stock_movements.insert',
      'rpc:adjust_stock null null',
      'client.storage',
      'client.storage.from',
      'client.storage.from()',
      'client.storage.from().upload',
      'client.storage.from().upload()',
      'auth.admin',
      'auth.admin.deleteUser',
      'auth.admin.deleteUser()',
      'auth.signOut',
      'auth.signOut()',
    ]);
  });
});
