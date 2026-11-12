import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { redirect } from 'next/navigation';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { ServiceError } from '@/server/services/context';
import { resolveModule } from '@/test/route-write-handlers';

import { apiContextGate } from './api-context-gate';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

/**
 * The API context gate (docket S26): the one place the server says a request
 * was refused BEFORE ANY WRITE, so the phone may send it again.
 *
 * The phone's stock adjustment and rental checkout routes take no idempotency
 * key. A phone that reads an answer as "nothing was written" when something
 * was sends the same change twice, so the marker must come from exactly one
 * place, wrapping only the read-only context step (the read-only premise is
 * pinned by lib/auth/api-context.read-only.guard.test.ts), and only for the
 * two refusals that step makes when it cannot read an authorization input.
 *
 * Below: the gate itself (withApiContext mocked), then two guards over the
 * source tree, each with plants that prove it can fail:
 *   - one emitter: only the gate builds the marker's body;
 *   - first statement: a route that uses the gate calls it before anything
 *     else, and only the three reviewed routes use it.
 */

function req(init: RequestInit = {}) {
  return new Request('https://app.test/api/v1/items/x/adjust', { method: 'POST', ...init });
}

describe('apiContextGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([
    ['PermissionsUnavailableError', () => new PermissionsUnavailableError()],
    ['AccountStatusUnavailableError', () => new AccountStatusUnavailableError()],
  ])(
    'answers %s with the marker: 503, the core body, Retry-After 5, no-store',
    async (_name, make) => {
      vi.mocked(withApiContext).mockRejectedValueOnce(make());

      const gate = await apiContextGate(req());

      expect('response' in gate).toBe(true);
      if (!('response' in gate)) return;
      expect(gate.response.status).toBe(503);
      expect(await gate.response.json()).toEqual(contextUnavailableBody());
      expect(gate.response.headers.get('retry-after')).toBe('5');
      expect(gate.response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('logs one line that names the class and never the message', async () => {
    const err = new PermissionsUnavailableError();
    vi.mocked(withApiContext).mockRejectedValueOnce(err);

    await apiContextGate(req());

    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('[api-context-gate]');
    expect(logged).toContain('PermissionsUnavailableError');
    expect(logged).not.toContain(err.message);
  });

  it('hands withApiContext the request it was given, once', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const r = req({ headers: { authorization: 'Bearer t' } });

    await apiContextGate(r);

    expect(withApiContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withApiContext).mock.calls[0]![0]).toBe(r);
  });

  it('a null context is { ctx: null }, so the route keeps its own 401; a context is { ctx }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect(await apiContextGate(req())).toEqual({ ctx: null });

    const ctx = { organizationId: 'org-1', userId: 'u-1' } as never;
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    const gate = await apiContextGate(req());
    expect(gate).toEqual({ ctx });
    expect('ctx' in gate && gate.ctx).toBe(ctx);
    expect(console.warn).not.toHaveBeenCalled();
  });

  // Mutation caught: marking every throw. Anything else withApiContext throws
  // is a bug (or Next control flow), and must stay loud and unmarked: the
  // phone would send an adjustment again on the marker.
  it.each([
    ['a generic Error', () => new Error('socket closed')],
    ['a ServiceError', () => new ServiceError('forbidden', 'Permission denied')],
    [
      'Next control flow (NEXT_REDIRECT)',
      () => {
        try {
          redirect('/signin');
        } catch (e) {
          return e as Error;
        }
        throw new Error('redirect() did not throw');
      },
    ],
    ['a thrown non-Error', () => ({ code: 'PERMISSIONS_UNAVAILABLE' }) as unknown as Error],
  ])('rethrows %s unchanged and answers nothing', async (_label, make) => {
    const thrown = make();
    vi.mocked(withApiContext).mockRejectedValueOnce(thrown);

    await expect(apiContextGate(req())).rejects.toBe(thrown);
    expect(console.warn).not.toHaveBeenCalled();
  });

  // The class, not the shape: an error that only LOOKS like the refusal (its
  // name or code copied) is not one of the two refusals withApiContext makes.
  it('matches the two classes, never a lookalike name or code', async () => {
    const lookalike = Object.assign(new Error('Your permissions could not be checked.'), {
      name: 'PermissionsUnavailableError',
      code: 'PERMISSIONS_UNAVAILABLE',
    });
    vi.mocked(withApiContext).mockRejectedValueOnce(lookalike);
    await expect(apiContextGate(req())).rejects.toBe(lookalike);
  });
});

/* ─────────────────────── the guards over the source tree ─────────────────────── */

const WEB_SRC = path.resolve(__dirname, '../..');
const CORE_SRC = path.resolve(WEB_SRC, '../../../packages/core/src');

/** The gate's module, apps/web/src-relative with no extension (resolveModule's form). */
const GATE_MODULE = 'server/lib/api-context-gate';
const GATE_FILE = `${GATE_MODULE}.ts`;
const CORE_MARKER_FILE = 'auth/context-unavailable.ts';

/** The routes reviewed to use the gate (docket S26). A new one is a reviewed addition. */
const GATED_ROUTES = [
  'app/api/v1/exceptions/[id]/escalate/route.ts',
  'app/api/v1/items/[id]/adjust/route.ts',
  'app/api/v1/rentals/route.ts',
];

const SOURCE_FILE = /\.(ts|tsx|mts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts)$/;

/** Every non-test source file under `root`, root-relative and posix. */
function sourceFiles(root: string, skipDirs: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '__mocks__' || skipDirs.includes(rel)) continue;
        walk(full);
      } else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name)) {
        out.set(rel, readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  return out;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Where code names one of `words`: an identifier spelled exactly so (a
 * binding, a property, an import), or any string or template text containing
 * it. Read on the syntax tree, so a comment never counts and a key in quotes
 * still does.
 */
function codeMentions(
  fileName: string,
  source: string,
  words: readonly string[],
): Array<{ word: string; line: number }> {
  const sf = parse(fileName, source);
  const found: Array<{ word: string; line: number }> = [];
  const visit = (n: ts.Node): void => {
    const identifier = ts.isIdentifier(n) || ts.isPrivateIdentifier(n);
    const text =
      identifier ||
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
        ? (n as { text: string }).text
        : null;
    if (text !== null) {
      for (const word of words) {
        if (identifier ? text === word : text.includes(word)) {
          found.push({ word, line: lineOf(sf, n) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * GUARD 2, ONE EMITTER. In the web's non-test code only the gate may build the
 * marker's body, and nothing may spell its flag: a second emitter would have to
 * prove it answers before any write, and be reviewed. In core, only the
 * marker's own module may spell the flag.
 */
function oneEmitterFindings(web: Map<string, string>, core: Map<string, string>): string[] {
  const found: string[] = [];
  const words = ['contextUnavailableBody', 'nothingWritten'];
  for (const [file, src] of web) {
    for (const { word, line } of codeMentions(file, src, words)) {
      if (word === 'contextUnavailableBody' && file === GATE_FILE) continue;
      found.push(`apps/web/src/${file}:${line} names ${word}`);
    }
  }
  for (const [file, src] of core) {
    if (file === CORE_MARKER_FILE) continue;
    for (const { line } of codeMentions(file, src, ['nothingWritten'])) {
      found.push(`packages/core/src/${file}:${line} names nothingWritten`);
    }
  }
  return found;
}

/** The module specifiers a file loads (imports, re-exports, dynamic imports), apps/web/src-relative. */
function loadedModules(fileName: string, source: string): string[] {
  const sf = parse(fileName, source);
  const out: string[] = [];
  const add = (spec: ts.Expression | undefined) => {
    if (!spec || !ts.isStringLiteralLike(spec)) return;
    const target = resolveModule(fileName, spec.text);
    if (target) out.push(target);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** The exported HTTP handlers of a route file, with the function each one is (null: not a readable function). */
function httpHandlers(
  sf: ts.SourceFile,
): Array<{ method: string; fn: ts.FunctionLikeDeclaration | null }> {
  const out: Array<{ method: string; fn: ts.FunctionLikeDeclaration | null }> = [];
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && exported(st) && HTTP_METHODS.has(st.name.text)) {
      out.push({ method: st.name.text, fn: st });
    }
    if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !HTTP_METHODS.has(d.name.text)) continue;
        const init = d.initializer;
        out.push({
          method: d.name.text,
          fn: init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null,
        });
      }
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (HTTP_METHODS.has(el.name.text)) out.push({ method: el.name.text, fn: null });
      }
    }
  }
  return out;
}

/** The local name the file imports apiContextGate under, from the gate's own module. */
function gateLocalName(sf: ts.SourceFile, fileName: string): string | null {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (resolveModule(fileName, st.moduleSpecifier.text) !== GATE_MODULE) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === 'apiContextGate') return el.name.text;
    }
  }
  return null;
}

/** `const gate = await <gate>(<the handler's first parameter>);` */
function isGateFirstStatement(fn: ts.FunctionLikeDeclaration, gate: string): boolean {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  const param = fn.parameters[0];
  if (!first || !param || !ts.isIdentifier(param.name)) return false;
  if (!ts.isVariableStatement(first)) return false;
  const list = first.declarationList;
  if ((list.flags & ts.NodeFlags.Const) === 0 || list.declarations.length !== 1) return false;
  const [decl] = list.declarations;
  if (!decl || !ts.isIdentifier(decl.name) || decl.name.text !== 'gate') return false;
  const init = decl.initializer;
  if (!init || !ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return false;
  const call = init.expression;
  return (
    ts.isIdentifier(call.expression) &&
    call.expression.text === gate &&
    call.arguments.length === 1 &&
    ts.isIdentifier(call.arguments[0]!) &&
    (call.arguments[0] as ts.Identifier).text === param.name.text
  );
}

/**
 * GUARD 3, FIRST STATEMENT. The marker promises that nothing was written, which
 * holds only while the gate runs before the route does anything. So every
 * handler of a file that imports the gate starts with
 * `const gate = await apiContextGate(<its own request>)`, and the files that
 * load the gate's module are exactly the reviewed routes: a helper that called
 * it after some work would break the promise out of this guard's sight.
 */
function firstStatementFindings(web: Map<string, string>): string[] {
  const found: string[] = [];
  const importers = [...web]
    .filter(([file, src]) => file !== GATE_FILE && loadedModules(file, src).includes(GATE_MODULE))
    .map(([file]) => file)
    .sort();
  if (JSON.stringify(importers) !== JSON.stringify(GATED_ROUTES)) {
    found.push(
      `the gate is loaded by [${importers.join(', ')}], reviewed: [${GATED_ROUTES.join(', ')}]`,
    );
  }
  for (const file of importers) {
    const sf = parse(file, web.get(file)!);
    const gate = gateLocalName(sf, file);
    if (!gate) {
      found.push(`${file}: loads the gate's module without importing apiContextGate by name`);
      continue;
    }
    const handlers = httpHandlers(sf);
    if (handlers.length === 0) found.push(`${file}: no HTTP handler`);
    const expected = `const gate = await ${gate}(<its request>)`;
    for (const h of handlers) {
      if (!h.fn) found.push(`${file} ${h.method}: not a function this guard can read`);
      else if (!isGateFirstStatement(h.fn, gate)) {
        found.push(`${file} ${h.method}: the first statement is not \`${expected}\``);
      }
    }
  }
  return found;
}

/**
 * The two tests that parse every source file take 1 to 2 s each alone on a
 * quiet machine. A whole-tree parse ran more than nine times slower inside a
 * full suite while other suites ran on the same machine, which would reach
 * this suite's 15 s default, so they have the limit its other whole-tree
 * scans have.
 */
const SCAN = { timeout: 60_000 };

describe('the marker has one emitter (guard 2)', () => {
  // src/test holds the test helpers; the core marker module is allowed below.
  const WEB = sourceFiles(WEB_SRC, ['test']);
  const CORE = sourceFiles(CORE_SRC);

  it('scans real trees', () => {
    expect(WEB.size).toBeGreaterThan(1000);
    expect(WEB.has(GATE_FILE)).toBe(true);
    expect(WEB.has('app/api/v1/items/[id]/adjust/route.ts')).toBe(true);
    expect(CORE.has(CORE_MARKER_FILE)).toBe(true);
    // The gate does build the body, and the core module does spell the flag:
    // a scan that read nothing would pass the rule below for the wrong reason.
    expect(
      codeMentions(GATE_FILE, WEB.get(GATE_FILE)!, ['contextUnavailableBody']).length,
    ).toBeGreaterThan(0);
    expect(
      codeMentions(CORE_MARKER_FILE, CORE.get(CORE_MARKER_FILE)!, ['nothingWritten']).length,
    ).toBeGreaterThan(0);
  });

  it(
    'only the gate builds the body; no web code spells nothingWritten; in core only the marker module does',
    SCAN,
    () => {
      expect(oneEmitterFindings(WEB, CORE)).toEqual([]);
    },
  );

  it('plants: a second caller of the body and a nothingWritten literal in a route both fail it', () => {
    // The real gate and core module beside the plants: what they spell is allowed.
    const web = new Map([[GATE_FILE, WEB.get(GATE_FILE)!]]);
    web.set(
      'app/api/v1/example/route.ts',
      `import { contextUnavailableBody } from '@stockpilot/core';
       export async function POST() { return Response.json(contextUnavailableBody(), { status: 503 }); }`,
    );
    web.set(
      'app/api/v1/example-two/route.ts',
      `export async function POST() {
         return Response.json({ error: 'check_failed', details: { reason: 'context_unavailable', retryable: true, nothingWritten: true } }, { status: 503 });
       }`,
    );
    web.set('server/lib/quoted.ts', `export const K = { 'nothingWritten': true };`);
    const core = new Map([[CORE_MARKER_FILE, CORE.get(CORE_MARKER_FILE)!]]);
    core.set('orders/other.ts', 'export const x = { details: { nothingWritten: true } };');
    expect(oneEmitterFindings(web, core)).toEqual([
      'apps/web/src/app/api/v1/example/route.ts:1 names contextUnavailableBody',
      'apps/web/src/app/api/v1/example/route.ts:2 names contextUnavailableBody',
      'apps/web/src/app/api/v1/example-two/route.ts:2 names nothingWritten',
      'apps/web/src/server/lib/quoted.ts:1 names nothingWritten',
      'packages/core/src/orders/other.ts:1 names nothingWritten',
    ]);
  });

  it('a comment naming the flag is not code', () => {
    expect(
      codeMentions('x.ts', '// nothingWritten: true\n/* contextUnavailableBody() */', [
        'nothingWritten',
        'contextUnavailableBody',
      ]),
    ).toEqual([]);
  });
});

describe('a route that uses the gate calls it first, and only the reviewed routes use it (guard 3)', () => {
  const WEB = sourceFiles(WEB_SRC, ['test']);

  it('the three routes, each handler starting with the gate on its own request', SCAN, () => {
    expect(firstStatementFindings(WEB)).toEqual([]);
    for (const route of GATED_ROUTES) expect(WEB.has(route), route).toBe(true);
  });

  it('plant: a route whose first statement is not the gate fails it, and so does an unreviewed importer', () => {
    // The three real routes beside the plants (the adjust route is replaced).
    const web = new Map(GATED_ROUTES.map((route) => [route, WEB.get(route)!] as [string, string]));
    web.set(
      'app/api/v1/items/[id]/adjust/route.ts',
      `import { NextResponse } from 'next/server';
       import { apiContextGate } from '@/server/lib/api-context-gate';
       import { checkRateLimit } from '@/lib/rate-limit';
       export async function POST(req: Request) {
         await checkRateLimit('x', 1, 1);
         const gate = await apiContextGate(req);
         if ('response' in gate) return gate.response;
         return NextResponse.json({});
       }`,
    );
    web.set(
      'app/api/v1/other/route.ts',
      `import { apiContextGate as g } from '../../../../server/lib/api-context-gate';
       export const POST = async (req: Request) => { const gate = await g(req); return gate; };
       export async function DELETE(req: Request) { const gate = await g(new Request(req.url)); return gate; }`,
    );
    web.set(
      'server/lib/wraps-the-gate.ts',
      `export async function later(req: Request) { const { apiContextGate } = await import('@/server/lib/api-context-gate'); return apiContextGate(req); }`,
    );
    expect(firstStatementFindings(web)).toEqual([
      'the gate is loaded by [app/api/v1/exceptions/[id]/escalate/route.ts, app/api/v1/items/[id]/adjust/route.ts, app/api/v1/other/route.ts, app/api/v1/rentals/route.ts, server/lib/wraps-the-gate.ts], reviewed: [app/api/v1/exceptions/[id]/escalate/route.ts, app/api/v1/items/[id]/adjust/route.ts, app/api/v1/rentals/route.ts]',
      'app/api/v1/items/[id]/adjust/route.ts POST: the first statement is not `const gate = await apiContextGate(<its request>)`',
      'app/api/v1/other/route.ts DELETE: the first statement is not `const gate = await g(<its request>)`',
      "server/lib/wraps-the-gate.ts: loads the gate's module without importing apiContextGate by name",
    ]);
  });
});
