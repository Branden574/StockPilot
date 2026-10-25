/**
 * The static reading behind cookie-write-routes.guard.test.ts (docket S14):
 * which methods a route file exports that can write (POST, PUT, PATCH,
 * DELETE), whether each one reaches withApiContext (whose cookie path refuses
 * a write a browser sent from another origin), and what every withApiContext
 * call is given.
 *
 * The AST is read, so a comment or a string never counts as a call. A gate is
 * recognised by what it was IMPORTED as, from where, so an alias is followed
 * and a function of the same name from another module is not a gate. A handler
 * reaches a gate through any function or const declared at the top of the same
 * file (memberContextFor in the sign route, a shared `handler`). A gate in
 * another module is a gate only if it is listed in GATE_MODULES; the guard test
 * checks that each of those modules hands withApiContext its own request.
 *
 * NOT FOLLOWED, AND REPORTED INSTEAD: `export *` and a destructured export
 * (`export const { POST } = ...`). Neither shape exists today; each makes the
 * guard fail as unreadable rather than pass without looking.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];

const WEB_SRC = path.resolve(__dirname, '..');

/**
 * Each gate, by the name its module exports, and the module (relative to
 * apps/web/src, no extension) it must come from. withApiContext is the rule
 * itself; the other two are the returns routes' shared plumbing, which call it
 * with their own request (the guard test reads them).
 */
export const GATE_MODULES: Readonly<Record<string, string>> = {
  withApiContext: 'lib/auth/api-context',
  returnsContext: 'app/api/v1/returns/http',
  memberRequesterGate: 'app/api/v1/orders/[id]/return-request/http',
};

export interface WriteHandler {
  method: WriteMethod;
  /** The gates this handler calls, directly or through the file's own functions. */
  gates: string[];
  /** For `export { POST } from '...'`: the module (apps/web/src relative) and the name it re-exports. */
  reexport?: { module: string; name: string };
}

export interface FileReading {
  handlers: WriteHandler[];
  /** Export shapes this reading cannot follow (the guard fails on any). */
  unreadable: string[];
}

export interface ContextCall {
  /** The gate called (withApiContext, or one of the returns routes' shared gates). */
  gate: string;
  line: number;
  argument: string;
  /** The argument is a parameter of the function the call is in: the request it was given. */
  passesOwnParameter: boolean;
  /**
   * The argument is `new Request(p.url, { method: p.method, headers: H })` for
   * a parameter p of the function the call is in, where H is `p.headers`,
   * `new Headers(p.headers)`, or a const the function declares as
   * `new Headers(p.headers)` and changes only by setting a header in
   * REBUILD_MAY_SET: the same request, with every header it came with (Origin,
   * Sec-Fetch-Site, the cookie), asking for an organization.
   */
  rebuildsOwnParameter: boolean;
  /** The answer is kept (a declaration, an assignment or a return), not dropped. */
  resultKept: boolean;
}

/** The headers a rebuilt request may set: the organization it asks a context in. */
export const REBUILD_MAY_SET: ReadonlySet<string> = new Set(['x-organization-id']);

/** Is a call's value kept: declared, assigned or returned, through await and parentheses? */
function resultKept(call: ts.CallExpression): boolean {
  let n: ts.Node = call;
  while (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (ts.isVariableDeclaration(p) && p.initializer === n) return true;
  if (ts.isReturnStatement(p)) return true;
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === n
  ) {
    return true;
  }
  return false;
}

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function isWriteMethod(name: string): name is WriteMethod {
  return (WRITE_METHODS as readonly string[]).includes(name);
}

/**
 * A module specifier as a path relative to apps/web/src with no extension, or
 * null for a package. `fileName` is the importing file's path relative to
 * apps/web/src.
 */
export function resolveModule(fileName: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith('@/')) target = specifier.slice(2);
  else if (specifier.startsWith('.'))
    target = path.posix.join(path.posix.dirname(fileName), specifier);
  else return null;
  return path.posix.normalize(target).replace(/\.(ts|tsx|js|mjs)$/, '');
}

/** True when the module exists on disk as one of the extensions a route may use. */
export function moduleExists(target: string): boolean {
  return ['.ts', '.tsx', '.js', '.mjs'].some((ext) => existsSync(path.join(WEB_SRC, target + ext)));
}

/** local name -> the gate it imports, for imports of a gate from its own module. */
function gateImports(sf: ts.SourceFile, fileName: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const source = resolveModule(fileName, st.moduleSpecifier.text);
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (GATE_MODULES[imported] !== undefined && GATE_MODULES[imported] === source) {
        out.set(el.name.text, imported);
      }
    }
  }
  return out;
}

/** The file's own top-level functions and consts, by name, for following calls. */
function topLevelDeclarations(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
      }
    }
  }
  return out;
}

/** An identifier used as a value: not a property name, a key or a declared name. */
function isValueReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (
    (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) &&
    p.name === n
  ) {
    return false;
  }
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p)) &&
    p.name === n
  ) {
    return false;
  }
  return true;
}

function gatesReached(
  start: ts.Node,
  gates: Map<string, string>,
  locals: Map<string, ts.Node>,
): string[] {
  const found = new Set<string>();
  const seen = new Set<ts.Node>();
  const walk = (node: ts.Node) => {
    if (seen.has(node)) return;
    seen.add(node);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const gate = gates.get(n.expression.text);
        if (gate) found.add(gate);
      }
      // A reference to one of the file's own functions, called or passed on. A
      // name in another role (a property, a key, a declaration) is not one.
      if (ts.isIdentifier(n) && locals.has(n.text) && isValueReference(n)) {
        walk(locals.get(n.text)!);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  walk(start);
  return [...found].sort();
}

/** The write handlers a route file exports, and what each one reaches. */
export function readRouteFile(fileName: string, source: string): FileReading {
  const sf = parse(fileName, source);
  const gates = gateImports(sf, fileName);
  const locals = topLevelDeclarations(sf);
  const handlers: WriteHandler[] = [];
  const unreadable: string[] = [];

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && isExported(st) && isWriteMethod(st.name.text)) {
      handlers.push({ method: st.name.text, gates: gatesReached(st, gates, locals) });
    }
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          unreadable.push(`destructured export: ${d.name.getText(sf)}`);
          continue;
        }
        if (isWriteMethod(d.name.text) && d.initializer) {
          handlers.push({ method: d.name.text, gates: gatesReached(d.initializer, gates, locals) });
        }
      }
    }
    if (ts.isExportDeclaration(st)) {
      const specifier =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : null;
      if (!st.exportClause) {
        unreadable.push(`export * from ${specifier ?? '(unknown)'}`);
        continue;
      }
      if (!ts.isNamedExports(st.exportClause)) {
        unreadable.push(`export * as ${st.exportClause.name.text}`);
        continue;
      }
      for (const el of st.exportClause.elements) {
        const exported = el.name.text;
        if (!isWriteMethod(exported)) continue;
        const local = (el.propertyName ?? el.name).text;
        if (specifier) {
          const target = resolveModule(fileName, specifier);
          if (!target) unreadable.push(`export { ${exported} } from a package: ${specifier}`);
          else
            handlers.push({
              method: exported,
              gates: [],
              reexport: { module: target, name: local },
            });
        } else {
          const decl = locals.get(local);
          if (!decl)
            unreadable.push(`export { ${local} as ${exported} } with no local declaration`);
          else handlers.push({ method: exported, gates: gatesReached(decl, gates, locals) });
        }
      }
    }
  }
  return { handlers, unreadable };
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return null;
}

function parameterNames(fn: ts.SignatureDeclaration | null): Set<string> {
  const out = new Set<string>();
  for (const p of fn?.parameters ?? []) if (ts.isIdentifier(p.name)) out.add(p.name.text);
  return out;
}

function propertyOf(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name)
      return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return null;
}

function isMemberOf(
  expr: ts.Expression | null | undefined,
  params: Set<string>,
  member: string,
): boolean {
  return (
    !!expr &&
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    params.has(expr.expression.text) &&
    expr.name.text === member
  );
}

/** `new Headers(p.headers)` for a parameter p. */
function isCopyOfOwnHeaders(expr: ts.Expression | null | undefined, params: Set<string>): boolean {
  return (
    !!expr &&
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'Headers' &&
    (expr.arguments?.length ?? 0) === 1 &&
    isMemberOf(expr.arguments![0], params, 'headers')
  );
}

/** Every declaration of `name` in the function's body, at any depth. */
function declarationsIn(fn: ts.SignatureDeclaration, name: string): ts.VariableDeclaration[] {
  const out: ts.VariableDeclaration[] = [];
  const body = (fn as ts.FunctionLikeDeclaration).body;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) out.push(n);
    ts.forEachChild(n, visit);
  };
  if (body) visit(body);
  return out;
}

/**
 * The function changes the headers object `name` only by setting or appending
 * a header in REBUILD_MAY_SET: no delete, no other header set, no
 * reassignment, and it is never handed to anything else that could change it.
 */
function changesOnlyAllowedHeaders(fn: ts.SignatureDeclaration, name: string): boolean {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  // `{ headers }` or `{ headers: h }` inside the init of a `new Request(...)`.
  const inRequestInit = (prop: ts.Node): boolean => {
    const obj = prop.parent;
    return (
      ts.isObjectLiteralExpression(obj) &&
      ts.isNewExpression(obj.parent) &&
      ts.isIdentifier(obj.parent.expression) &&
      obj.parent.expression.text === 'Request' &&
      obj.parent.arguments?.[1] === obj
    );
  };
  let ok = true;
  const visit = (n: ts.Node): void => {
    // A use of the binding: not a key, a property name or its declaration.
    if (ts.isIdentifier(n) && n.text === name && isValueReference(n)) {
      const p = n.parent;
      const isDeclaredName = ts.isVariableDeclaration(p) && p.name === n;
      const isShorthandUse =
        ts.isShorthandPropertyAssignment(p) && n.text === 'headers' && inRequestInit(p);
      const isHeadersValue =
        ts.isPropertyAssignment(p) &&
        p.initializer === n &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'headers' &&
        inRequestInit(p);
      const isMethodCall =
        ts.isPropertyAccessExpression(p) &&
        p.expression === n &&
        ts.isCallExpression(p.parent) &&
        p.parent.expression === p;
      if (isMethodCall) {
        const call = p.parent as ts.CallExpression;
        const method = (p as ts.PropertyAccessExpression).name.text;
        if (method === 'set' || method === 'append') {
          const [key] = call.arguments;
          if (!key || !ts.isStringLiteralLike(key) || !REBUILD_MAY_SET.has(key.text.toLowerCase()))
            ok = false;
        } else if (!['get', 'has', 'forEach', 'entries', 'keys', 'values'].includes(method)) {
          ok = false;
        }
      } else if (!isDeclaredName && !isShorthandUse && !isHeadersValue) {
        // Reassigned, passed to a function, spread, or anything else.
        ok = false;
      }
    }
    ts.forEachChild(n, visit);
  };
  if (body) visit(body);
  return ok;
}

/** The headers of a rebuilt request are the incoming request's own (see ContextCall.rebuildsOwnParameter). */
function carriesOwnHeaders(
  expr: ts.Expression | null,
  params: Set<string>,
  fn: ts.SignatureDeclaration | null,
): boolean {
  if (!expr) return false;
  if (isMemberOf(expr, params, 'headers') || isCopyOfOwnHeaders(expr, params)) return true;
  if (!ts.isIdentifier(expr) || !fn) return false;
  const decls = declarationsIn(fn, expr.text);
  if (decls.length !== 1) return false;
  const [decl] = decls;
  const isConst =
    ts.isVariableDeclarationList(decl!.parent) && (decl!.parent.flags & ts.NodeFlags.Const) !== 0;
  return (
    isConst &&
    isCopyOfOwnHeaders(decl!.initializer, params) &&
    changesOnlyAllowedHeaders(fn, expr.text)
  );
}

/** A file's named imports: the specifier as written, and the names it imports. */
export function importsOf(
  fileName: string,
  source: string,
): Array<{ specifier: string; names: string[] }> {
  const sf = parse(fileName, source);
  const out: Array<{ specifier: string; names: string[] }> = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const names: string[] = [];
    const clause = st.importClause;
    if (clause?.name) names.push('default');
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      names.push('*');
    }
    out.push({ specifier: st.moduleSpecifier.text, names });
  }
  return out;
}

/** Every call of a gate (GATE_MODULES, imported from its own module) in a file, and what it is given. */
export function gateCalls(fileName: string, source: string): ContextCall[] {
  const sf = parse(fileName, source);
  const gates = gateImports(sf, fileName);
  const out: ContextCall[] = [];
  const visit = (n: ts.Node): void => {
    const gate =
      ts.isCallExpression(n) && ts.isIdentifier(n.expression)
        ? gates.get(n.expression.text)
        : undefined;
    if (gate && ts.isCallExpression(n)) {
      const fn = enclosingFunction(n);
      const params = parameterNames(fn);
      const arg = n.arguments[0];
      const passesOwnParameter = !!arg && ts.isIdentifier(arg) && params.has(arg.text);
      let rebuildsOwnParameter = false;
      if (
        arg &&
        ts.isNewExpression(arg) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === 'Request'
      ) {
        const [url, init] = arg.arguments ?? [];
        rebuildsOwnParameter =
          isMemberOf(url, params, 'url') &&
          !!init &&
          ts.isObjectLiteralExpression(init) &&
          isMemberOf(propertyOf(init, 'method'), params, 'method') &&
          carriesOwnHeaders(propertyOf(init, 'headers'), params, fn);
      }
      out.push({
        gate,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        argument: arg ? arg.getText(sf) : '(none)',
        passesOwnParameter,
        rebuildsOwnParameter,
        resultKept: resultKept(n),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every withApiContext call in a file, and what it is given. */
export function withApiContextCalls(fileName: string, source: string): ContextCall[] {
  return gateCalls(fileName, source).filter((c) => c.gate === 'withApiContext');
}
