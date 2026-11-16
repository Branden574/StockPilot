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

/** The addresses the read rule covers: everything served under /api. */
export const READ_SCOPE = 'api';

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

/**
 * Files served as endpoints outside READ_SCOPE: every route file under app/
 * whose address is not under /api (any extension), and every file under
 * pages/api. The read rule does not read their handlers, so the guard holds
 * them to building no member context at all.
 */
export function routeFilesOutsideScope(sources: Sources): string[] {
  return [...sources.keys()]
    .filter(
      (f) =>
        (ANY_ROUTE_FILE.test(path.posix.basename(f)) && servedPath(f) !== null && !servesApi(f)) ||
        f.startsWith('pages/api/'),
    )
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
 * Is the gate call a statement of its own that always runs: `const x = await
 * gate(...)`, `x = await gate(...)`, `return gate(...)` (awaited or not), or
 * the arrow function's expression body; and is that statement reached on
 * every path, through blocks and a `try` block only (never an `if`, a loop, a
 * `switch`, a `catch` or a `finally`)?
 */
function isUnconditionalGateStep(call: ts.CallExpression, fn: ts.FunctionLikeDeclaration): boolean {
  let n: ts.Node = call;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  if (ts.isArrowFunction(fn) && fn.body === n) return true;
  if (ts.isAwaitExpression(n.parent)) {
    n = n.parent;
    while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  }
  const p = n.parent;
  let statement: ts.Node;
  if (ts.isReturnStatement(p)) statement = p;
  else if (ts.isVariableDeclaration(p) && p.initializer === n) {
    const list = p.parent;
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(list.parent)) return false;
    statement = list.parent;
  } else if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === n &&
    ts.isExpressionStatement(p.parent)
  ) {
    statement = p.parent;
  } else return false;
  // Up to the function's body: blocks, and the block of a `try`.
  let child: ts.Node = statement;
  for (let up = statement.parent; up && up !== fn; child = up, up = up.parent) {
    if (ts.isBlock(up)) continue;
    if (ts.isTryStatement(up) && up.tryBlock === child) continue;
    return false;
  }
  return true;
}

export interface FirstStep {
  /** The read gate the handler reaches as its first step, or null. */
  gate: string | null;
  /** The handler hands the gate the string 'read' (a read by another method). */
  asksRead: boolean;
  /** What it calls first instead, as written, when no read gate comes first. */
  instead: string | null;
  /**
   * Every call made before the gate, in the order it runs (a call's callee and
   * arguments before the call itself), awaited or not, as written with its
   * whitespace collapsed; the file's own functions are read through. Every
   * `new X(...)` is here too (`new URL(...)`, `new NextResponse(...)`), and so
   * is every answer built in place (`NextResponse.json(...)`). The guard holds each handler to its reviewed list (PRE_GATE).
   */
  before: string[];
}

const normalized = (n: ts.Node, sf: ts.SourceFile) => n.getText(sf).replace(/\s+/g, ' ');

/**
 * Walks a handler in the order it runs, up to its read gate. The gate counts
 * only as a statement that always runs (isUnconditionalGateStep); a call to
 * one of the file's own functions is read through, its calls in place. The
 * functions it declares (callbacks) are not entered: a call that hands one on
 * is itself in `before`.
 */
function firstStepOf(
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
  gates: Map<string, string>,
  locals: Map<string, ts.FunctionLikeDeclaration>,
  seen = new Set<ts.Node>(),
  before: string[] = [],
): FirstStep {
  let found: { gate: string; asksRead: boolean } | null = null;
  const visit = (n: ts.Node, within: ts.FunctionLikeDeclaration): void => {
    if (found) return;
    if (n !== within && FUNCTION_KINDS(n)) return;
    if (ts.isCallExpression(n)) {
      visit(n.expression, within);
      for (const a of n.arguments) visit(a, within);
      if (found) return;
      const name = ts.isIdentifier(n.expression) ? n.expression.text : null;
      const gate = name ? gates.get(name) : undefined;
      if (gate && isUnconditionalGateStep(n, within)) {
        const asksRead = n.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === 'read');
        found = { gate, asksRead };
        return;
      }
      const local = name ? locals.get(name) : undefined;
      if (local && !seen.has(local)) {
        seen.add(local);
        if (local.body) visit(local.body, local);
        // A gate inside the file's own function holds the handler only when
        // the call to that function is itself a step that always runs.
        if (found && !isUnconditionalGateStep(n, within)) {
          found = null;
          before.push(normalized(n, sf));
        }
        return;
      }
      before.push(normalized(n, sf));
      return;
    }
    if (ts.isNewExpression(n)) {
      visit(n.expression, within);
      for (const a of n.arguments ?? []) visit(a, within);
      if (!found) before.push(normalized(n, sf));
      return;
    }
    ts.forEachChild(n, (c) => visit(c, within));
  };
  if (fn.body) visit(fn.body, fn);
  if (found) {
    const f = found as { gate: string; asksRead: boolean };
    return { gate: f.gate, asksRead: f.asksRead, instead: null, before };
  }
  return { gate: null, asksRead: false, instead: before[0] ?? '(no call)', before };
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
  /** The route file whose code the handler is (the re-export's target, or the file itself). */
  at: string;
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
        at: next?.at ?? file,
      });
      continue;
    }
    const fn = ownHandler(sf, h.method);
    out.push({
      file,
      method: h.method,
      reaches: h.gates.length > 0,
      first: fn ? firstStepOf(fn, sf, gates, locals) : null,
      at: file,
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
