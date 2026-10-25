import * as path from 'node:path';

import ts from 'typescript';

/**
 * Finds the catches that swallow Next.js control flow around a Server Action's
 * work. Used by `src/server/actions/action-catch.guard.test.ts`.
 *
 * WHAT CAN REDIRECT. A function "can redirect" when its body reaches one of
 * next/navigation's throwing calls (redirect, permanentRedirect, notFound,
 * forbidden, unauthorized), directly or through other functions it calls or
 * passes as a callback, followed across modules by import: withContext ->
 * requireOrgContext -> redirect('/signin'), a service's static
 * forCurrentUser() -> withContext(), getServerSession() -> the account-status
 * gate's redirect('/account-disabled'), and anything built on them. Followed:
 * top-level functions and `const f = cache(async () => ...)`-style wrappers,
 * class static methods (`InventoryService.forCurrentUser`), named, default,
 * namespace and destructured dynamic imports, and re-exports. Not followed:
 * instance methods (a service built from a context already resolved), and
 * values passed around in variables.
 *
 * WHAT IS CHECKED.
 *   - SERVER ACTIONS: in a `'use server'` module, or a function whose body
 *     starts with `'use server'`, every `try/catch` whose try block can
 *     redirect, every `.catch(handler)` and `.then(_, handler)` on a promise
 *     that can, and every `Promise.allSettled` over one. The catch must bind
 *     the error and its FIRST statement must rethrow it: `rethrowControlFlow(e)`
 *     (lib/control-flow.ts), or a call that passes `e` to a function whose own
 *     first statement is `rethrowControlFlow(<that parameter>)` (the action
 *     modules' toResult / fail mappers). `Promise.allSettled` is always
 *     reported: it turns a redirect into a "rejected" result with no catch to
 *     rethrow it from; resolve the context before it.
 *   - CALLERS: in any other module, every `try/catch` (and `.catch` /
 *     `.then(_, handler)`) around a call to a Server Action imported from a
 *     `'use server'` module. Its first statement must be the rethrow above, or
 *     in a `'use client'` module `if (isControlFlow(e)) return ...;` (the
 *     router is already navigating; nothing must be shown). A module without
 *     the `'use client'` line may be rendered on the server, where returning
 *     would swallow the redirect, so it must rethrow: `if (isControlFlow(e))
 *     throw e;` or rethrowControlFlow(e).
 *
 * Parsed with the TypeScript compiler, not a regex: comments and strings never
 * count, and a call split over several lines is still one call.
 */

export interface ScanFile {
  /** Absolute path. */
  path: string;
  text: string;
}

export interface CatchFinding {
  file: string;
  line: number;
  /** The enclosing named function, or '(top level)'. */
  fn: string;
  kind: 'catch' | 'promise-catch' | 'promise-then' | 'all-settled';
  /** Which call the guarded code reaches: what can redirect, or the action called. */
  reaches: string;
  problem: string;
}

export interface CatchScan {
  serverFindings: CatchFinding[];
  callerFindings: CatchFinding[];
  actionModules: string[];
  /** Server Action catches around code that can redirect, rethrowing first. */
  guardedServerCatches: number;
  /** Caller catches around a Server Action call, handling control flow first. */
  guardedCallerCatches: number;
  /** Keys (`<file>#<name>`) of every function found to be able to redirect. */
  redirecting: ReadonlySet<string>;
}

const NAV_THROWERS = new Set([
  'redirect',
  'permanentRedirect',
  'notFound',
  'forbidden',
  'unauthorized',
]);
const NAV_MODULE = 'pkg:next/navigation';

type FunctionNode =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface FnDecl {
  key: string;
  /** The function (or the functions a wrapper call takes, for `cache(fn)`). */
  bodies: FunctionNode[];
}

type Binding =
  { kind: 'named'; module: string; name: string } | { kind: 'namespace'; module: string };

interface ModuleInfo {
  file: string;
  sf: ts.SourceFile;
  isActionModule: boolean;
  isClientModule: boolean;
  /** Local top-level functions by local name, and class statics as `Class.method`. */
  locals: Map<string, FnDecl>;
  classes: Set<string>;
  /** Exported name -> local name. */
  exportsLocal: Map<string, string>;
  reexports: Array<{ module: string; names: Map<string, string> | null }>;
  imports: Map<string, Binding>;
}

type Target =
  | { kind: 'seed'; name: string }
  | { kind: 'fn'; key: string; name: string }
  | { kind: 'class'; module: string; name: string }
  | { kind: 'namespace'; module: string };

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isAwaitExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function isFunctionNode(n: ts.Node): n is FunctionNode {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

function prologue(statements: ts.NodeArray<ts.Statement>): string[] {
  const out: string[] = [];
  for (const st of statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    out.push(st.expression.text);
  }
  return out;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (m) => m.kind === kind,
  );
}

function squash(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export function scanActionCatches(files: ScanFile[], srcRoot: string): CatchScan {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const controlFlowModule = path.join(srcRoot, 'lib/control-flow.ts');

  function resolveSpec(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return `pkg:${spec}`;
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]) {
      if (byPath.has(candidate)) return candidate;
    }
    return null;
  }

  /* ───────────────────────────── index every module ───────────────────────────── */

  const modules = new Map<string, ModuleInfo>();
  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const directives = prologue(sf.statements);
    const info: ModuleInfo = {
      file: file.path,
      sf,
      isActionModule: directives.includes('use server'),
      isClientModule: directives.includes('use client'),
      locals: new Map(),
      classes: new Set(),
      exportsLocal: new Map(),
      reexports: [],
      imports: new Map(),
    };
    const addLocal = (name: string, bodies: FunctionNode[]) => {
      if (bodies.length) info.locals.set(name, { key: `${file.path}#${name}`, bodies });
    };
    for (const st of sf.statements) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const resolved = resolveSpec(file.path, st.moduleSpecifier.text);
        if (!resolved) continue;
        if (clause.name)
          info.imports.set(clause.name.text, { kind: 'named', module: resolved, name: 'default' });
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb))
          info.imports.set(nb.name.text, { kind: 'namespace', module: resolved });
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            info.imports.set(el.name.text, {
              kind: 'named',
              module: resolved,
              name: (el.propertyName ?? el.name).text,
            });
          }
        }
      } else if (ts.isFunctionDeclaration(st) && st.body) {
        const name = st.name?.text ?? (isDefault ? 'default' : null);
        if (!name) continue;
        addLocal(name, [st]);
        if (exported) info.exportsLocal.set(isDefault ? 'default' : name, name);
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const init = unwrap(decl.initializer);
          let bodies: FunctionNode[] = [];
          if (isFunctionNode(init)) bodies = [init];
          else if (ts.isCallExpression(init)) {
            bodies = init.arguments.filter(
              (a): a is ts.FunctionExpression | ts.ArrowFunction =>
                ts.isFunctionExpression(a) || ts.isArrowFunction(a),
            );
          }
          addLocal(decl.name.text, bodies);
          if (exported) info.exportsLocal.set(decl.name.text, decl.name.text);
        }
      } else if (ts.isClassDeclaration(st) && st.name) {
        const cls = st.name.text;
        info.classes.add(cls);
        if (exported) info.exportsLocal.set(isDefault ? 'default' : cls, cls);
        for (const member of st.members) {
          if (!hasModifier(member, ts.SyntaxKind.StaticKeyword) || !member.name) continue;
          if (!ts.isIdentifier(member.name)) continue;
          if (ts.isMethodDeclaration(member) && member.body)
            addLocal(`${cls}.${member.name.text}`, [member]);
          if (ts.isPropertyDeclaration(member) && member.initializer) {
            const init = unwrap(member.initializer);
            if (isFunctionNode(init)) addLocal(`${cls}.${member.name.text}`, [init]);
          }
        }
      } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
        const resolved =
          st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
            ? resolveSpec(file.path, st.moduleSpecifier.text)
            : null;
        if (st.moduleSpecifier && !resolved) continue;
        if (!st.exportClause) {
          if (resolved) info.reexports.push({ module: resolved, names: null });
          continue;
        }
        if (ts.isNamedExports(st.exportClause)) {
          const names = new Map<string, string>();
          for (const el of st.exportClause.elements) {
            names.set(el.name.text, (el.propertyName ?? el.name).text);
          }
          if (resolved) info.reexports.push({ module: resolved, names });
          else
            for (const [exportedName, local] of names) info.exportsLocal.set(exportedName, local);
        }
      } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
        info.exportsLocal.set('default', st.expression.text);
      }
    }
    // Destructured or whole-module dynamic imports anywhere in the file:
    // `const { withContext } = await import('@/server/services/context')`.
    const findDynamic = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = unwrap(n.initializer);
        if (
          ts.isCallExpression(init) &&
          init.expression.kind === ts.SyntaxKind.ImportKeyword &&
          init.arguments[0] &&
          ts.isStringLiteral(init.arguments[0])
        ) {
          const resolved = resolveSpec(file.path, init.arguments[0].text);
          if (resolved && ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              if (!ts.isIdentifier(el.name)) continue;
              const imported =
                el.propertyName && ts.isIdentifier(el.propertyName)
                  ? el.propertyName.text
                  : el.name.text;
              info.imports.set(el.name.text, { kind: 'named', module: resolved, name: imported });
            }
          } else if (resolved && ts.isIdentifier(n.name)) {
            info.imports.set(n.name.text, { kind: 'namespace', module: resolved });
          }
        }
      }
      ts.forEachChild(n, findDynamic);
    };
    findDynamic(sf);
    modules.set(file.path, info);
  }

  /* ───────────────────────────── name resolution ───────────────────────────── */

  function resolveExport(module: string, name: string, seen = new Set<string>()): Target | null {
    if (module === NAV_MODULE) return NAV_THROWERS.has(name) ? { kind: 'seed', name } : null;
    const marker = `${module}#${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const info = modules.get(module);
    if (!info) return null;
    const local = info.exportsLocal.get(name);
    if (local !== undefined) return resolveLocal(info, local, seen);
    for (const re of info.reexports) {
      if (re.names) {
        const original = re.names.get(name);
        if (original !== undefined) return resolveExport(re.module, original, seen);
      } else {
        const found = resolveExport(re.module, name, seen);
        if (found) return found;
      }
    }
    return null;
  }

  function resolveLocal(info: ModuleInfo, name: string, seen = new Set<string>()): Target | null {
    const fn = info.locals.get(name);
    if (fn) return { kind: 'fn', key: fn.key, name };
    if (info.classes.has(name)) return { kind: 'class', module: info.file, name };
    const binding = info.imports.get(name);
    if (!binding) return null;
    if (binding.kind === 'namespace') return { kind: 'namespace', module: binding.module };
    return resolveExport(binding.module, binding.name, seen);
  }

  function resolveExpression(info: ModuleInfo, expr: ts.Expression): Target | null {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) return resolveLocal(info, e.text);
    if (ts.isPropertyAccessExpression(e)) {
      const owner = resolveExpression(info, e.expression);
      if (!owner) return null;
      if (owner.kind === 'namespace') return resolveExport(owner.module, e.name.text);
      if (owner.kind === 'class') {
        const cls = modules.get(owner.module);
        const fn = cls?.locals.get(`${owner.name}.${e.name.text}`);
        return fn ? { kind: 'fn', key: fn.key, name: `${owner.name}.${e.name.text}` } : null;
      }
    }
    return null;
  }

  /** Every call target, and every function passed as an argument, under `node`. */
  function references(info: ModuleInfo, node: ts.Node): Target[] {
    const out: Target[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = resolveExpression(info, n.expression);
        if (callee) out.push(callee);
        for (const arg of n.arguments) {
          if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
            const passed = resolveExpression(info, arg);
            if (passed) out.push(passed);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  }

  /* ───────────────────────── which functions can redirect ───────────────────────── */

  const fnRefs = new Map<string, Target[]>();
  const fnByKey = new Map<string, { info: ModuleInfo; decl: FnDecl }>();
  for (const info of modules.values()) {
    for (const decl of info.locals.values()) {
      fnByKey.set(decl.key, { info, decl });
      fnRefs.set(
        decl.key,
        decl.bodies.flatMap((b) => references(info, b)),
      );
    }
  }
  const redirecting = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, refs] of fnRefs) {
      if (redirecting.has(key)) continue;
      if (refs.some((t) => t.kind === 'seed' || (t.kind === 'fn' && redirecting.has(t.key)))) {
        redirecting.add(key);
        changed = true;
      }
    }
  }

  /** The first thing under `node` that can redirect, by name, or null. */
  function reachesRedirect(info: ModuleInfo, node: ts.Node): string | null {
    for (const t of references(info, node)) {
      if (t.kind === 'seed') return t.name;
      if (t.kind === 'fn' && redirecting.has(t.key)) return t.name;
    }
    return null;
  }

  /* ───────────────────────────── the accepted shapes ───────────────────────────── */

  function isHelperCall(
    info: ModuleInfo,
    expr: ts.Expression,
    helper: string,
    param: string,
  ): boolean {
    const e = unwrap(expr);
    if (!ts.isCallExpression(e)) return false;
    const callee = unwrap(e.expression);
    if (!ts.isIdentifier(callee)) return false;
    const binding = info.imports.get(callee.text);
    if (
      !binding ||
      binding.kind !== 'named' ||
      binding.module !== controlFlowModule ||
      binding.name !== helper
    ) {
      return false;
    }
    const arg = e.arguments[0];
    return !!arg && ts.isIdentifier(arg) && arg.text === param;
  }

  function isRethrowStatement(
    info: ModuleInfo,
    st: ts.Statement | undefined,
    param: string,
  ): boolean {
    return (
      !!st &&
      ts.isExpressionStatement(st) &&
      isHelperCall(info, st.expression, 'rethrowControlFlow', param)
    );
  }

  /** Parameter index a function rethrows control flow from as its first statement. */
  const rethrowingParam = new Map<string, number>();
  for (const [key, { info, decl }] of fnByKey) {
    const fn = decl.bodies[0];
    if (!fn || decl.bodies.length !== 1 || !fn.body || !ts.isBlock(fn.body)) continue;
    const first = fn.body.statements[0];
    fn.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name) && isRethrowStatement(info, first, p.name.text))
        rethrowingParam.set(key, i);
      if (
        ts.isIdentifier(p.name) &&
        first &&
        ts.isIfStatement(first) &&
        isControlFlowGuard(info, first, p.name.text, 'throw')
      ) {
        rethrowingParam.set(key, i);
      }
    });
  }

  /** `if (isControlFlow(e)) throw e;` (mode 'throw') or `... return ...;` too (mode 'either'). */
  function isControlFlowGuard(
    info: ModuleInfo,
    st: ts.IfStatement,
    param: string,
    mode: 'throw' | 'either',
  ): boolean {
    if (st.elseStatement || !isHelperCall(info, st.expression, 'isControlFlow', param))
      return false;
    let then: ts.Statement | undefined = st.thenStatement;
    if (ts.isBlock(then)) then = then.statements.length === 1 ? then.statements[0] : undefined;
    if (!then) return false;
    if (ts.isThrowStatement(then)) {
      const thrown = then.expression && unwrap(then.expression);
      return !!thrown && ts.isIdentifier(thrown) && thrown.text === param;
    }
    return mode === 'either' && ts.isReturnStatement(then);
  }

  /** `return toResult(e)`, `const f = fail(e, tag)`, `throw mapped(e)`, `toResult(e);`. */
  function isRethrowingMapperCall(info: ModuleInfo, st: ts.Statement, param: string): boolean {
    let expr: ts.Expression | undefined;
    if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) expr = st.expression;
    else if (ts.isExpressionStatement(st)) expr = st.expression;
    else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
      expr = st.declarationList.declarations[0]?.initializer;
    }
    if (!expr) return false;
    const call = unwrap(expr);
    if (!ts.isCallExpression(call)) return false;
    const target = resolveExpression(info, call.expression);
    if (!target || target.kind !== 'fn') return false;
    const index = rethrowingParam.get(target.key);
    if (index === undefined) return false;
    const arg = call.arguments[index];
    return !!arg && ts.isIdentifier(arg) && arg.text === param;
  }

  type Mode = 'server' | 'client' | 'server-caller';

  /** Why this handler does not put control flow first, or null when it does. */
  function handlerProblem(
    info: ModuleInfo,
    param: ts.BindingName | undefined,
    statements: readonly ts.Statement[] | null,
    expressionBody: ts.Expression | null,
    mode: Mode,
  ): string | null {
    if (!param) return 'binds no error, so it cannot rethrow a redirect';
    if (!ts.isIdentifier(param)) return 'destructures the error, so it cannot rethrow a redirect';
    const name = param.text;
    const want =
      mode === 'client'
        ? `if (isControlFlow(${name})) return; (or rethrowControlFlow(${name}))`
        : mode === 'server-caller'
          ? `rethrowControlFlow(${name}) or if (isControlFlow(${name})) throw ${name};`
          : `rethrowControlFlow(${name})`;
    if (expressionBody) {
      if (isHelperCall(info, expressionBody, 'rethrowControlFlow', name)) return null;
      const call = unwrap(expressionBody);
      if (ts.isCallExpression(call)) {
        const target = resolveExpression(info, call.expression);
        const index = target && target.kind === 'fn' ? rethrowingParam.get(target.key) : undefined;
        const arg = index !== undefined ? call.arguments[index] : undefined;
        if (arg && ts.isIdentifier(arg) && arg.text === name) return null;
      }
      return `answers with \`${squash(expressionBody.getText(info.sf))}\` before ${want}`;
    }
    const first = statements?.[0];
    if (!first) return `is empty: it must start with ${want}`;
    if (isRethrowStatement(info, first, name)) return null;
    if (isRethrowingMapperCall(info, first, name)) return null;
    if (mode !== 'server' && ts.isIfStatement(first)) {
      if (isControlFlowGuard(info, first, name, mode === 'client' ? 'either' : 'throw'))
        return null;
    }
    return `starts with \`${squash(first.getText(info.sf))}\` instead of ${want}`;
  }

  function enclosingName(node: ts.Node): string {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
      if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
      if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        ts.isVariableDeclaration(n.parent)
      ) {
        if (ts.isIdentifier(n.parent.name)) return n.parent.name.text;
      }
    }
    return '(top level)';
  }

  /** A handler passed to `.catch(h)` / `.then(_, h)`: its parameter and body. */
  function handlerParts(
    info: ModuleInfo,
    h: ts.Expression,
  ):
    | {
        param: ts.BindingName | undefined;
        statements: readonly ts.Statement[] | null;
        expr: ts.Expression | null;
      }
    | 'mapper' {
    const fn = unwrap(h);
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      const param = fn.parameters[0]?.name;
      if (ts.isBlock(fn.body)) return { param, statements: fn.body.statements, expr: null };
      return { param, statements: null, expr: fn.body };
    }
    const target = resolveExpression(info, fn);
    if (target && target.kind === 'fn' && rethrowingParam.get(target.key) === 0) return 'mapper';
    return { param: undefined, statements: null, expr: null };
  }

  /* ───────────────────────────────── the scan ───────────────────────────────── */

  const serverFindings: CatchFinding[] = [];
  const callerFindings: CatchFinding[] = [];
  let guardedServerCatches = 0;
  let guardedCallerCatches = 0;

  const actionFiles = new Set(
    [...modules.values()].filter((m) => m.isActionModule).map((m) => m.file),
  );

  for (const info of modules.values()) {
    const line = (n: ts.Node) =>
      info.sf.getLineAndCharacterOfPosition(n.getStart(info.sf)).line + 1;

    /** The Server Action this node calls, by local name, or null. */
    const callsAction = (node: ts.Node): string | null => {
      let found: string | null = null;
      const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          if (ts.isIdentifier(callee)) {
            const b = info.imports.get(callee.text);
            if (b && b.kind === 'named' && actionFiles.has(b.module)) {
              found = callee.text;
              return;
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return found;
    };

    const record = (
      server: boolean,
      node: ts.Node,
      kind: CatchFinding['kind'],
      reaches: string,
      problem: string | null,
    ) => {
      if (problem === null) {
        if (server) guardedServerCatches++;
        else guardedCallerCatches++;
        return;
      }
      (server ? serverFindings : callerFindings).push({
        file: info.file,
        line: line(node),
        fn: enclosingName(node),
        kind,
        reaches,
        problem,
      });
    };

    const callerMode: Mode = info.isClientModule ? 'client' : 'server-caller';

    const visit = (n: ts.Node, inAction: boolean) => {
      let action = inAction;
      if (
        isFunctionNode(n) &&
        n.body &&
        ts.isBlock(n.body) &&
        prologue(n.body.statements).includes('use server')
      ) {
        action = true;
      }
      if (ts.isTryStatement(n) && n.catchClause) {
        const c = n.catchClause;
        if (action) {
          const reaches = reachesRedirect(info, n.tryBlock);
          if (reaches) {
            record(
              true,
              n,
              'catch',
              reaches,
              handlerProblem(info, c.variableDeclaration?.name, c.block.statements, null, 'server'),
            );
          }
        } else if (!info.isActionModule) {
          const reaches = callsAction(n.tryBlock);
          if (reaches) {
            record(
              false,
              n,
              'catch',
              reaches,
              handlerProblem(
                info,
                c.variableDeclaration?.name,
                c.block.statements,
                null,
                callerMode,
              ),
            );
          }
        }
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const handler =
          method === 'catch'
            ? n.arguments[0]
            : method === 'then' && n.arguments.length >= 2
              ? n.arguments[1]
              : undefined;
        if (handler) {
          const receiver = n.expression.expression;
          const reaches = action
            ? reachesRedirect(info, receiver)
            : info.isActionModule
              ? null
              : callsAction(receiver);
          if (reaches) {
            const parts = handlerParts(info, handler);
            const problem =
              parts === 'mapper'
                ? null
                : handlerProblem(
                    info,
                    parts.param,
                    parts.statements,
                    parts.expr,
                    action ? 'server' : callerMode,
                  );
            record(
              action,
              n,
              method === 'catch' ? 'promise-catch' : 'promise-then',
              reaches,
              problem,
            );
          }
        }
        if (
          action &&
          method === 'allSettled' &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === 'Promise'
        ) {
          const reaches = n.arguments[0] ? reachesRedirect(info, n.arguments[0]) : null;
          if (reaches) {
            record(
              true,
              n,
              'all-settled',
              reaches,
              'settles a redirect into a "rejected" result: resolve the context before Promise.allSettled',
            );
          }
        }
      }
      ts.forEachChild(n, (child) => visit(child, action));
    };
    visit(info.sf, info.isActionModule);
  }

  return {
    serverFindings,
    callerFindings,
    actionModules: [...actionFiles].sort(),
    guardedServerCatches,
    guardedCallerCatches,
    redirecting,
  };
}
