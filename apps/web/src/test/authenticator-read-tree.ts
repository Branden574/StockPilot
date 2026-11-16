import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { readRouteHandlers, resolveModule, type RouteMethod } from './route-write-handlers';

/**
 * The source-tree reading behind src/test/authenticator-read.guard.test.ts,
 * shared with the route sweep (app/api/v1/set-up-owed-reads.routes.test.ts),
 * which calls every handler this reading counts as held, so the two cannot
 * drift apart.
 *
 * Read on the syntax tree (a comment or a string never counts). Paths are
 * apps/web/src relative and posix.
 */

export const WEB_SRC = path.resolve(__dirname, '..');

export const READ_CONTEXT = 'server/lib/api-read-context.ts';
export const REFUSAL = 'refuseSetUpOwedRead';

/**
 * The functions that give the answer to a read, by the name each module
 * exports: the wrapper, and the returns routes' two shared gates. A shared
 * gate takes a `kind` ('read' or 'write') and must hand that same parameter
 * to the refusal (rule 2); the wrapper is the refusal's own module.
 */
export const READ_GATES: Readonly<Record<string, { module: string; shared: boolean }>> = {
  apiReadContext: { module: 'server/lib/api-read-context', shared: false },
  returnsContext: { module: 'app/api/v1/returns/http', shared: true },
  memberRequesterGate: { module: 'app/api/v1/orders/[id]/return-request/http', shared: true },
};

/** READ_GATES as readRouteHandlers takes them: name -> module. */
export const READ_GATE_MODULES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(READ_GATES).map(([name, g]) => [name, g.module]),
);

/** The shared gates, each as its gate name and its file. Derived from READ_GATES. */
export const SHARED_GATES: ReadonlyArray<{ name: string; file: string }> = Object.entries(
  READ_GATES,
)
  .filter(([, g]) => g.shared)
  .map(([name, g]) => ({ name, file: `${g.module}.ts` }));

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Any file Next.js serves as a route handler. */
const ANY_ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** The route files this reading can parse. Any other route file is reported (fail closed). */
const READABLE_ROUTE_FILE = /^route\.(ts|tsx)$/;

export type Sources = ReadonlyMap<string, string>;

/** Every shipped source file under apps/web/src (no tests, no src/test helpers, no mocks). */
export function shippedSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(WEB_SRC, full).split(path.sep).join('/');
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '__mocks__' || rel === 'test') continue;
        walk(full);
      } else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) {
        out.set(rel, readFileSync(full, 'utf8'));
      }
    }
  };
  walk(WEB_SRC);
  return out;
}

export function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The address a file under app/ serves, without its leading slash: route
 * groups `(x)` and parallel slots `@x` are not part of it. Null for a file
 * outside app/.
 */
export function servedPath(file: string): string | null {
  if (!file.startsWith('app/')) return null;
  const dirs = path.posix.dirname(file).split('/').slice(1);
  return dirs.filter((d) => !/^\(.*\)$/.test(d) && !d.startsWith('@')).join('/');
}

/** The addresses the read rule covers: everything served under /api/v1. */
export const READ_SCOPE = 'api/v1';

/** A route file that serves an address in READ_SCOPE, whatever folders it sits in. */
function servesApi(file: string): boolean {
  const served = servedPath(file);
  return served !== null && (served === READ_SCOPE || served.startsWith(`${READ_SCOPE}/`));
}

/** Route files in READ_SCOPE this reading parses (route.ts, route.tsx), sorted. */
export function apiRouteFiles(sources: Sources): string[] {
  return [...sources.keys()]
    .filter((f) => READABLE_ROUTE_FILE.test(path.posix.basename(f)) && servesApi(f))
    .sort();
}

/** Is this route file served under /api/v1? */
export function servesV1(file: string): boolean {
  const served = servedPath(file);
  return served !== null && (served === 'api/v1' || served.startsWith('api/v1/'));
}

/**
 * Route files in READ_SCOPE that this reading cannot parse (route.js, .jsx, .mjs,
 * .cjs): each is a finding, so a handler in one is never read as held or open
 * by default.
 */
export function unreadableRouteFiles(sources: Sources): string[] {
  return [...sources.keys()]
    .filter((f) => {
      const base = path.posix.basename(f);
      return ANY_ROUTE_FILE.test(base) && !READABLE_ROUTE_FILE.test(base) && servesApi(f);
    })
    .sort();
}

/* ────────────────────────── a handler's first call ────────────────────────── */

const FUNCTION_KINDS = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** The file's own top-level functions, by name: declarations and consts holding a function. */
function localFunctions(sf: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration> {
  const out = new Map<string, ts.FunctionLikeDeclaration>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && FUNCTION_KINDS(d.initializer)) {
          out.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return out;
}

/** The function a route file exports as `method` in its own body (not a re-export), or null. */
function ownHandler(sf: ts.SourceFile, method: string): ts.FunctionLikeDeclaration | null {
  const locals = localFunctions(sf);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === method && isExported(st)) return st;
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === method && d.initializer) {
          if (FUNCTION_KINDS(d.initializer)) return d.initializer;
          if (ts.isIdentifier(d.initializer)) return locals.get(d.initializer.text) ?? null;
          return null;
        }
      }
    }
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause) {
      if (!ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) {
        if (el.name.text === method) return locals.get((el.propertyName ?? el.name).text) ?? null;
      }
    }
  }
  return null;
}

/** local name -> read gate, for the read gates the file imports from their own modules. */
function readGateImports(sf: ts.SourceFile, file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || st.importClause?.isTypeOnly) continue;
    const source = resolveModule(file, st.moduleSpecifier.text);
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (READ_GATES[imported]?.module === source) out.set(el.name.text, imported);
    }
  }
  return out;
}

/**
 * Is this call a step the function waits on: awaited, returned, or the
 * expression body of the arrow function itself (through parentheses)?
 */
function isStep(call: ts.CallExpression, fn: ts.FunctionLikeDeclaration): boolean {
  // Building an answer (`return NextResponse.json({ ... }, { status: 400 })`
  // for a malformed id) is no work; a call inside its arguments still is.
  const callee = call.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'json' &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === 'NextResponse' || callee.expression.text === 'Response')
  ) {
    return false;
  }
  let n: ts.Node = call;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  return (
    ts.isAwaitExpression(p) || ts.isReturnStatement(p) || (ts.isArrowFunction(fn) && fn.body === n)
  );
}

/**
 * The first step in a function's body, in source order, outside the functions
 * it declares: the first call it awaits or returns. Awaiting a value that is
 * no call (the route's `params`) is not a step.
 */
function firstCall(fn: ts.FunctionLikeDeclaration): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n !== fn && FUNCTION_KINDS(n)) return;
    if (ts.isCallExpression(n) && isStep(n, fn)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

export interface FirstStep {
  /** The read gate the handler calls first, or null. */
  gate: string | null;
  /** The handler hands the gate the string 'read' (a read by another method). */
  asksRead: boolean;
  /** What it calls first instead, as written, when that is not a read gate. */
  instead: string | null;
}

/**
 * The first call a handler makes, following the file's own functions it
 * calls first (`export const GET = (req) => load(req)`). Awaiting the route's
 * params is no call. Anything else first (a limiter, a read, a parse) is
 * `instead`.
 */
function firstStepOf(
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
  gates: Map<string, string>,
  locals: Map<string, ts.FunctionLikeDeclaration>,
  seen = new Set<ts.Node>(),
): FirstStep {
  const call = firstCall(fn);
  if (!call) return { gate: null, asksRead: false, instead: '(no call)' };
  if (ts.isIdentifier(call.expression)) {
    const gate = gates.get(call.expression.text);
    if (gate) {
      const asksRead = call.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === 'read');
      return { gate, asksRead, instead: null };
    }
    const local = locals.get(call.expression.text);
    if (local && !seen.has(local)) {
      seen.add(local);
      return firstStepOf(local, sf, gates, locals, seen);
    }
  }
  return {
    gate: null,
    asksRead: false,
    instead: call.getText(sf).replace(/\s+/g, ' ').slice(0, 80),
  };
}

/** One handler a route file exports, read for the read rule. */
export interface ReadHandler {
  file: string;
  method: RouteMethod;
  /** The handler reaches a read gate anywhere (readRouteHandlers), here or through its re-export. */
  reaches: boolean;
  /** Its first step, here or in the handler it re-exports (null when that cannot be found). */
  first: FirstStep | null;
  /** For a re-export: the route file it comes from, or null when none is found. */
  from?: string | null;
}

const ROUTE_EXTS = ['.ts', '.tsx'];

/** Every handler a route file exports, for `methods`, each with how it reaches a read gate. */
export function readHandlersOf(
  file: string,
  sources: Sources,
  methods: readonly RouteMethod[],
  seen = new Set<string>(),
): ReadHandler[] {
  const src = sources.get(file);
  if (src === undefined) return [];
  const sf = parse(file, src);
  const gates = readGateImports(sf, file);
  const locals = localFunctions(sf);
  const out: ReadHandler[] = [];
  for (const h of readRouteHandlers(file, src, READ_GATE_MODULES).handlers) {
    if (!methods.includes(h.method)) continue;
    if (h.reexport) {
      const key = `${h.reexport.module}#${h.reexport.name}`;
      const target = ROUTE_EXTS.map((ext) => `${h.reexport!.module}${ext}`).find((f) =>
        sources.has(f),
      );
      const next =
        target && !seen.has(key)
          ? readHandlersOf(
              target,
              sources,
              [h.reexport.name as RouteMethod],
              new Set([...seen, key]),
            )[0]
          : undefined;
      out.push({
        file,
        method: h.method,
        reaches: next?.reaches ?? false,
        first: next?.first ?? null,
        from: next ? target! : null,
      });
      continue;
    }
    const fn = ownHandler(sf, h.method);
    out.push({
      file,
      method: h.method,
      reaches: h.gates.length > 0,
      first: fn ? firstStepOf(fn, sf, gates, locals) : null,
    });
  }
  return out;
}

/** The export shapes readRouteHandlers cannot follow in a route file. */
export function unreadableExports(file: string, sources: Sources): string[] {
  const src = sources.get(file);
  return src === undefined ? [] : readRouteHandlers(file, src, READ_GATE_MODULES).unreadable;
}

/** A handler held by a read gate called as its first step (for a GET or HEAD, any read gate). */
export function isHeldRead(h: ReadHandler): boolean {
  return h.first?.gate != null;
}

/** A non-GET handler held as a read: its first step is a read gate handed 'read'. */
export function isHeldByAskingRead(h: ReadHandler): boolean {
  return h.first?.gate != null && h.first.asksRead;
}

export const READ_METHODS: readonly RouteMethod[] = ['GET', 'HEAD'];
export const OTHER_METHODS: readonly RouteMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The route handlers the read rule holds, as `<route folder under app/api>
 * <METHOD>` (`v1/returns GET`, `items/search GET`; a folder outside app/api
 * keeps its whole path, so the sweep's import of it fails): every GET and HEAD whose
 * first step is a read gate, and every other method whose first step is a
 * read gate handed 'read'. The route sweep calls each one.
 */
export function heldHandlers(sources: Sources): string[] {
  const out: string[] = [];
  for (const file of apiRouteFiles(sources)) {
    // The folder, so the sweep can import the file (a route group stays in it).
    const route = path.posix.dirname(file).replace(/^app\/api\//, '');
    for (const h of readHandlersOf(file, sources, READ_METHODS)) {
      if (isHeldRead(h)) out.push(`${route} ${h.method}`);
    }
    for (const h of readHandlersOf(file, sources, OTHER_METHODS)) {
      if (isHeldByAskingRead(h)) out.push(`${route} ${h.method}`);
    }
  }
  return out.sort();
}
