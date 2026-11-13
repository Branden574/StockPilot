import * as path from 'node:path';

import ts from 'typescript';

/**
 * Which functions can reach a given function, read on the syntax tree.
 *
 * Used by the two step-up guards (action-step-up.guard.test.ts and
 * page-step-up.guard.test.ts) to ask, of every Server Action and every
 * dashboard page: does this entry point reach requireOrgContext()
 * (lib/auth/session.ts), where a member who still owes an authenticator code
 * is sent to /signin/mfa?
 *
 * WHAT "REACHES" MEANS. A function reaches the target when its body calls it,
 * or calls (or passes as a callback) a function that reaches it, followed
 * across modules by import. The same resolution as test/action-catch-scan.ts:
 * top-level functions and `const f = wrap(async () => ...)`-style wrappers
 * (the wrapper counts as called), class static methods
 * (`InventoryService.forCurrentUser`), named, default, namespace and
 * destructured dynamic imports, and re-exports. With `jsx` on, a component a
 * function renders (`<Panel />`) counts as called too.
 *
 * A CALL WHOSE REDIRECT WOULD NOT GET OUT DOES NOT COUNT:
 *   - anything in a 'use client' module: it runs in the browser, later;
 *   - outside a 'use server' module, a call inside a `try` whose `catch` is
 *     not seen to rethrow, the promise a `.catch(...)` or a two-argument
 *     `.then(...)` is attached to when its handler is not seen to rethrow,
 *     and the promises handed to Promise.allSettled. Such a catch may keep the
 *     redirect (audit()'s context fallback does, by design). A catch is seen
 *     to rethrow when it starts with rethrowControlFlow(e), unstable_rethrow(e)
 *     or `if (isNextControlFlowError(e)) throw e;` (isControlFlow too), or
 *     ends with `throw e;`.
 *   Inside a 'use server' module every such call counts: there each catch
 *   around a call that can redirect must rethrow it first, which
 *   server/actions/action-catch.guard.test.ts holds.
 *
 * WHAT IT IS NOT. It is a reading of what a function CAN call, not a proof of
 * what it does call on every path: a call behind an `if`, or after an early
 * return, still counts. Not followed: instance methods (a service built from
 * a context that was already resolved), and functions held in variables.
 *
 * "ASKS FIRST" NARROWS THAT. A function asks first when the first call it
 * awaits, in source order, is the target or a function that itself asks
 * first (all the way down), and that call's redirect gets out. Whatever a
 * function awaits first runs on every path through it that awaits anything,
 * so nothing was read before the target answered. A function that awaits no
 * call at all asks first when it calls one that does (`return withContext()`).
 *
 * `await Promise.all([a(), b(), c])` asks first only when EVERY entry that
 * starts a call asks first: the entries all start together, so a call beside
 * the target would run for a session the target then turns away. An entry
 * asks first when the call it begins with does: `a()`, or the `a()` under
 * `a().then(...)` and `a().catch(...)`. Anything else that starts a call (a
 * method of a value, an inline function called on the spot, a call inside an
 * expression) is read as not asking. An entry
 * that calls nothing (`searchParams`, `params`) starts nothing, and neither
 * does a bare call of one of INERT_ENTRIES: the request's own cookie jar or
 * headers, or making the cookie client, none of which reads any data.
 *
 * EVERY RUNTIME EXPORT IS LISTED, READABLE OR NOT. runtimeExports() names all
 * a module exports at run time; an export this reading cannot resolve to a
 * function (`export const x = wrap(handler)`, an alias of another function,
 * `.bind(...)`, a destructured or conditional export, `export default
 * <expression>`, a re-export from a package) answers null to every question
 * below, and the guards report it by name instead of leaving it out.
 *
 * Parsed with the TypeScript compiler, not a regex: comments and strings never
 * count.
 */

export interface ReachFile {
  /** Absolute path. */
  path: string;
  text: string;
}

export interface ReachOptions {
  /** Also follow the components a function renders as JSX elements. */
  jsx?: boolean;
}

/** A Server Action written inside another module: a function whose body starts with 'use server'. */
export interface InlineAction {
  file: string;
  /** The enclosing named function or variable, or '(anonymous)'. */
  name: string;
  line: number;
  reaches: boolean;
}

/** What reaches one set of targets. */
export interface Reach {
  /** Does the function exported from `file` as `name` reach a target? Null when there is no such function. */
  exportReaches(file: string, name: string): boolean | null;
  /**
   * How the function exported from `file` as `name` reaches a target: the
   * chain of functions, as `<src-relative file>#<name>`, ending at the target.
   * Null when it does not.
   */
  pathToTarget(file: string, name: string): string[] | null;
  /**
   * Does the function exported from `file` as `name` ask a target first (see
   * the note at the top of this file)? Null when there is no such function.
   */
  exportAsksFirst(file: string, name: string): boolean | null;
  /**
   * The first call the function exported from `file` as `name` awaits, in
   * source order (nested functions left out), for saying what an entry point
   * that does not ask first does instead. `none` when it awaits no call. Null
   * when the export is not a single function.
   */
  firstAwaitedCall(file: string, name: string): { line: number; text: string } | 'none' | null;
  /**
   * When the first call the export awaits is `Promise.all([...])`: the first
   * entry that starts a call which does not ask a target first, so it runs
   * beside the target. Null when there is none (or no such function).
   */
  startedBesideFirst(file: string, name: string): { line: number; text: string } | null;
  /** Server Actions declared inside modules that are not 'use server' modules. */
  inlineActions: InlineAction[];
  /** Number of functions found to reach a target. */
  reachingCount: number;
}

export interface CallGraph {
  /** Absolute paths of the modules whose first statement is 'use server'. */
  actionModules: string[];
  /** Absolute paths of the modules whose first statement is 'use client'. */
  clientModules: ReadonlySet<string>;
  /** Names a module exports that are functions (or classes), own and re-exported. */
  exportedFunctions(file: string): string[];
  /**
   * Every name a module exports at run time, own and re-exported, whether or
   * not this reading can resolve it to a function: types and interfaces are
   * left out, nothing else is. A `'use server'` module turns each one into an
   * endpoint.
   */
  runtimeExports(file: string): string[];
  /** Does the module export `name` at all (a function, a class, or a value)? */
  hasExport(file: string, name: string): boolean;
  /** What reaches any of `targets` (each `<absolute file>#<name>`, a top-level function). */
  reach(targets: readonly string[], options?: ReachOptions): Reach;
}

type FunctionNode =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface FnDecl {
  key: string;
  bodies: FunctionNode[];
  /** `wrap` in `const f = wrap(async () => ...)`: counted as called by `f`. */
  wrappers: ts.Expression[];
}

type Binding =
  { kind: 'named'; module: string; name: string } | { kind: 'namespace'; module: string };

interface ModuleInfo {
  file: string;
  sf: ts.SourceFile;
  isActionModule: boolean;
  isClientModule: boolean;
  locals: Map<string, FnDecl>;
  classes: Set<string>;
  /** Every top-level name the module declares (functions, classes, values). */
  declared: Set<string>;
  /** Every named import, resolved or not: local name -> `<module specifier>#<imported name>`. */
  importSpecs: Map<string, string>;
  exportsLocal: Map<string, string>;
  /** Runtime exports that are no top-level name of this module: exported name -> what it is. */
  exportsUnread: Map<string, string>;
  /** Names declared only as a type (an interface or a type alias). */
  typeNames: Set<string>;
  reexports: Array<{ module: string; names: Map<string, string> | null }>;
  imports: Map<string, Binding>;
}

type Target =
  | { kind: 'fn'; key: string }
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

function squash(text: string, max = 90): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

const RETHROW_CALLS = new Set(['rethrowControlFlow', 'unstable_rethrow']);
const CONTROL_FLOW_TESTS = new Set(['isNextControlFlowError', 'isControlFlow']);

/** `name(param)`, by the callee's name. */
function isCallOf(expr: ts.Expression, names: ReadonlySet<string>, param: string): boolean {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false;
  const arg = e.arguments[0];
  return names.has(e.expression.text) && !!arg && ts.isIdentifier(arg) && arg.text === param;
}

function throwsParam(st: ts.Statement | undefined, param: string): boolean {
  if (st && ts.isBlock(st))
    return st.statements.length === 1 && throwsParam(st.statements[0], param);
  if (!st || !ts.isThrowStatement(st) || !st.expression) return false;
  const thrown = unwrap(st.expression);
  return ts.isIdentifier(thrown) && thrown.text === param;
}

/** Do these statements, the body of a catch that bound `param`, let a redirect out? */
function rethrows(param: ts.BindingName | undefined, statements: readonly ts.Statement[]): boolean {
  if (!param || !ts.isIdentifier(param)) return false;
  const first = statements[0];
  if (!first) return false;
  if (ts.isExpressionStatement(first) && isCallOf(first.expression, RETHROW_CALLS, param.text)) {
    return true;
  }
  if (
    ts.isIfStatement(first) &&
    !first.elseStatement &&
    isCallOf(first.expression, CONTROL_FLOW_TESTS, param.text) &&
    throwsParam(first.thenStatement, param.text)
  ) {
    return true;
  }
  return throwsParam(statements[statements.length - 1], param.text);
}

/** Does a handler passed to `.catch(h)` or `.then(_, h)` let a redirect out? */
function handlerRethrows(handler: ts.Expression | undefined): boolean {
  const fn = handler && unwrap(handler);
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  return ts.isBlock(fn.body) && rethrows(fn.parameters[0]?.name, fn.body.statements);
}

/** Every name a binding pattern declares: `{ a, b: [c] }` gives a and c. */
function boundNames(pattern: ts.BindingName): string[] {
  if (ts.isIdentifier(pattern)) return [pattern.text];
  return pattern.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
}

/** `Promise.all([...])`, awaited or not: its entries, else null. */
function promiseAllEntries(node: ts.Node): readonly ts.Expression[] | null {
  const e = ts.isExpression(node) ? unwrap(node) : node;
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return null;
  const { expression: owner, name } = e.expression;
  if (!ts.isIdentifier(owner) || owner.text !== 'Promise' || name.text !== 'all') return null;
  const list = e.arguments[0] && unwrap(e.arguments[0]);
  return list && ts.isArrayLiteralExpression(list) ? list.elements : null;
}

/**
 * Calls that read no data, as `<module specifier>#<name>`: the request's own
 * cookie jar and headers, and making the cookie client. Beside the target in
 * a Promise.all they start nothing a session could be turned away from.
 */
const INERT_ENTRIES: ReadonlySet<string> = new Set([
  'next/headers#cookies',
  'next/headers#headers',
  'next/headers#draftMode',
  '@/lib/supabase/server#createClient',
]);

/**
 * What a Promise.all entry begins with: the callee of `a()`, or of the `a()`
 * under `a().then(...)`, however long the chain. Null when the entry is not a
 * call.
 */
function headCallee(entry: ts.Expression): ts.Expression | null {
  const start = unwrap(entry);
  if (!ts.isCallExpression(start)) return null;
  let call: ts.CallExpression = start;
  for (;;) {
    const callee: ts.Expression = call.expression;
    const owner = ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : null;
    if (!owner || !ts.isCallExpression(owner)) return callee;
    call = owner;
  }
}

/** Does `node` call anything itself (nested functions left out)? */
function startsACall(node: ts.Node): boolean {
  if (isFunctionNode(node)) return false;
  if (ts.isCallExpression(node)) return true;
  return ts.forEachChild(node, (c) => startsACall(c) || undefined) ?? false;
}

/** Parse `files` once; `reach()` then answers for any set of targets. */
export function buildCallGraph(files: ReachFile[], srcRoot: string): CallGraph {
  const byPath = new Map(files.map((f) => [f.path, f]));

  function resolveSpec(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return null;
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
      declared: new Set(),
      importSpecs: new Map(),
      exportsLocal: new Map(),
      exportsUnread: new Map(),
      typeNames: new Set(),
      reexports: [],
      imports: new Map(),
    };
    const addLocal = (name: string, bodies: FunctionNode[], wrappers: ts.Expression[] = []) => {
      if (bodies.length) {
        info.locals.set(name, { key: `${file.path}#${name}`, bodies, wrappers });
      }
    };
    for (const st of sf.statements) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause;
        if (!clause || clause.isTypeOnly) continue;
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (el.isTypeOnly) continue;
            info.importSpecs.set(
              el.name.text,
              `${st.moduleSpecifier.text}#${(el.propertyName ?? el.name).text}`,
            );
          }
        }
        const resolved = resolveSpec(file.path, st.moduleSpecifier.text);
        if (!resolved) continue;
        if (clause.name) {
          info.imports.set(clause.name.text, { kind: 'named', module: resolved, name: 'default' });
        }
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          info.imports.set(nb.name.text, { kind: 'namespace', module: resolved });
        }
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
        info.declared.add(name);
        addLocal(name, [st]);
        if (exported) info.exportsLocal.set(isDefault ? 'default' : name, name);
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) {
            // `export const { a, b } = obj`: each name is exported, and none
            // is a function this reading can follow.
            if (exported) {
              for (const bound of boundNames(decl.name)) {
                info.exportsUnread.set(bound, 'a destructured export');
              }
            }
            continue;
          }
          info.declared.add(decl.name.text);
          if (exported) info.exportsLocal.set(decl.name.text, decl.name.text);
          if (!decl.initializer) continue;
          const init = unwrap(decl.initializer);
          if (isFunctionNode(init)) addLocal(decl.name.text, [init]);
          else if (ts.isCallExpression(init)) {
            addLocal(
              decl.name.text,
              init.arguments.filter(
                (a): a is ts.FunctionExpression | ts.ArrowFunction =>
                  ts.isFunctionExpression(a) || ts.isArrowFunction(a),
              ),
              [init.expression],
            );
          }
        }
      } else if (ts.isClassDeclaration(st) && !st.name) {
        if (exported && isDefault) info.exportsUnread.set('default', 'a class');
      } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
        info.typeNames.add(st.name.text);
      } else if (
        (ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) &&
        exported &&
        !hasModifier(st, ts.SyntaxKind.DeclareKeyword) &&
        ts.isIdentifier(st.name)
      ) {
        info.exportsUnread.set(st.name.text, ts.isEnumDeclaration(st) ? 'an enum' : 'a namespace');
      } else if (ts.isClassDeclaration(st) && st.name) {
        const cls = st.name.text;
        info.classes.add(cls);
        info.declared.add(cls);
        if (exported) info.exportsLocal.set(isDefault ? 'default' : cls, cls);
        for (const member of st.members) {
          if (!hasModifier(member, ts.SyntaxKind.StaticKeyword) || !member.name) continue;
          if (!ts.isIdentifier(member.name)) continue;
          if (ts.isMethodDeclaration(member) && member.body) {
            addLocal(`${cls}.${member.name.text}`, [member]);
          }
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
        if (st.moduleSpecifier && !resolved) {
          // A re-export from a module this reading does not hold (a package):
          // still exported, by a name where it has one.
          const from = `a re-export from '${(st.moduleSpecifier as ts.StringLiteral).text}'`;
          if (!st.exportClause) info.exportsUnread.set(`* (${from})`, from);
          else if (ts.isNamedExports(st.exportClause)) {
            for (const el of st.exportClause.elements) {
              if (!el.isTypeOnly) info.exportsUnread.set(el.name.text, from);
            }
          } else info.exportsUnread.set(st.exportClause.name.text, from);
          continue;
        }
        if (!st.exportClause) {
          if (resolved) info.reexports.push({ module: resolved, names: null });
          continue;
        }
        if (ts.isNamespaceExport(st.exportClause)) {
          info.exportsUnread.set(st.exportClause.name.text, 'a namespace of another module');
          continue;
        }
        if (ts.isNamedExports(st.exportClause)) {
          const names = new Map<string, string>();
          for (const el of st.exportClause.elements) {
            if (el.isTypeOnly) continue;
            names.set(el.name.text, (el.propertyName ?? el.name).text);
          }
          if (resolved) info.reexports.push({ module: resolved, names });
          else {
            for (const [exportedName, local] of names) info.exportsLocal.set(exportedName, local);
          }
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const value = unwrap(st.expression);
        if (ts.isIdentifier(value)) info.exportsLocal.set('default', value.text);
        else if (isFunctionNode(value)) {
          info.declared.add('default');
          addLocal('default', [value]);
          info.exportsLocal.set('default', 'default');
        } else info.exportsUnread.set('default', 'a default export that is an expression');
      }
    }
    // `interface Row {}` then `export { Row }`: a type, exported by a plain
    // export list. Not a runtime export.
    for (const [exportedName, local] of [...info.exportsLocal]) {
      if (info.typeNames.has(local) && !info.declared.has(local) && !info.imports.has(local)) {
        info.exportsLocal.delete(exportedName);
      }
    }
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
    if (fn) return { kind: 'fn', key: fn.key };
    if (info.classes.has(name)) return { kind: 'class', module: info.file, name };
    const binding = info.imports.get(name);
    if (!binding) return null;
    if (binding.kind === 'namespace') return { kind: 'namespace', module: binding.module };
    return resolveExport(binding.module, binding.name, seen);
  }

  function resolveExpression(info: ModuleInfo, expr: ts.Node): Target | null {
    const e = ts.isExpression(expr) ? unwrap(expr) : expr;
    if (ts.isIdentifier(e)) return resolveLocal(info, e.text);
    if (ts.isPropertyAccessExpression(e)) {
      const owner = resolveExpression(info, e.expression);
      if (!owner) return null;
      if (owner.kind === 'namespace') return resolveExport(owner.module, e.name.text);
      if (owner.kind === 'class') {
        const fn = modules.get(owner.module)?.locals.get(`${owner.name}.${e.name.text}`);
        return fn ? { kind: 'fn', key: fn.key } : null;
      }
    }
    return null;
  }

  /**
   * Every function called, passed as an argument, or (with `jsx`) rendered
   * under `node`, leaving out the calls whose redirect would not get out (see
   * the note at the top of this file).
   */
  function references(info: ModuleInfo, node: ts.Node, jsx: boolean): string[] {
    if (info.isClientModule) return [];
    const out: string[] = [];
    const push = (t: Target | null) => {
      if (t?.kind === 'fn') out.push(t.key);
    };
    const visit = (n: ts.Node) => {
      if (!info.isActionModule) {
        if (ts.isTryStatement(n) && n.catchClause) {
          const c = n.catchClause;
          if (rethrows(c.variableDeclaration?.name, c.block.statements)) visit(n.tryBlock);
          visit(c);
          if (n.finallyBlock) visit(n.finallyBlock);
          return;
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const method = n.expression.name.text;
          const receiver = n.expression.expression;
          const handler =
            method === 'catch'
              ? n.arguments[0]
              : method === 'then' && n.arguments.length >= 2
                ? n.arguments[1]
                : undefined;
          if (handler) {
            if (handlerRethrows(handler)) visit(receiver);
            n.arguments.forEach(visit);
            return;
          }
          if (method === 'allSettled' && ts.isIdentifier(receiver) && receiver.text === 'Promise') {
            return;
          }
        }
      }
      if (ts.isCallExpression(n)) {
        push(resolveExpression(info, n.expression));
        for (const arg of n.arguments) {
          if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
            push(resolveExpression(info, arg));
          }
        }
      }
      if (jsx && (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) {
        push(resolveExpression(info, n.tagName));
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  }

  /** A function's body (a block, or an arrow's expression), when it is one function. */
  function bodyOf(key: string): { info: ModuleInfo; body: ts.Node } | null {
    const [file, name] = [key.slice(0, key.lastIndexOf('#')), key.slice(key.lastIndexOf('#') + 1)];
    const info = modules.get(file);
    const decl = info?.locals.get(name);
    const fn = decl?.bodies.length === 1 ? decl.bodies[0] : undefined;
    if (!info || !fn?.body) return null;
    return { info, body: fn.body };
  }

  /**
   * Where a function's first step is: the first call it awaits, or its whole
   * body when it awaits none.
   */
  function firstStepOf(key: string): { info: ModuleInfo; node: ts.Node; body: ts.Node } | null {
    const found = bodyOf(key);
    if (!found) return null;
    const { info, body } = found;
    const first = firstAwaitOfCall(ts.isBlock(body) ? body.statements : [body]);
    return { info, node: first ?? body, body };
  }

  function exportedNames(file: string, seen = new Set<string>()): Map<string, Target | null> {
    const out = new Map<string, Target | null>();
    if (seen.has(file)) return out;
    seen.add(file);
    const info = modules.get(file);
    if (!info) return out;
    for (const [exportedName, local] of info.exportsLocal) {
      out.set(exportedName, resolveLocal(info, local));
    }
    for (const exportedName of info.exportsUnread.keys()) {
      if (!out.has(exportedName)) out.set(exportedName, null);
    }
    for (const re of info.reexports) {
      if (re.names) {
        for (const [exportedName, original] of re.names) {
          out.set(exportedName, resolveExport(re.module, original));
        }
      } else {
        for (const [name, t] of exportedNames(re.module, seen)) {
          if (name !== 'default' && !out.has(name)) out.set(name, t);
        }
      }
    }
    return out;
  }

  /**
   * Is `node`, somewhere under `within`, in a place whose redirect would not
   * get out: a `try` whose catch is not seen to rethrow, or the promise a
   * handler that is not seen to rethrow is attached to? Never inside a
   * 'use server' module (see the note at the top of this file).
   */
  function redirectIsKept(info: ModuleInfo, node: ts.Node, within: ts.Node): boolean {
    if (info.isActionModule) return false;
    for (let child = node, n = node.parent; n && child !== within; child = n, n = n.parent) {
      if (ts.isTryStatement(n) && n.catchClause && child === n.tryBlock) {
        const c = n.catchClause;
        if (!rethrows(c.variableDeclaration?.name, c.block.statements)) return true;
      }
      if (
        ts.isPropertyAccessExpression(n) &&
        child === n.expression &&
        ts.isCallExpression(n.parent) &&
        n.parent.expression === n
      ) {
        const method = n.name.text;
        const args = n.parent.arguments;
        const handler =
          method === 'catch'
            ? args[0]
            : method === 'then' && args.length >= 2
              ? args[1]
              : undefined;
        if (handler && !handlerRethrows(handler)) return true;
      }
    }
    return false;
  }

  /** A bare call of one of INERT_ENTRIES, by the module it was imported from. */
  function isInertEntry(info: ModuleInfo, entry: ts.Expression): boolean {
    const e = unwrap(entry);
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false;
    if (info.declared.has(e.expression.text)) return false;
    return INERT_ENTRIES.has(info.importSpecs.get(e.expression.text) ?? '');
  }

  /** The first `await` of a call under `statements`, in source order, nested functions left out. */
  function firstAwaitOfCall(statements: readonly ts.Node[]): ts.AwaitExpression | null {
    let first: ts.AwaitExpression | null = null;
    const hasCall = (n: ts.Node): boolean => {
      if (isFunctionNode(n)) return false;
      if (ts.isCallExpression(n)) return true;
      return ts.forEachChild(n, (c) => hasCall(c) || undefined) ?? false;
    };
    const visit = (n: ts.Node) => {
      if (first || isFunctionNode(n)) return;
      // An await inside this one's operand completes before this one does.
      ts.forEachChild(n, visit);
      if (!first && ts.isAwaitExpression(n) && hasCall(n.expression)) first = n;
    };
    statements.forEach(visit);
    return first;
  }

  /** What each function refers to, worked out once per mode: it does not depend on the targets. */
  const refsByMode = new Map<boolean, Map<string, string[]>>();
  function refsFor(jsx: boolean): Map<string, string[]> {
    let fnRefs = refsByMode.get(jsx);
    if (fnRefs) return fnRefs;
    fnRefs = new Map<string, string[]>();
    for (const info of modules.values()) {
      for (const decl of info.locals.values()) {
        fnRefs.set(decl.key, [
          ...decl.bodies.flatMap((b) => references(info, b, jsx)),
          ...(info.isClientModule
            ? []
            : decl.wrappers.flatMap((w) => {
                const t = resolveExpression(info, w);
                return t?.kind === 'fn' ? [t.key] : [];
              })),
        ]);
      }
    }
    refsByMode.set(jsx, fnRefs);
    return fnRefs;
  }

  const reached = new Map<string, Reach>();
  function reach(targets: readonly string[], options: ReachOptions = {}): Reach {
    const jsx = options.jsx === true;
    const memoKey = `${jsx ? 'jsx' : 'calls'}:${[...targets].sort().join('|')}`;
    let answer = reached.get(memoKey);
    if (!answer) {
      answer = computeReach(targets, jsx);
      reached.set(memoKey, answer);
    }
    return answer;
  }

  function computeReach(targets: readonly string[], jsx: boolean): Reach {
    const isTarget = (key: string) => targets.includes(key);
    const fnRefs = refsFor(jsx);
    const reaching = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, refs] of fnRefs) {
        if (reaching.has(key)) continue;
        if (refs.some((k) => isTarget(k) || reaching.has(k))) {
          reaching.add(key);
          changed = true;
        }
      }
    }
    const nodeReaches = (info: ModuleInfo, node: ts.Node): boolean =>
      references(info, node, jsx).some((k) => isTarget(k) || reaching.has(k));

    // Which functions ASK FIRST: what each one's first step refers to, then
    // the same fixed point, over those first steps only.
    // For a first step that is `await Promise.all([...])`, `beside` holds
    // what each entry that starts a call refers to: every one of them must ask
    // first, because they all start together.
    interface FirstStep {
      refs: string[];
      /** Each entry that starts a call, with the function it begins with (null: not one this reading resolves). */
      beside: Array<{ node: ts.Expression; head: string | null }>;
      info: ModuleInfo;
    }
    const firstSteps = new Map<string, FirstStep>();
    for (const key of fnRefs.keys()) {
      if (!reaching.has(key)) continue;
      const step = firstStepOf(key);
      if (!step || redirectIsKept(step.info, step.node, step.body)) continue;
      const entries = ts.isAwaitExpression(step.node) ? promiseAllEntries(step.node) : null;
      firstSteps.set(key, {
        refs: references(step.info, step.node, false),
        beside: (entries ?? [])
          .filter((entry) => startsACall(entry) && !isInertEntry(step.info, entry))
          .map((entry) => {
            const callee = headCallee(entry);
            const head = callee ? resolveExpression(step.info, callee) : null;
            return { node: entry, head: head?.kind === 'fn' ? head.key : null };
          }),
        info: step.info,
      });
    }
    const asksFirst = new Set<string>();
    const asks = (k: string) => isTarget(k) || asksFirst.has(k);
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, step] of firstSteps) {
        if (asksFirst.has(key)) continue;
        if (
          step.refs.some(asks) &&
          step.beside.every((entry) => entry.head !== null && asks(entry.head))
        ) {
          asksFirst.add(key);
          changed = true;
        }
      }
    }

    const inlineActions: InlineAction[] = [];
    for (const info of modules.values()) {
      if (info.isActionModule) continue;
      const visit = (n: ts.Node) => {
        if (
          isFunctionNode(n) &&
          n.body &&
          ts.isBlock(n.body) &&
          prologue(n.body.statements).includes('use server')
        ) {
          let name = '(anonymous)';
          if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) {
            name = n.name.text;
          } else if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
            name = n.parent.name.text;
          }
          inlineActions.push({
            file: info.file,
            name,
            line: info.sf.getLineAndCharacterOfPosition(n.getStart(info.sf)).line + 1,
            reaches: nodeReaches(info, n),
          });
        }
        ts.forEachChild(n, visit);
      };
      visit(info.sf);
    }

    return {
      exportReaches(file, name) {
        const t = exportedNames(file).get(name);
        if (t?.kind !== 'fn') return null;
        return isTarget(t.key) || reaching.has(t.key);
      },
      pathToTarget(file, name) {
        const t = exportedNames(file).get(name);
        if (t?.kind !== 'fn') return null;
        const short = (key: string) => path.relative(srcRoot, key).split(path.sep).join('/');
        const chain: string[] = [];
        const seen = new Set<string>();
        for (let key: string | undefined = t.key; key && !seen.has(key);) {
          seen.add(key);
          chain.push(short(key));
          if (isTarget(key)) return chain;
          const refs: string[] = fnRefs.get(key) ?? [];
          key = refs.find((k) => isTarget(k)) ?? refs.find((k) => reaching.has(k) && !seen.has(k));
        }
        return null;
      },
      exportAsksFirst(file, name) {
        const t = exportedNames(file).get(name);
        if (t?.kind !== 'fn') return null;
        return isTarget(t.key) || asksFirst.has(t.key);
      },
      firstAwaitedCall(file, name) {
        const t = exportedNames(file).get(name);
        const found = t?.kind === 'fn' ? bodyOf(t.key) : null;
        if (!found) return null;
        const { info, body } = found;
        const first = firstAwaitOfCall(ts.isBlock(body) ? body.statements : [body]);
        if (!first) return 'none';
        return {
          line: info.sf.getLineAndCharacterOfPosition(first.getStart(info.sf)).line + 1,
          text: squash(first.getText(info.sf)),
        };
      },
      startedBesideFirst(file, name) {
        const t = exportedNames(file).get(name);
        const step = t?.kind === 'fn' ? firstSteps.get(t.key) : undefined;
        const entry = step?.beside.find((b) => b.head === null || !asks(b.head));
        if (!step || !entry) return null;
        const sf = step.info.sf;
        return {
          line: sf.getLineAndCharacterOfPosition(entry.node.getStart(sf)).line + 1,
          text: squash(entry.node.getText(sf)),
        };
      },
      inlineActions,
      reachingCount: reaching.size,
    };
  }

  return {
    actionModules: [...modules.values()]
      .filter((m) => m.isActionModule)
      .map((m) => m.file)
      .sort(),
    clientModules: new Set(
      [...modules.values()].filter((m) => m.isClientModule).map((m) => m.file),
    ),
    exportedFunctions(file) {
      return [...exportedNames(file)]
        .filter(([, t]) => t?.kind === 'fn' || t?.kind === 'class')
        .map(([name]) => name)
        .sort();
    },
    runtimeExports(file) {
      return [...exportedNames(file).keys()].sort();
    },
    hasExport(file, name) {
      return exportedNames(file).has(name);
    },
    reach,
  };
}

/**
 * Every source file under `srcRoot` that ships: `.ts` and `.tsx`, not a test,
 * not the test helpers, mocks or fixtures. `read` and `list` are the caller's
 * (node:fs), so this module stays free of the file system.
 */
export function shippedSourceFiles(
  srcRoot: string,
  fs: {
    readdirSync(dir: string): string[];
    statSync(file: string): { isDirectory(): boolean };
    readFileSync(file: string, encoding: 'utf8'): string;
  },
): ReachFile[] {
  const skipDirs = new Set(['__mocks__', '__fixtures__', '__parity__', 'node_modules']);
  const out: ReachFile[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (!skipDirs.has(name) && full !== path.join(srcRoot, 'test')) walk(full);
      } else if (
        /\.(ts|tsx)$/.test(name) &&
        !/\.test\.tsx?$/.test(name) &&
        !name.endsWith('.d.ts')
      ) {
        out.push({ path: full, text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(srcRoot);
  return out;
}
