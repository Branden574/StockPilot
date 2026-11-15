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
 * headers, or making the cookie client, none of which reads any data. A bare
 * call is the call alone: nothing chained on it and no call in its arguments
 * (`cookies()`, not `createClient().then(...)` or `cookies(read())`).
 *
 * EXCUSED BESIDE THE TARGET. reach()'s `besideAllowed` names functions whose
 * bare call may stand beside the target in that Promise.all although it does
 * not ask first itself. Only the bare call is excused, only as an entry beside
 * an entry that asks, and nothing else in the same Promise.all or anywhere
 * else in the function. The caller vouches for each one and checks it with
 * asksFirstAfterInert(): it is one plain function (or one wrapped by React's
 * `cache` and nothing else); the call that asks is a statement of its body
 * itself (not inside an `if`, a loop, a `try` or a conditional), so everything
 * after it is behind it on every path; that call's redirect gets out; and
 * before it the function awaits only bare INERT_ENTRIES calls and calls
 * nothing but methods of its own local values, handed nothing that runs (no
 * function, no name of one, no argument that starts a call).
 *
 * WHAT THAT CHECK DOES NOT JUDGE. Three things, none of them in the tree
 * today, are outside this reading and stay with review: work a helper starts
 * without awaiting it before its own first await; a function that takes a
 * context as an argument and is handed one that was not resolved by the gate;
 * and a name declared inside a function that is spelled like a module-level
 * import (names are resolved at module level throughout).
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
  /**
   * Functions (each `<absolute file>#<name>`) whose bare call is excused as a
   * Promise.all entry beside the target (see "EXCUSED BESIDE THE TARGET" at
   * the top of this file).
   */
  besideAllowed?: readonly string[];
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
  /**
   * Does the function exported from `file` as `name` ask a target before it
   * does anything else, apart from awaiting bare INERT_ENTRIES calls (the
   * request's own cookie jar and headers) and calling methods of values it
   * holds in its own local variables? Its first other awaited call must ask
   * first, by the same rule as a first step, be a statement of the body
   * itself, and let its redirect out; nothing else may be called before that
   * one, and no method may be handed anything that runs. The function is one
   * plain function, or one wrapped by React's `cache` alone (see "EXCUSED
   * BESIDE THE TARGET" at the top of this file). Null when there is no such
   * function.
   */
  asksFirstAfterInert(file: string, name: string): boolean | null;
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
  /** Which functions write, and whether a gate answers before their first write (see WRITES below). */
  writeGate(options: WriteGateOptions): WriteGate;
}

/*
 * WRITES AND THE GATE IN FRONT OF THEM. writeGate() reads, for one function,
 * whether it writes and whether a gate answers on every path before its first
 * write. Unlike reach(), it follows instance methods: `this.m()`,
 * `this.field.m()`, `new Service(ctx).m()`, `(await Service.forX()).m()`, and
 * `svc.m()` where `svc` is a parameter or a local whose type annotation names
 * a class, or whose initializer is one of those shapes, or a call of a
 * function (or static method) that is annotated to return the class or
 * returns `new Class(...)`. A method the class does not declare is looked up
 * on the class it extends.
 *
 * A WRITE is, on the syntax tree:
 *   - `.insert(`, `.update(`, `.upsert(`, `.delete(` on a chain that starts
 *     with a `.from(...)` call (the query builder), or on a local whose
 *     initializer is such a chain;
 *   - `.upload(`, `.remove(`, `.move(`, `.copy(` on a chain through `.storage`;
 *   - `.rpc(name, ...)`, unless `name` is a string listed in `readRpcs`;
 *   - any method under `.auth.admin` whose name does not start with get or list;
 *   - a call of a function (or method) that writes and does not itself answer
 *     a gate before its first write, and a function written in place (a
 *     callback) that does so: a callback is taken to run.
 * Functions named in `notWrites` are read as writing nothing.
 *
 * A GATE is a call of one of `gates`, or of a function that answers a gate on
 * every path that returns normally (it throws when the gate refuses), or the
 * statement `if (<x>.mfaRequired && !<x>.mfaSatisfied) <leave>` whose branch
 * always leaves (throws or returns). It counts only where it is UNCONDITIONAL:
 * a statement of the function on its way, not inside an `if` branch, a loop,
 * a `switch`, a conditional or logical expression, an optional call or a
 * callback, unless both branches of the `if` gate (or one gates and the other
 * always leaves). A `try` whose block gates gates what follows only when its
 * catch always leaves. A gate that is seen before the first write but is not
 * unconditional is reported by name (`conditionalGates`).
 *
 * WHAT IT IS NOT. A reading, not a proof: a write through a function held in a
 * variable or an object, a receiver whose class this reading cannot name, or a
 * client handed through an untyped value is not seen. A catch that writes is
 * read as writing before the gate (it may run after the gate refused).
 */

export interface WriteGateOptions {
  /** Functions (each `<absolute file>#<name>`) whose call is a gate. */
  gates: readonly string[];
  /** RPC names that only read. */
  readRpcs: ReadonlySet<string>;
  /** Functions (each `<absolute file>#<name>`) read as writing nothing. */
  notWrites?: readonly string[];
}

export interface WriteVerdict {
  /** Does it write at all (anywhere, gated or not)? */
  writes: boolean;
  /** The first write, in its own body, that no gate answers before. Null when every write is behind one. */
  openWrite: { line: number; text: string } | null;
  /** Gates met before that write that are not unconditional. */
  conditionalGates: Array<{ line: number; text: string }>;
  /** Is it a gate itself: every path that returns normally has passed one? */
  isGate: boolean;
  /** How that write is reached: each step as `<src-relative file>:<line> <text>`, down to the write itself. */
  writeChain: string[];
}

export interface WriteGate {
  /** The function exported from `file` as `name`. Null when it is not one readable function. */
  exportVerdict(file: string, name: string): WriteVerdict | null;
  /** The method `method` of the class `className` declared in `file`. Null when there is none. */
  methodVerdict(file: string, className: string, method: string): WriteVerdict | null;
  /** The methods other modules can call: of every exported class, neither private, protected nor `#`. */
  publicMethods(file: string): Array<{ className: string; method: string; isStatic: boolean }>;
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
  /** Every top-level class declaration, by name (read by writeGate() only). */
  classDecls: Map<string, ts.ClassDeclaration>;
  /** Type-only imports (`import type { X }`), for reading a type annotation's class. */
  typeImports: Map<string, Binding>;
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

/**
 * The callee of `entry` when it is a bare call: one call, nothing chained on
 * it (a `.then(...)` or `.catch(...)` makes the outer call's callee a
 * property of a call), and no argument that starts a call. Else null.
 */
function bareCallee(entry: ts.Expression): ts.Expression | null {
  const e = unwrap(entry);
  if (!ts.isCallExpression(e)) return null;
  if (e.arguments.some((arg) => startsACall(arg))) return null;
  return e.expression;
}

/** Does `node` call anything itself (nested functions left out)? */
function startsACall(node: ts.Node): boolean {
  if (isFunctionNode(node)) return false;
  if (ts.isCallExpression(node)) return true;
  return ts.forEachChild(node, (c) => startsACall(c) || undefined) ?? false;
}

/**
 * Each file's syntax tree, kept while its text is unchanged: a guard that
 * reads the tree again with one file changed (a mutation table) parses only
 * that file again. A tree is never changed by the reading.
 */
const parsedFiles = new Map<string, { text: string; sf: ts.SourceFile }>();
function parseOnce(file: ReachFile): ts.SourceFile {
  const held = parsedFiles.get(file.path);
  if (held && held.text === file.text) return held.sf;
  const sf = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedFiles.set(file.path, { text: file.text, sf });
  return sf;
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
    const sf = parseOnce(file);
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
      classDecls: new Map(),
      typeImports: new Map(),
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
        if (clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const typeModule = resolveSpec(file.path, st.moduleSpecifier.text);
          for (const el of clause.namedBindings.elements) {
            if (typeModule && (clause.isTypeOnly || el.isTypeOnly)) {
              info.typeImports.set(el.name.text, {
                kind: 'named',
                module: typeModule,
                name: (el.propertyName ?? el.name).text,
              });
            }
          }
        }
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
        info.classDecls.set(cls, st);
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
    const callee = bareCallee(entry);
    if (!callee || !ts.isIdentifier(callee)) return false;
    if (info.declared.has(callee.text)) return false;
    return INERT_ENTRIES.has(info.importSpecs.get(callee.text) ?? '');
  }

  /** A bare call of one of `allowed` (function keys), resolved by import. */
  function isAllowedBeside(
    info: ModuleInfo,
    entry: ts.Expression,
    allowed: ReadonlySet<string>,
  ): boolean {
    if (allowed.size === 0) return false;
    const callee = bareCallee(entry);
    const t = callee ? resolveExpression(info, callee) : null;
    return t?.kind === 'fn' && allowed.has(t.key);
  }

  /** Every `await` of a call under `statements`, in the order they complete, nested functions left out. */
  function awaitsOfCall(statements: readonly ts.Node[]): ts.AwaitExpression[] {
    const out: ts.AwaitExpression[] = [];
    const visit = (n: ts.Node) => {
      if (isFunctionNode(n)) return;
      // An await inside this one's operand completes before this one does.
      ts.forEachChild(n, visit);
      if (ts.isAwaitExpression(n) && startsACall(n.expression)) out.push(n);
    };
    statements.forEach(visit);
    return out;
  }

  /** Names the function body binds in its own variable declarations (nested functions left out). */
  function localNames(body: ts.Node): Set<string> {
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
      if (isFunctionNode(n)) return;
      if (ts.isVariableDeclaration(n)) boundNames(n.name).forEach((name) => out.add(name));
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    return out;
  }

  /** Names the function body binds to a function: a nested declaration, or a variable holding one. */
  function localFunctionNames(body: ts.Node): Set<string> {
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name) out.add(n.name.text);
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        isFunctionNode(unwrap(n.initializer))
      ) {
        out.add(n.name.text);
      }
      if (isFunctionNode(n)) return;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    return out;
  }

  /**
   * Does an argument hand the callee something that runs: a function written
   * in it (at any depth), a name of a function (one of the body's own, or one
   * this reading resolves to a function or a class), or a call it starts?
   */
  function handsOverCode(info: ModuleInfo, arg: ts.Expression, ownFunctions: ReadonlySet<string>): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (isFunctionNode(n) || ts.isCallExpression(n) || ts.isNewExpression(n)) {
        found = true;
        return;
      }
      if (ts.isIdentifier(n)) {
        const t = ownFunctions.has(n.text) ? null : resolveExpression(info, n);
        if (ownFunctions.has(n.text) || t?.kind === 'fn' || t?.kind === 'class') found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(arg);
    return found;
  }

  /**
   * Is the function `key` names written as one plain function, or as one
   * function wrapped by React's `cache` and by nothing else?
   */
  function isPlainOrReactCached(key: string): boolean {
    const [file, name] = [key.slice(0, key.lastIndexOf('#')), key.slice(key.lastIndexOf('#') + 1)];
    const info = modules.get(file);
    const decl = info?.locals.get(name);
    if (!info || !decl || decl.bodies.length !== 1) return false;
    if (decl.wrappers.length === 0) return true;
    const [wrapper] = decl.wrappers;
    return (
      decl.wrappers.length === 1 &&
      wrapper !== undefined &&
      ts.isIdentifier(wrapper) &&
      !info.declared.has(wrapper.text) &&
      info.importSpecs.get(wrapper.text) === 'react#cache'
    );
  }

  /**
   * Is `step` (an awaited call) a statement of `body` itself: the whole of an
   * expression statement or a `return`, or the initializer of a variable the
   * body declares at its top level, with nothing around it but parentheses,
   * a type assertion or a property read? Inside an `if`, a loop, a `try`, a
   * `switch`, a conditional or a logical expression it is not: a path through
   * the function could then pass it by.
   */
  function isStatementOfBody(step: ts.Node, body: ts.Node): boolean {
    if (!ts.isBlock(body)) return unwrap(body as ts.Expression) === unwrap(step as ts.Expression);
    let child: ts.Node = step;
    for (let n = step.parent; n; child = n, n = n.parent) {
      if (n === body) {
        return (
          ts.isExpressionStatement(child) ||
          ts.isReturnStatement(child) ||
          ts.isVariableStatement(child)
        );
      }
      const passesThrough =
        ts.isParenthesizedExpression(n) ||
        ts.isAsExpression(n) ||
        ts.isNonNullExpression(n) ||
        ts.isSatisfiesExpression(n) ||
        ts.isTypeAssertionExpression(n) ||
        (ts.isPropertyAccessExpression(n) && n.expression === child) ||
        (ts.isVariableDeclaration(n) && n.initializer === child) ||
        ts.isVariableDeclarationList(n) ||
        ts.isExpressionStatement(n) ||
        ts.isReturnStatement(n) ||
        ts.isVariableStatement(n);
      if (!passesThrough) return false;
    }
    return false;
  }

  /** The calls under `body` that start before `before` does, outside it and outside nested functions. */
  function callsBefore(body: ts.Node, before: ts.Node): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (n === before || isFunctionNode(n)) return;
      if (ts.isCallExpression(n) && n.getStart() < before.getStart()) out.push(n);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    return out;
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
    const allowed = [...new Set(options.besideAllowed ?? [])].sort();
    const memoKey = `${jsx ? 'jsx' : 'calls'}:${[...targets].sort().join('|')}:${allowed.join('|')}`;
    let answer = reached.get(memoKey);
    if (!answer) {
      answer = computeReach(targets, jsx, new Set(allowed));
      reached.set(memoKey, answer);
    }
    return answer;
  }

  function computeReach(
    targets: readonly string[],
    jsx: boolean,
    allowed: ReadonlySet<string>,
  ): Reach {
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
    const stepAt = (info: ModuleInfo, node: ts.Node): FirstStep => {
      const entries = ts.isAwaitExpression(node) ? promiseAllEntries(node) : null;
      return {
        refs: references(info, node, false),
        beside: (entries ?? [])
          .filter(
            (entry) =>
              startsACall(entry) &&
              !isInertEntry(info, entry) &&
              !isAllowedBeside(info, entry, allowed),
          )
          .map((entry) => {
            const callee = headCallee(entry);
            const head = callee ? resolveExpression(info, callee) : null;
            return { node: entry, head: head?.kind === 'fn' ? head.key : null };
          }),
        info,
      };
    };
    const firstSteps = new Map<string, FirstStep>();
    for (const key of fnRefs.keys()) {
      if (!reaching.has(key)) continue;
      const step = firstStepOf(key);
      if (!step || redirectIsKept(step.info, step.node, step.body)) continue;
      firstSteps.set(key, stepAt(step.info, step.node));
    }
    const asksFirst = new Set<string>();
    const asks = (k: string) => isTarget(k) || asksFirst.has(k);
    const stepAsks = (step: FirstStep) =>
      step.refs.some(asks) && step.beside.every((entry) => entry.head !== null && asks(entry.head));
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, step] of firstSteps) {
        if (asksFirst.has(key)) continue;
        if (stepAsks(step)) {
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
      asksFirstAfterInert(file, name) {
        const t = exportedNames(file).get(name);
        const key = t?.kind === 'fn' ? t.key : null;
        const found = key ? bodyOf(key) : null;
        if (!key || !found) return null;
        const { info, body } = found;
        // One plain function, or one wrapped by React's cache and nothing else:
        // any other wrapper runs code of its own around the body read here.
        if (!isPlainOrReactCached(key)) return false;
        const asking = awaitsOfCall(ts.isBlock(body) ? body.statements : [body]).find(
          (a) => !isInertEntry(info, a.expression),
        );
        if (!asking) return false;
        // The call that asks is a statement of the body itself, so every
        // statement after it is behind it on every path through the function.
        // That also rules out a `try` around it, whose catch could keep its
        // redirect; a handler attached to the call itself is read by stepAsks.
        if (!isStatementOfBody(asking, body)) return false;
        if (!stepAsks(stepAt(info, asking))) return false;
        const own = localNames(body);
        const ownFunctions = localFunctionNames(body);
        return callsBefore(body, asking).every((call) => {
          if (isInertEntry(info, call)) return true;
          // A method of a value the function holds itself: `jar.get(name)`,
          // handed nothing that runs: no function (written there, or named),
          // and no argument that starts a call.
          const callee = call.expression;
          return (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            own.has(callee.expression.text) &&
            call.arguments.every((arg) => !handsOverCode(info, arg, ownFunctions))
          );
        });
      },
      inlineActions,
      reachingCount: reaching.size,
    };
  }

  /* ───────────────────────────── writes and the gate ───────────────────────────── */

  const writeGates = new Map<string, WriteGate>();
  function writeGate(options: WriteGateOptions): WriteGate {
    const memoKey = [
      [...options.gates].sort().join('|'),
      [...options.readRpcs].sort().join('|'),
      [...(options.notWrites ?? [])].sort().join('|'),
    ].join(':');
    let answer = writeGates.get(memoKey);
    if (!answer) {
      answer = computeWriteGate(options);
      writeGates.set(memoKey, answer);
    }
    return answer;
  }

  function computeWriteGate(options: WriteGateOptions): WriteGate {
    const gateKeys = new Set(options.gates);
    const quietKeys = new Set(options.notWrites ?? []);
    const TABLE_WRITES = new Set(['insert', 'update', 'upsert', 'delete']);
    const STORAGE_WRITES = new Set(['upload', 'remove', 'move', 'copy']);
    // `.from(` of these is no query builder.
    const BUILTIN_FROM = new Set([
      'Array',
      'Object',
      'Buffer',
      'Uint8Array',
      'Set',
      'Map',
      'Promise',
      'String',
    ]);

    interface ClassRef {
      info: ModuleInfo;
      decl: ts.ClassDeclaration;
    }
    /** A function read here: its node, and the key it has when it is a module-level function or a static method. */
    interface Fn {
      node: FunctionNode;
      key: string | null;
    }
    /** A function to read, or a call of one of `gates` (and whether that gate is async). */
    type CallTarget = Fn | { gate: true; async: boolean };
    interface Verdict {
      writes: boolean;
      openWrite: ts.Node | null;
      conditional: ts.Node[];
      isGate: boolean;
    }
    interface Flow {
      write: ts.Node | null;
      /** Every path that falls through has passed this gate. */
      gate: ts.Node | null;
      /** No path falls through. */
      ends: boolean;
      /** Some path returns normally before any gate. */
      returnsOpen: boolean;
    }
    interface Event {
      write?: ts.Node;
      gate?: ts.Node;
    }
    const OPEN: Flow = { write: null, gate: null, ends: false, returnsOpen: false };

    const infoOf = (node: ts.Node) => modules.get(node.getSourceFile().fileName);

    function classOfTarget(t: Target | null): ClassRef | null {
      if (t?.kind !== 'class') return null;
      const info = modules.get(t.module);
      const decl = info?.classDecls.get(t.name);
      return info && decl ? { info, decl } : null;
    }

    function classByName(info: ModuleInfo, name: string): ClassRef | null {
      const own = classOfTarget(resolveLocal(info, name));
      if (own) return own;
      const typeBinding = info.typeImports.get(name);
      if (typeBinding?.kind === 'named') {
        return classOfTarget(resolveExport(typeBinding.module, typeBinding.name));
      }
      return null;
    }

    function classOfType(
      info: ModuleInfo,
      type: ts.TypeNode | undefined,
      depth = 0,
    ): ClassRef | null {
      if (!type || depth > 4) return null;
      if (ts.isParenthesizedTypeNode(type)) return classOfType(info, type.type, depth + 1);
      if (ts.isUnionTypeNode(type)) {
        for (const member of type.types) {
          const found = classOfType(info, member, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return null;
      const name = type.typeName.text;
      if (name === 'Promise' || name === 'Awaited') {
        return classOfType(info, type.typeArguments?.[0], depth + 1);
      }
      return classByName(info, name);
    }

    function enclosingClass(node: ts.Node): ClassRef | null {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isClassDeclaration(n)) {
          const info = infoOf(n);
          return info ? { info, decl: n } : null;
        }
        // `this` inside a function written with `function` is not the class's.
        if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return null;
      }
      return null;
    }

    function baseClass(cls: ClassRef): ClassRef | null {
      for (const clause of cls.decl.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        const base = clause.types[0]?.expression;
        if (base && ts.isIdentifier(base)) return classByName(cls.info, base.text);
      }
      return null;
    }

    function memberName(member: ts.ClassElement): string | null {
      return member.name && ts.isIdentifier(member.name) ? member.name.text : null;
    }

    /** The method (or function-valued field) `name` of a class, or of the class it extends. */
    function findMethod(cls: ClassRef | null, name: string, depth = 0): FunctionNode | null {
      if (!cls || depth > 5) return null;
      for (const member of cls.decl.members) {
        if (memberName(member) !== name) continue;
        if (ts.isMethodDeclaration(member) && member.body) return member;
        if (ts.isPropertyDeclaration(member) && member.initializer) {
          const init = unwrap(member.initializer);
          if (isFunctionNode(init)) return init;
        }
      }
      return findMethod(baseClass(cls), name, depth + 1);
    }

    /** The class a field of `cls` holds: by its annotation or a `new` initializer, a constructor parameter property included. */
    function fieldClass(cls: ClassRef | null, name: string, depth = 0): ClassRef | null {
      if (!cls || depth > 5) return null;
      for (const member of cls.decl.members) {
        if (ts.isPropertyDeclaration(member) && memberName(member) === name) {
          const byType = classOfType(cls.info, member.type);
          if (byType) return byType;
          const init = member.initializer && unwrap(member.initializer);
          if (init && ts.isNewExpression(init)) {
            return classOfTarget(resolveExpression(cls.info, init.expression));
          }
        }
        if (ts.isConstructorDeclaration(member)) {
          for (const p of member.parameters) {
            if (ts.isIdentifier(p.name) && p.name.text === name && ts.canHaveModifiers(p)) {
              if ((ts.getModifiers(p) ?? []).length > 0) return classOfType(cls.info, p.type);
            }
          }
        }
      }
      return fieldClass(baseClass(cls), name, depth + 1);
    }

    /** Does a function return an instance of `cls`: by its annotation, or a `return new Cls(...)`? */
    function returnsClass(info: ModuleInfo, fn: FunctionNode): ClassRef | null {
      const byType = classOfType(info, fn.type);
      if (byType) return byType;
      let found: ClassRef | null = null;
      const visit = (n: ts.Node) => {
        if (found || isFunctionNode(n)) return;
        if (ts.isReturnStatement(n) && n.expression) {
          const e = unwrap(n.expression);
          if (ts.isNewExpression(e)) found = classOfTarget(resolveExpression(info, e.expression));
        }
        ts.forEachChild(n, visit);
      };
      if (fn.body && ts.isBlock(fn.body)) fn.body.statements.forEach(visit);
      else if (fn.body) {
        const e = unwrap(fn.body as ts.Expression);
        if (ts.isNewExpression(e)) found = classOfTarget(resolveExpression(info, e.expression));
      }
      return found;
    }

    type LocalDecl =
      ts.ParameterDeclaration | ts.VariableDeclaration | ts.FunctionDeclaration | ts.BindingElement;

    /** The declaration of `name` in a function around `at` (parameters, and the blocks on the way out). */
    function localDeclaration(name: string, at: ts.Node): LocalDecl | null {
      const inList = (list: ts.VariableDeclarationList | undefined): LocalDecl | null => {
        for (const d of list?.declarations ?? []) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
          // `const { svc, error } = await gated()`.
          if (ts.isObjectBindingPattern(d.name)) {
            const el = d.name.elements.find((e) => ts.isIdentifier(e.name) && e.name.text === name);
            if (el) return el;
          }
        }
        return null;
      };
      for (let n: ts.Node | undefined = at.parent; n && !ts.isSourceFile(n); n = n.parent) {
        if (isFunctionNode(n) || ts.isConstructorDeclaration(n)) {
          const p = n.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === name);
          if (p) return p;
        }
        if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
          for (const st of n.statements) {
            if (ts.isVariableStatement(st)) {
              const d = inList(st.declarationList);
              if (d) return d;
            }
            if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
          }
        }
        if (
          (ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) &&
          n.initializer &&
          ts.isVariableDeclarationList(n.initializer)
        ) {
          const d = inList(n.initializer);
          if (d) return d;
        }
      }
      return null;
    }

    /** The class an expression's value is an instance of, when this reading can name it. */
    function classOfExpr(expr: ts.Expression, depth = 0): ClassRef | null {
      if (depth > 6) return null;
      const info = infoOf(expr);
      if (!info) return null;
      const e = unwrap(expr);
      if (e.kind === ts.SyntaxKind.ThisKeyword) return enclosingClass(e);
      if (ts.isNewExpression(e)) return classOfTarget(resolveExpression(info, e.expression));
      if (ts.isCallExpression(e)) {
        const callee = e.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          // `Service.forCurrentUser()`: a static method that returns its class.
          const owner = classOfTarget(resolveExpression(info, callee.expression));
          if (owner) {
            const m = findMethod(owner, callee.name.text);
            return m ? (returnsClass(owner.info, m) ?? null) : null;
          }
          const ownerClass = classOfExpr(callee.expression, depth + 1);
          const m = ownerClass ? findMethod(ownerClass, callee.name.text) : null;
          return m && ownerClass ? returnsClass(ownerClass.info, m) : null;
        }
        if (ts.isIdentifier(callee)) {
          const local = localDeclaration(callee.text, e);
          if (local && ts.isFunctionDeclaration(local)) return returnsClass(info, local);
          const t = resolveExpression(info, callee);
          if (t?.kind === 'fn') {
            for (const fn of fnsOfKey(t.key)) {
              const fi = infoOf(fn.node);
              const found = fi ? returnsClass(fi, fn.node) : null;
              if (found) return found;
            }
          }
        }
        return null;
      }
      if (ts.isIdentifier(e)) {
        const decl = localDeclaration(e.text, e);
        if (!decl || ts.isFunctionDeclaration(decl)) return null;
        if (ts.isBindingElement(decl)) return classOfBinding(decl, depth + 1);
        const byType = classOfType(info, decl.type);
        if (byType) return byType;
        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          return classOfExpr(decl.initializer, depth + 1);
        }
        return null;
      }
      if (ts.isPropertyAccessExpression(e)) {
        const owner = classOfExpr(e.expression, depth + 1);
        return owner ? fieldClass(owner, e.name.text) : null;
      }
      return null;
    }

    /** The type a property of an object type has: `{ svc: X | null }`, through Promise<...>. */
    function memberType(
      type: ts.TypeNode | undefined,
      prop: string,
      depth = 0,
    ): ts.TypeNode | undefined {
      if (!type || depth > 4) return undefined;
      if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        const n = type.typeName.text;
        return n === 'Promise' || n === 'Awaited'
          ? memberType(type.typeArguments?.[0], prop, depth + 1)
          : undefined;
      }
      if (!ts.isTypeLiteralNode(type)) return undefined;
      for (const m of type.members) {
        if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name) && m.name.text === prop)
          return m.type;
      }
      return undefined;
    }

    /** The declared return type of the function a call calls, when it is one this reading names. */
    function returnTypeOf(expr: ts.Expression): { info: ModuleInfo; type: ts.TypeNode } | null {
      const e = unwrap(expr);
      if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
      const info = infoOf(e);
      if (!info) return null;
      const local = localDeclaration(e.expression.text, e);
      const fns: FunctionNode[] =
        local && ts.isFunctionDeclaration(local)
          ? [local]
          : (() => {
              const t = resolveExpression(info, e.expression);
              return t?.kind === 'fn' ? fnsOfKey(t.key).map((f) => f.node) : [];
            })();
      for (const fn of fns) {
        const fi = infoOf(fn);
        if (fn.type && fi) return { info: fi, type: fn.type };
      }
      return null;
    }

    /** `const { svc } = <init>`: the class of `svc`, from the annotation or the initializer's declared type. */
    function classOfBinding(el: ts.BindingElement, depth: number): ClassRef | null {
      const decl = el.parent.parent;
      if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(el.propertyName ?? el.name))
        return null;
      const prop = (el.propertyName ?? el.name) as ts.Identifier;
      const info = infoOf(el);
      if (decl.type && info) return classOfType(info, memberType(decl.type, prop.text), depth);
      const typed = decl.initializer ? returnTypeOf(decl.initializer) : null;
      return typed ? classOfType(typed.info, memberType(typed.type, prop.text), depth) : null;
    }

    const fnByNode = new Map<ts.Node, Fn>();
    function fnOf(node: FunctionNode, key: string | null = null): Fn {
      let fn = fnByNode.get(node);
      if (!fn) {
        fn = { node, key };
        fnByNode.set(node, fn);
      } else if (key && !fn.key) {
        fn.key = key;
      }
      return fn;
    }

    function fnsOfKey(key: string): Fn[] {
      const [file, name] = [
        key.slice(0, key.lastIndexOf('#')),
        key.slice(key.lastIndexOf('#') + 1),
      ];
      const decl = modules.get(file)?.locals.get(name);
      return (decl?.bodies ?? []).map((b) => fnOf(b, key));
    }

    function targetsOfKey(key: string): CallTarget[] {
      if (gateKeys.has(key)) {
        return [{ gate: true, async: fnsOfKey(key).some((fn) => isAsync(fn.node)) }];
      }
      if (quietKeys.has(key)) return [];
      return fnsOfKey(key);
    }

    /** What a call calls, as far as this reading can name it. */
    function calleeTargets(call: ts.CallExpression): CallTarget[] {
      const info = infoOf(call);
      if (!info || info.isClientModule) return [];
      const callee = call.expression;
      if (ts.isIdentifier(callee)) {
        const local = localDeclaration(callee.text, call);
        if (local) {
          if (ts.isFunctionDeclaration(local) && local.body) return [fnOf(local)];
          if (ts.isVariableDeclaration(local) && local.initializer) {
            const init = unwrap(local.initializer);
            if (isFunctionNode(init)) return [fnOf(init)];
          }
          return [];
        }
        const t = resolveExpression(info, callee);
        return t?.kind === 'fn' ? targetsOfKey(t.key) : [];
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const t = resolveExpression(info, callee);
        if (t?.kind === 'fn') return targetsOfKey(t.key);
        if (callee.expression.kind === ts.SyntaxKind.SuperKeyword) {
          const own = enclosingClass(call);
          const m = own ? findMethod(baseClass(own), callee.name.text) : null;
          return m ? [fnOf(m)] : [];
        }
        const cls = classOfExpr(callee.expression);
        const m = cls ? findMethod(cls, callee.name.text) : null;
        return m ? [fnOf(m)] : [];
      }
      return [];
    }

    /** `.from(...)` somewhere down a receiver chain (or in the initializer of the local it starts from). */
    function chainHasFrom(expr: ts.Expression, depth = 0): boolean {
      if (depth > 12) return false;
      const e = unwrap(expr);
      if (ts.isCallExpression(e)) {
        const callee = e.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'from' &&
          !(ts.isIdentifier(callee.expression) && BUILTIN_FROM.has(callee.expression.text))
        ) {
          return true;
        }
        return chainHasFrom(callee, depth + 1);
      }
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
        return chainHasFrom(e.expression, depth + 1);
      }
      if (ts.isIdentifier(e)) {
        const decl = localDeclaration(e.text, e);
        return (
          !!decl &&
          ts.isVariableDeclaration(decl) &&
          !!decl.initializer &&
          chainHasFrom(decl.initializer, depth + 1)
        );
      }
      return false;
    }

    /** A property named `name` somewhere down a receiver chain. */
    function chainHasProperty(expr: ts.Expression, name: string): boolean {
      for (let e = unwrap(expr); ;) {
        if (ts.isPropertyAccessExpression(e)) {
          if (e.name.text === name) return true;
          e = unwrap(e.expression);
        } else if (ts.isCallExpression(e) || ts.isElementAccessExpression(e)) {
          e = unwrap(e.expression);
        } else return false;
      }
    }

    function underAuthAdmin(expr: ts.Expression): boolean {
      for (let e = unwrap(expr); ;) {
        if (ts.isPropertyAccessExpression(e)) {
          const owner = unwrap(e.expression);
          if (
            e.name.text === 'admin' &&
            ts.isPropertyAccessExpression(owner) &&
            owner.name.text === 'auth'
          ) {
            return true;
          }
          e = owner;
        } else if (ts.isCallExpression(e)) e = unwrap(e.expression);
        else return false;
      }
    }

    function isWritePrimitive(call: ts.CallExpression): boolean {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee)) return false;
      const m = callee.name.text;
      if (TABLE_WRITES.has(m) && chainHasFrom(callee.expression)) return true;
      if (STORAGE_WRITES.has(m) && chainHasProperty(callee.expression, 'storage')) return true;
      if (m === 'rpc') {
        const name = call.arguments[0];
        return !(name && ts.isStringLiteralLike(name) && options.readRpcs.has(name.text));
      }
      return underAuthAdmin(callee.expression) && !/^(get|list)/.test(m);
    }

    /** `<x>.mfaRequired && !<x>.mfaSatisfied`. */
    function isPolicyTest(expr: ts.Expression): boolean {
      const e = unwrap(expr);
      if (
        !ts.isBinaryExpression(e) ||
        e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return false;
      }
      const left = unwrap(e.left);
      const right = unwrap(e.right);
      if (!ts.isPropertyAccessExpression(left) || left.name.text !== 'mfaRequired') return false;
      if (!ts.isPrefixUnaryExpression(right) || right.operator !== ts.SyntaxKind.ExclamationToken) {
        return false;
      }
      const operand = unwrap(right.operand);
      return ts.isPropertyAccessExpression(operand) && operand.name.text === 'mfaSatisfied';
    }

    const isAsync = (fn: FunctionNode) => hasModifier(fn, ts.SyntaxKind.AsyncKeyword);
    /** Is a call's promise awaited (or returned) where it stands? */
    function awaitedHere(call: ts.CallExpression): boolean {
      let n: ts.Node = call;
      while (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent)) n = n.parent;
      return ts.isAwaitExpression(n.parent) || ts.isReturnStatement(n.parent);
    }

    const verdicts = new Map<ts.Node, Verdict>();
    /** A write event that is a call of (or a callback that is) a function with an open write. */
    const writeVia = new Map<ts.Node, Fn>();
    const inProgress = new Set<ts.Node>();
    const NOTHING: Verdict = { writes: false, openWrite: null, conditional: [], isGate: false };

    function verdictOf(fn: Fn): Verdict {
      const held = verdicts.get(fn.node);
      if (held) return held;
      if (inProgress.has(fn.node)) return NOTHING;
      inProgress.add(fn.node);
      const conditional: ts.Node[] = [];
      const body = fn.node.body;
      let flow: Flow = OPEN;
      if (body && ts.isBlock(body)) flow = seq(body.statements, conditional);
      else if (body) {
        const ev = expr(body, conditional, false);
        flow = ev?.write
          ? { ...OPEN, write: ev.write }
          : { write: null, gate: ev?.gate ?? null, ends: true, returnsOpen: !ev?.gate };
      }
      const verdict: Verdict = {
        writes: flow.write !== null || writesAnywhere(fn.node),
        openWrite: flow.write,
        conditional,
        isGate: flow.gate !== null && !flow.returnsOpen,
      };
      inProgress.delete(fn.node);
      verdicts.set(fn.node, verdict);
      return verdict;
    }

    const writesMemo = new Map<ts.Node, boolean>();
    const writesInProgress = new Set<ts.Node>();
    function writesAnywhere(node: FunctionNode): boolean {
      const held = writesMemo.get(node);
      if (held !== undefined) return held;
      if (writesInProgress.has(node)) return false;
      writesInProgress.add(node);
      let found = false;
      const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
          if (isWritePrimitive(n)) found = true;
          else {
            for (const t of calleeTargets(n)) {
              if (!('gate' in t) && writesAnywhere(t.node)) found = true;
            }
          }
        }
        if (!found) ts.forEachChild(n, visit);
      };
      if (node.body) visit(node.body);
      writesInProgress.delete(node);
      writesMemo.set(node, found);
      return found;
    }

    /** The first write or unconditional gate in an expression, in the order it runs; conditional gates are noted. */
    function expr(n: ts.Node, conditional: ts.Node[], cond: boolean): Event | null {
      if (isFunctionNode(n)) {
        // A callback: taken to run. A gate inside it gates nothing here.
        const callback = fnOf(n);
        if (!verdictOf(callback).openWrite) return null;
        writeVia.set(n, callback);
        return { write: n };
      }
      if (ts.isClassExpression(n)) return null;
      if (ts.isConditionalExpression(n)) {
        return (
          expr(n.condition, conditional, cond) ??
          expr(n.whenTrue, conditional, true) ??
          expr(n.whenFalse, conditional, true)
        );
      }
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
          op === ts.SyntaxKind.BarBarEqualsToken ||
          op === ts.SyntaxKind.QuestionQuestionEqualsToken
        ) {
          return expr(n.left, conditional, cond) ?? expr(n.right, conditional, true);
        }
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression;
        let ev: Event | null = null;
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          ev = expr(callee.expression, conditional, cond);
        } else if (!ts.isIdentifier(callee)) {
          ev = expr(callee, conditional, cond);
        }
        if (ev) return ev;
        for (const arg of n.arguments ?? []) {
          ev = expr(arg, conditional, cond);
          if (ev) return ev;
        }
        if (!ts.isCallExpression(n)) return null;
        if (isWritePrimitive(n)) return { write: n };
        const optional = !!n.questionDotToken || ts.isOptionalChain(callee);
        for (const t of calleeTargets(n)) {
          if ('gate' in t) {
            if (t.async && !awaitedHere(n)) {
              conditional.push(n);
              continue;
            }
          } else {
            const v = verdictOf(t);
            if (v.openWrite) {
              writeVia.set(n, t);
              return { write: n };
            }
            if (!v.isGate) continue;
            if (isAsync(t.node) && !awaitedHere(n)) {
              conditional.push(n);
              continue;
            }
          }
          if (cond || optional) conditional.push(n);
          else return { gate: n };
        }
        return null;
      }
      let found: Event | null = null;
      ts.forEachChild(n, (c) => {
        found = expr(c, conditional, cond);
        return found ?? undefined;
      });
      return found;
    }

    const fromEvent = (ev: Event | null): Flow =>
      ev ? { ...OPEN, write: ev.write ?? null, gate: ev.gate ?? null } : OPEN;

    function seq(statements: readonly ts.Statement[], conditional: ts.Node[]): Flow {
      let returnsOpen = false;
      for (const st of statements) {
        const r = stmt(st, conditional);
        if (r.write) return { ...r, returnsOpen: returnsOpen || r.returnsOpen };
        returnsOpen ||= r.returnsOpen;
        if (r.gate) return { write: null, gate: r.gate, ends: r.ends, returnsOpen };
        if (r.ends) return { write: null, gate: null, ends: true, returnsOpen };
      }
      return { ...OPEN, returnsOpen };
    }

    /** A branch, loop body or clause whose gate does not hold what follows: noted, never counted. */
    function onlyOnSomePaths(r: Flow, conditional: ts.Node[]): Flow {
      if (r.write) return r;
      if (r.gate) conditional.push(r.gate);
      return { ...OPEN, returnsOpen: r.returnsOpen };
    }

    function stmt(s: ts.Statement, conditional: ts.Node[]): Flow {
      if (ts.isBlock(s)) return seq(s.statements, conditional);
      if (ts.isExpressionStatement(s)) return fromEvent(expr(s.expression, conditional, false));
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          const ev = d.initializer ? expr(d.initializer, conditional, false) : null;
          if (ev) return fromEvent(ev);
        }
        return OPEN;
      }
      if (ts.isReturnStatement(s)) {
        const ev = s.expression ? expr(s.expression, conditional, false) : null;
        if (ev?.write) return fromEvent(ev);
        if (ev?.gate) return { write: null, gate: ev.gate, ends: true, returnsOpen: false };
        return { write: null, gate: null, ends: true, returnsOpen: true };
      }
      if (ts.isThrowStatement(s)) {
        const ev = expr(s.expression, conditional, false);
        if (ev?.write) return fromEvent(ev);
        return { write: null, gate: null, ends: true, returnsOpen: false };
      }
      if (ts.isIfStatement(s)) {
        if (!s.elseStatement && isPolicyTest(s.expression)) {
          const t = stmt(s.thenStatement, conditional);
          if (t.write) return t;
          if (t.ends || t.gate)
            return { write: null, gate: s, ends: false, returnsOpen: t.returnsOpen };
        }
        const c = expr(s.expression, conditional, false);
        if (c) return fromEvent(c);
        const t = stmt(s.thenStatement, conditional);
        if (t.write) return t;
        const e = s.elseStatement ? stmt(s.elseStatement, conditional) : OPEN;
        if (e.write) return e;
        const returnsOpen = t.returnsOpen || e.returnsOpen;
        if (t.ends && e.ends) return { write: null, gate: null, ends: true, returnsOpen };
        if ((t.gate || t.ends) && (e.gate || e.ends)) {
          return { write: null, gate: t.gate ?? e.gate, ends: false, returnsOpen };
        }
        for (const g of [t.gate, e.gate]) if (g) conditional.push(g);
        return { ...OPEN, returnsOpen };
      }
      if (ts.isTryStatement(s)) {
        const t = seq(s.tryBlock.statements, conditional);
        if (t.write) return t;
        const c = s.catchClause ? seq(s.catchClause.block.statements, conditional) : null;
        if (c?.write) return c;
        const f = s.finallyBlock ? seq(s.finallyBlock.statements, conditional) : null;
        if (f?.write) return f;
        const returnsOpen = t.returnsOpen || !!c?.returnsOpen || !!f?.returnsOpen;
        if (f?.gate) return { write: null, gate: f.gate, ends: false, returnsOpen };
        if (t.gate) {
          if (!c || c.ends) return { write: null, gate: t.gate, ends: false, returnsOpen };
          conditional.push(t.gate);
          return { ...OPEN, returnsOpen };
        }
        if (t.ends && (!c || c.ends)) return { write: null, gate: null, ends: true, returnsOpen };
        return { ...OPEN, returnsOpen };
      }
      if (ts.isDoStatement(s)) {
        const b = stmt(s.statement, conditional);
        if (b.write || b.gate || b.ends) return b;
        return fromEvent(expr(s.expression, conditional, false));
      }
      if (ts.isForStatement(s)) {
        const init = s.initializer;
        const head =
          (init && ts.isVariableDeclarationList(init)
            ? init.declarations.reduce<Event | null>(
                (ev, d) => ev ?? (d.initializer ? expr(d.initializer, conditional, false) : null),
                null,
              )
            : init
              ? expr(init, conditional, false)
              : null) ?? (s.condition ? expr(s.condition, conditional, false) : null);
        if (head?.write) return fromEvent(head);
        return onlyOnSomePaths(stmt(s.statement, conditional), conditional);
      }
      if (ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s)) {
        const head = expr(s.expression, conditional, false);
        if (head?.write) return fromEvent(head);
        return onlyOnSomePaths(stmt(s.statement, conditional), conditional);
      }
      if (ts.isSwitchStatement(s)) {
        const head = expr(s.expression, conditional, false);
        if (head?.write) return fromEvent(head);
        let returnsOpen = false;
        for (const clause of s.caseBlock.clauses) {
          const label = ts.isCaseClause(clause) ? expr(clause.expression, conditional, true) : null;
          if (label?.write) return fromEvent(label);
          const r = onlyOnSomePaths(seq(clause.statements, conditional), conditional);
          if (r.write) return r;
          returnsOpen ||= r.returnsOpen;
        }
        return { ...OPEN, returnsOpen };
      }
      if (ts.isLabeledStatement(s)) return stmt(s.statement, conditional);
      if (
        ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isEmptyStatement(s)
      ) {
        return OPEN;
      }
      return fromEvent(expr(s, conditional, false));
    }

    const where = (node: ts.Node) => {
      const sf = node.getSourceFile();
      return {
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        text: squash(node.getText(sf)),
      };
    };
    const chainFrom = (start: ts.Node): string[] => {
      const out: string[] = [];
      const seen = new Set<ts.Node>();
      for (let node: ts.Node | null = start; node && !seen.has(node) && out.length < 12;) {
        seen.add(node);
        const at = where(node);
        out.push(
          `${path.relative(srcRoot, node.getSourceFile().fileName).split(path.sep).join('/')}:${at.line} ${at.text}`,
        );
        const via = writeVia.get(node);
        node = via ? verdictOf(via).openWrite : null;
      }
      return out;
    };
    const publicVerdict = (vs: Verdict[]): WriteVerdict => {
      const open = vs.find((v) => v.openWrite)?.openWrite ?? null;
      return {
        writeChain: open ? chainFrom(open) : [],
        writes: vs.some((v) => v.writes),
        openWrite: open ? where(open) : null,
        conditionalGates: open ? vs.flatMap((v) => v.conditional).map(where) : [],
        isGate: vs.length > 0 && vs.every((v) => v.isGate),
      };
    };

    return {
      exportVerdict(file, name) {
        const t = exportedNames(file).get(name);
        if (t?.kind !== 'fn') return null;
        const fns = fnsOfKey(t.key);
        if (fns.length === 0) return null;
        return publicVerdict(fns.map(verdictOf));
      },
      methodVerdict(file, className, method) {
        const info = modules.get(file);
        const decl = info?.classDecls.get(className);
        const m = info && decl ? findMethod({ info, decl }, method) : null;
        return m ? publicVerdict([verdictOf(fnOf(m))]) : null;
      },
      publicMethods(file) {
        const info = modules.get(file);
        if (!info) return [];
        const exportedClasses = new Set(
          [...exportedNames(file).values()].flatMap((t) =>
            t?.kind === 'class' && t.module === file ? [t.name] : [],
          ),
        );
        const out: Array<{ className: string; method: string; isStatic: boolean }> = [];
        for (const [className, decl] of info.classDecls) {
          if (!exportedClasses.has(className)) continue;
          for (const member of decl.members) {
            const name = memberName(member);
            if (!name) continue;
            const isMethod = ts.isMethodDeclaration(member) && !!member.body;
            const isField =
              ts.isPropertyDeclaration(member) &&
              !!member.initializer &&
              isFunctionNode(unwrap(member.initializer));
            if (!isMethod && !isField) continue;
            if (
              hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
              hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
            ) {
              continue;
            }
            out.push({
              className,
              method: name,
              isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
            });
          }
        }
        return out.sort((a, b) =>
          `${a.className}.${a.method}`.localeCompare(`${b.className}.${b.method}`),
        );
      },
    };
  }

  return {
    writeGate,
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
