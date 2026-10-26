import * as path from 'node:path';

import ts from 'typescript';

/**
 * Finds a busy flag that is cleared only when a request resolves (B40). Used
 * by `src/test/pending-flag.guard.test.ts`.
 *
 * THE BUG. Items > Save view set `saving`, awaited createSavedViewAction with
 * no catch, and cleared `saving` on the next line. A Server Action call
 * REJECTS (rather than resolving with an ActionResult) when the browser is
 * offline, when the connection drops, when the server fails before the action
 * can answer and when a deploy no longer has the action; the phone's api()
 * rejects on every answer that is not 2xx. The line that cleared the flag was
 * never reached, so the spinner stayed on and nothing was said.
 *
 * WHAT IS A FLAG. A React state setter (`const [busy, setBusy] = useState`)
 * whose name says work is in flight (FLAG_NAME: setBusy, setSaving,
 * setArchiveBusy, setSavingId, setMovementsLoadingMore, ...), set to `true`, a
 * string or an id, and later to `false`, `null`, `undefined`, `''` or `0`; a
 * setter of any name set to a busy word ('saving', { kind: 'loading' }) and
 * later to anything else (a phase); and a ref of a busy name set
 * `current = true` and later `current = false`.
 *
 * WHAT CAN REJECT. A call to a Server Action (imported from a `'use server'`
 * module), `fetch`, and any function whose body can reject: it throws, or
 * awaits or returns a call that can reject, outside a try block that has a
 * catch. Followed across modules by import and, inside a component, to the
 * functions declared there (`const load = useCallback(async () => ...)`).
 * Not followed: methods of objects (a Supabase query, which answers
 * `{ error }` instead of rejecting), functions passed in as props, and values
 * in variables. Those are judged by hand.
 *
 * WHAT IS REPORTED. Inside one function, between the call that sets a flag and
 * a later call that clears it: an `await` of something that can reject, a
 * `throw`, or a `.then(...)` chain on something that can reject whose
 * rejection nothing handles. Each is fine when a `try` around it clears the
 * flag in `finally`, or has a catch that clears it, or has a catch that falls
 * through to the clearing call after the `try` (no return or throw in the
 * catch except `if (isControlFlow(e)) return;`, which keeps the flag while
 * the router navigates to sign-in). A `.then` chain is fine when its
 * `.catch`, second `.then` handler or `.finally` clears the flag.
 *
 * Parsed with the TypeScript compiler, not a regex: comments and strings never
 * count, and a call split over several lines is still one call.
 */

export interface ScanFile {
  /** Absolute path. */
  path: string;
  text: string;
}

/** Where `@/...` points for the files under `prefix`. */
export interface ScanRoot {
  /** Absolute directory prefix of the files this root covers (ends with a separator). */
  prefix: string;
  /** Absolute directory `@/` resolves to. */
  srcRoot: string;
}

export interface PendingFlagFinding {
  file: string;
  /** Line of the await, throw or `.then` that can leave the flag set. */
  line: number;
  /** The enclosing function, or '(anonymous)'. */
  fn: string;
  /** The setter (or `ref.current`) that stays set. */
  flag: string;
  setLine: number;
  clearLine: number;
  kind: 'await' | 'then' | 'throw';
  /** What can reject: the action, `fetch`, or the function that reaches them. */
  reaches: string;
  /**
   * 'stays-set': nothing clears the flag when the call rejects (the spinner
   * stays on). 'says-nothing': a `finally` clears it, but no catch on the way
   * out of the handler handles the rejection, so the person is told nothing.
   */
  problem: 'stays-set' | 'says-nothing';
}

export interface PendingFlagScan {
  findings: PendingFlagFinding[];
  /** Flag windows around something that can reject, cleared on every path. */
  guarded: number;
  /** Keys (`<file>#<line>:<name>`) of every function found able to reject. */
  rejecting: ReadonlySet<string>;
}

/**
 * The state names (after `set`) that say work is in flight. Anchored at the
 * end, with an optional qualifier: setBusy, setArchiveBusy, setBusyLine,
 * setSavingId, setMovementsLoadingMore, setTogglingWarehouseId. A name that
 * only starts with a busy word holds data (setPendingItem, setPendingEmail).
 */
const BUSY_WORDS =
  'Busy|Pending|InFlight|Loading|Saving|Submitting|Refreshing|Working|Sending|Resending|' +
  'Deleting|Archiving|Restoring|Posting|Uploading|Creating|Updating|Checking|Running|' +
  'Processing|Placing|Applying|Importing|Exporting|Previewing|Approving|Resolving|Fetching|' +
  'Signing|Verifying|Generating|Scanning|Syncing|Reverting|Removing|Adding|Moving|Sharing|' +
  'Toggling|Completing|Lowering|Rotating|Revoking|Reviewing|Duplicating|Mutating|Retrying|' +
  'Unlinking|Opening|Parsing|Extracting|Building|Buying|Acting|Hydrating|Pulling|Picking|' +
  'LookingUp|Searching|Downloading|Printing|Connecting|Disconnecting|Testing|Assigning|' +
  'Cancelling|Canceling|Confirming|Starting|Closing|Sending|Inviting|Linking|Publishing';
const FLAG_NAME = new RegExp(
  `(?:${BUSY_WORDS})(?:Id|Ids|Key|Keys|Line|More|Section|Toggle|Blurb|Part|Workspace|Images|Rates|WarehouseId)?$`,
);
/** A ref of a busy name: busyRef, savingRef, inFlight, submittingRef. */
const REF_NAME = new RegExp(`(?:${BUSY_WORDS})(?:Ref)?$`, 'i');
/** A phase value that says work is in flight: 'saving', { kind: 'loading' }. */
const BUSY_VALUE = new RegExp(`^(?:${BUSY_WORDS})$`, 'i');

type FunctionNode =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface ModuleInfo {
  file: string;
  sf: ts.SourceFile;
  isActionModule: boolean;
  /** Local name -> imported binding. */
  imports: Map<string, { module: string; name: string } | { module: string; namespace: true }>;
  /** Exported name -> the top-level declaration's local name. */
  exportsLocal: Map<string, string>;
  reexports: Array<{ module: string; names: Map<string, string> | null }>;
  /** Top-level function-valued declarations by local name, and class statics as `Class.method`. */
  topLevel: Map<string, FunctionNode>;
  classes: Set<string>;
}

type Callee =
  | { kind: 'action'; name: string }
  | { kind: 'fetch' }
  | { kind: 'fn'; name: string; node: FunctionNode; info: ModuleInfo };

function isFunctionNode(n: ts.Node): n is FunctionNode {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
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

/** The function a declaration's initializer holds: `async () => {}`, `useCallback(fn, deps)`. */
function functionOf(init: ts.Expression | undefined): FunctionNode | null {
  if (!init) return null;
  const e = unwrap(init);
  if (isFunctionNode(e)) return e;
  if (ts.isCallExpression(e)) {
    const callee = e.expression.getText();
    if (/(^|\.)(useCallback|useEvent|useEffectEvent)$/.test(callee)) {
      const first = e.arguments[0] ? unwrap(e.arguments[0]) : undefined;
      if (first && isFunctionNode(first)) return first;
    }
  }
  return null;
}

function functionName(fn: FunctionNode): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  let p: ts.Node = fn.parent;
  if (ts.isCallExpression(p)) {
    const callee = p.expression.getText();
    // `useCallback(fn)` takes the variable's name; any other call names its callback.
    if (!/(^|\.)(useCallback|useEvent|useEffectEvent)$/.test(callee)) return `(${callee} callback)`;
    p = p.parent;
  }
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) return `(${p.parent.name.getText()})`;
  return '(anonymous)';
}

export function scanPendingFlags(files: ScanFile[], roots: ScanRoot[]): PendingFlagScan {
  const byPath = new Set(files.map((f) => f.path));

  function resolveSpec(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) {
      const root = roots.find((r) => fromFile.startsWith(r.prefix));
      if (!root) return null;
      base = path.join(root.srcRoot, spec.slice(2));
    } else if (spec.startsWith('.')) {
      base = path.resolve(path.dirname(fromFile), spec);
    } else {
      return null;
    }
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
    const info: ModuleInfo = {
      file: file.path,
      sf,
      isActionModule: prologue(sf.statements).includes('use server'),
      imports: new Map(),
      exportsLocal: new Map(),
      reexports: [],
      topLevel: new Map(),
      classes: new Set(),
    };
    for (const st of sf.statements) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const resolved = resolveSpec(file.path, st.moduleSpecifier.text);
        if (!resolved) continue;
        if (clause.name) info.imports.set(clause.name.text, { module: resolved, name: 'default' });
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          info.imports.set(nb.name.text, { module: resolved, namespace: true });
        }
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            info.imports.set(el.name.text, {
              module: resolved,
              name: (el.propertyName ?? el.name).text,
            });
          }
        }
      } else if (ts.isFunctionDeclaration(st) && st.body) {
        const name = st.name?.text ?? (isDefault ? 'default' : null);
        if (!name) continue;
        info.topLevel.set(name, st);
        if (exported) info.exportsLocal.set(isDefault ? 'default' : name, name);
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const fn = functionOf(decl.initializer);
          if (fn) info.topLevel.set(decl.name.text, fn);
          if (exported) info.exportsLocal.set(decl.name.text, decl.name.text);
        }
      } else if (ts.isClassDeclaration(st) && st.name) {
        const cls = st.name.text;
        info.classes.add(cls);
        if (exported) info.exportsLocal.set(isDefault ? 'default' : cls, cls);
        for (const member of st.members) {
          if (!hasModifier(member, ts.SyntaxKind.StaticKeyword) || !member.name) continue;
          if (!ts.isIdentifier(member.name)) continue;
          if (ts.isMethodDeclaration(member) && member.body) {
            info.topLevel.set(`${cls}.${member.name.text}`, member);
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
          else for (const [name, local] of names) info.exportsLocal.set(name, local);
        }
      }
    }
    modules.set(file.path, info);
  }

  /* ───────────────────────────── name resolution ───────────────────────────── */

  function resolveExport(module: string, name: string, seen = new Set<string>()): Callee | null {
    const marker = `${module}#${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const info = modules.get(module);
    if (!info) return null;
    if (info.isActionModule) return { kind: 'action', name };
    const local = info.exportsLocal.get(name);
    if (local !== undefined) {
      const fn = info.topLevel.get(local);
      if (fn) return { kind: 'fn', name, node: fn, info };
      const binding = info.imports.get(local);
      if (binding && !('namespace' in binding)) {
        return resolveExport(binding.module, binding.name, seen);
      }
      return null;
    }
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

  /** The declaration `name` refers to at `at`: the nearest enclosing scope, then the module. */
  function resolveIdentifier(info: ModuleInfo, name: string, at: ts.Node): Callee | null {
    for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
      const statements = ts.isBlock(scope)
        ? scope.statements
        : ts.isSourceFile(scope)
          ? scope.statements
          : null;
      if (!statements) continue;
      for (const st of statements) {
        if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) {
          return { kind: 'fn', name, node: st, info };
        }
        if (ts.isVariableStatement(st)) {
          for (const decl of st.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === name) {
              const fn = functionOf(decl.initializer);
              return fn ? { kind: 'fn', name, node: fn, info } : null;
            }
          }
        }
      }
      if (ts.isSourceFile(scope)) break;
    }
    const binding = info.imports.get(name);
    if (!binding || 'namespace' in binding) return null;
    return resolveExport(binding.module, binding.name);
  }

  function resolveCallee(info: ModuleInfo, call: ts.CallExpression): Callee | null {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'fetch') return { kind: 'fetch' };
      return resolveIdentifier(info, callee.text, call);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const owner = unwrap(callee.expression);
      const method = callee.name.text;
      if (
        method === 'fetch' &&
        ts.isIdentifier(owner) &&
        (owner.text === 'window' || owner.text === 'globalThis')
      ) {
        return { kind: 'fetch' };
      }
      if (ts.isIdentifier(owner)) {
        const binding = info.imports.get(owner.text);
        if (binding && 'namespace' in binding) return resolveExport(binding.module, method);
        // A class's static method: `ThingsService.forCurrentUser()`.
        const local = info.topLevel.get(`${owner.text}.${method}`);
        if (local) return { kind: 'fn', name: `${owner.text}.${method}`, node: local, info };
        if (binding) {
          const target = modules.get(binding.module);
          const cls = target?.exportsLocal.get(binding.name);
          const fn = cls ? target?.topLevel.get(`${cls}.${method}`) : undefined;
          if (fn && target)
            return { kind: 'fn', name: `${owner.text}.${method}`, node: fn, info: target };
        }
      }
    }
    return null;
  }

  /* ───────────────────────────── what can reject ───────────────────────────── */

  const rejectMemo = new Map<FunctionNode, string | null>();
  const rejecting = new Set<string>();

  function keyOf(info: ModuleInfo, fn: FunctionNode): string {
    const line = info.sf.getLineAndCharacterOfPosition(fn.getStart(info.sf)).line + 1;
    return `${info.file}#${line}:${functionName(fn)}`;
  }

  /** Why calling `fn` can reject, or null. */
  function fnRejects(info: ModuleInfo, fn: FunctionNode): string | null {
    if (rejectMemo.has(fn)) return rejectMemo.get(fn) ?? null;
    rejectMemo.set(fn, null); // a cycle answers "no" while it is being worked out
    const why = bodyRejects(info, fn);
    rejectMemo.set(fn, why);
    if (why) rejecting.add(keyOf(info, fn));
    return why;
  }

  /** What a call can reject from (its name), or null when it cannot. */
  function callRejects(info: ModuleInfo, call: ts.CallExpression): string | null {
    const callee = unwrap(call.expression);
    // A promise chain: rejects when its head does and nothing handles it.
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === 'catch' || (method === 'then' && call.arguments.length >= 2)) return null;
      if (method === 'then' || method === 'finally') {
        const head = unwrap(callee.expression);
        return ts.isCallExpression(head) ? callRejects(info, head) : null;
      }
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise') {
        if (method === 'allSettled' || method === 'resolve') return null;
        if (method === 'reject') return 'Promise.reject';
        const arg = call.arguments[0];
        return arg ? anyCallRejects(info, arg) : null;
      }
    }
    const target = resolveCallee(info, call);
    if (!target) return null;
    if (target.kind === 'action') return target.name;
    if (target.kind === 'fetch') return 'fetch';
    return fnRejects(target.info, target.node) ? target.name : null;
  }

  /** Any call under `node`, callbacks included, that can reject (for Promise.all's array). */
  function anyCallRejects(info: ModuleInfo, node: ts.Node): string | null {
    let found: string | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        found = callRejects(info, n);
        if (found) return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }

  function bodyRejects(info: ModuleInfo, fn: FunctionNode): string | null {
    const body = fn.body;
    if (!body) return null;
    // `() => action()`: the expression is the promise.
    if (!ts.isBlock(body)) {
      const e = unwrap(ts.isAwaitExpression(body) ? body.expression : body);
      return ts.isCallExpression(e) ? callRejects(info, e) : null;
    }
    let why: string | null = null;
    const visit = (n: ts.Node, caught: boolean) => {
      if (why) return;
      if (n !== fn && isFunctionNode(n)) return;
      if (ts.isTryStatement(n)) {
        visit(n.tryBlock, caught || !!n.catchClause);
        if (n.catchClause) visit(n.catchClause.block, caught);
        if (n.finallyBlock) visit(n.finallyBlock, caught);
        return;
      }
      if (!caught) {
        if (ts.isThrowStatement(n)) {
          why = 'throw';
          return;
        }
        if (ts.isAwaitExpression(n) || ts.isReturnStatement(n)) {
          const e = n.expression ? unwrap(n.expression) : undefined;
          const inner = e && ts.isAwaitExpression(e) ? unwrap(e.expression) : e;
          if (inner && ts.isCallExpression(inner)) {
            const r = callRejects(info, inner);
            if (r) {
              why = r;
              return;
            }
          }
        }
      }
      ts.forEachChild(n, (c) => visit(c, caught));
    };
    visit(body, false);
    return why;
  }

  /* ───────────────────────────── the flag windows ───────────────────────────── */

  const findings: PendingFlagFinding[] = [];
  /** `<file>:<line>:<flag>` of every finding, so a window is reported once. */
  const reported = new Set<string>();
  let guarded = 0;

  type SetKind = 'start' | 'end' | 'phase-start' | 'other';

  interface SetEvent {
    flag: string;
    pos: number;
    node: ts.Node;
    kind: SetKind;
  }
  interface RiskEvent {
    pos: number;
    node: ts.Node;
    kind: 'await' | 'then' | 'throw';
    reaches: string;
    /** For `.then`: the chain's fulfilment and rejection handlers. */
    chain?: { fulfilled: ts.Node[]; handlers: ts.Node[]; catches: ts.Node[] };
  }

  const isFalsy = (e: ts.Expression): boolean => {
    const v = unwrap(e);
    return (
      v.kind === ts.SyntaxKind.FalseKeyword ||
      v.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(v) && v.text === 'undefined') ||
      ((ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && v.text === '') ||
      (ts.isNumericLiteral(v) && v.text === '0')
    );
  };
  const isBusyValue = (e: ts.Expression): boolean => {
    const v = unwrap(e);
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
      return BUSY_VALUE.test(v.text);
    }
    if (ts.isObjectLiteralExpression(v)) {
      return v.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          (ts.isStringLiteral(p.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(p.initializer)) &&
          BUSY_VALUE.test(p.initializer.text),
      );
    }
    return false;
  };

  for (const info of modules.values()) {
    if (info.isActionModule) continue;
    const sf = info.sf;
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    // Every useState setter declared in this file.
    const setters = new Set<string>();
    const findSetters = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isArrayBindingPattern(n.name) &&
        n.initializer &&
        ts.isCallExpression(unwrap(n.initializer)) &&
        /(^|\.)useState$/.test((unwrap(n.initializer) as ts.CallExpression).expression.getText(sf))
      ) {
        const el = n.name.elements[1];
        if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) setters.add(el.name.text);
      }
      ts.forEachChild(n, findSetters);
    };
    findSetters(sf);

    const classifySet = (flag: string, arg: ts.Expression | undefined): SetKind => {
      if (!arg) return 'other';
      if (isBusyValue(arg)) return 'phase-start';
      const v = unwrap(arg);
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return 'other';
      if (isFalsy(v)) return 'end';
      return FLAG_NAME.test(flag.replace(/^set/, '')) ? 'start' : 'other';
    };

    /** The flag sets and the risks in `fn`'s own body (not in functions nested in it). */
    const collect = (fn: FunctionNode): { sets: SetEvent[]; risks: RiskEvent[] } => {
      const sets: SetEvent[] = [];
      const risks: RiskEvent[] = [];
      const walk = (n: ts.Node) => {
        if (n !== fn && isFunctionNode(n)) return;
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          if (ts.isIdentifier(callee) && setters.has(callee.text)) {
            sets.push({
              flag: callee.text,
              pos: n.getStart(sf),
              node: n,
              kind: classifySet(callee.text, n.arguments[0]),
            });
          }
          // A promise chain with a `.then(...)` that is not awaited (an awaited
          // one is judged as an await), judged once from its last link.
          if (
            ts.isPropertyAccessExpression(callee) &&
            ['then', 'catch', 'finally'].includes(callee.name.text) &&
            !isInsideChainOf(n) &&
            !ts.isAwaitExpression(parentSkippingParens(n))
          ) {
            const chain = chainOf(n);
            const r = chain.fulfilled.length && chain.head ? callRejects(info, chain.head) : null;
            if (r) risks.push({ pos: n.getStart(sf), node: n, kind: 'then', reaches: r, chain });
          }
        }
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) &&
          n.left.name.text === 'current' &&
          REF_NAME.test(n.left.expression.getText(sf))
        ) {
          const v = unwrap(n.right);
          const kind: SetKind =
            v.kind === ts.SyntaxKind.TrueKeyword
              ? 'start'
              : v.kind === ts.SyntaxKind.FalseKeyword
                ? 'end'
                : 'other';
          sets.push({ flag: n.left.getText(sf), pos: n.getStart(sf), node: n, kind });
        }
        if (ts.isAwaitExpression(n)) {
          const e = unwrap(n.expression);
          const r = ts.isCallExpression(e) ? callRejects(info, e) : null;
          if (r) risks.push({ pos: n.getStart(sf), node: n, kind: 'await', reaches: r });
        }
        if (ts.isThrowStatement(n)) {
          risks.push({ pos: n.getStart(sf), node: n, kind: 'throw', reaches: 'throw' });
        }
        ts.forEachChild(n, walk);
      };
      if (fn.body) walk(fn.body);
      return { sets, risks };
    };

    /**
     * Judges one window: `start` set the flag, `risk` (in `owner`, whose own
     * sets of the flag are `mine`) can reject, and a later set clears the
     * flag. Returns true when it reported a finding.
     */
    const judge = (
      owner: FunctionNode,
      flag: string,
      start: SetEvent,
      risk: RiskEvent,
      mine: SetEvent[],
    ): boolean => {
      let end: ts.Node | null = null;
      if (risk.kind === 'then') {
        end = risk.chain?.fulfilled.some((h) => callsFlag(h, flag)) ? risk.node : null;
      } else {
        const after = mine.find(
          (s) => s.pos > risk.pos && (start.kind === 'phase-start' || s.kind === 'end'),
        );
        end = after ? after.node : null;
      }
      if (!end) return false;
      const ok =
        risk.kind === 'then'
          ? (risk.chain?.handlers.some((h) => callsFlag(h, flag)) ?? false)
          : protectedByTry(risk.node, owner, flag);
      let problem: PendingFlagFinding['problem'] = 'stays-set';
      if (ok) {
        // The flag is cleared on every path. Is the rejection handled, or does
        // it leave the handler with nothing said?
        const handled =
          risk.kind === 'then'
            ? (risk.chain?.catches.length ?? 0) > 0
            : caughtWithin(risk.node, owner) || callersCatch(owner);
        if (handled) {
          guarded++;
          return false;
        }
        problem = 'says-nothing';
      }
      const key = `${info.file}:${line(risk.node)}:${flag}`;
      if (!reported.has(key)) {
        reported.add(key);
        findings.push({
          file: info.file,
          line: line(risk.node),
          fn: functionName(owner),
          flag,
          setLine: line(start.node),
          clearLine: line(end),
          kind: risk.kind,
          reaches: risk.reaches,
          problem,
        });
      }
      return true;
    };

    /**
     * True unless a rejection that leaves `fn` is known to reach no handler.
     * Judged only where every caller is in this module: `fn` is an inline
     * callback (a JSX handler, an effect), or a function of this module whose
     * every use is here. A use that passes it on (`onClick={save}`,
     * `onConfirm={save}`) reaches React or a child that does not catch; a call
     * counts as caught inside a try with a catch or ahead of `.catch(...)`.
     * An exported function, or one handed out by a hook, is not judged.
     */
    function callersCatch(fn: FunctionNode): boolean {
      const name = declaredName(fn);
      if (!name) return false; // an inline callback: whoever calls it is React or a child
      const decl = declarationOf(fn);
      if (decl && hasModifier(decl, ts.SyntaxKind.ExportKeyword)) return true;
      const uses: ts.Identifier[] = [];
      const findUses = (n: ts.Node) => {
        if (ts.isIdentifier(n) && n.text === name && !isDeclarationName(n)) uses.push(n);
        ts.forEachChild(n, findUses);
      };
      findUses(sf);
      if (!uses.length) return true;
      for (const use of uses) {
        const p = parentSkippingParens(use);
        // Handed out (`return { save }`, `return save`): its callers are elsewhere.
        if (ts.isShorthandPropertyAssignment(p) || ts.isReturnStatement(p)) return true;
        if (ts.isPropertyAssignment(p) && !ts.isJsxAttribute(p.parent) && isReturnedObject(p)) {
          return true;
        }
        if (ts.isCallExpression(p) && p.expression === use) {
          if (callIsCaught(p)) continue;
          return false;
        }
        // Dependency arrays and other references that do not call it.
        if (ts.isArrayLiteralExpression(p)) continue;
        return false; // passed on as a value: a handler prop, a callback
      }
      return true;
    }

    const isStart = (s: SetEvent) => s.kind === 'start' || s.kind === 'phase-start';

    const visitFunction = (fn: FunctionNode) => {
      const body = fn.body;
      if (!body || !ts.isBlock(body)) return;
      const { sets, risks } = collect(fn);

      const flags = new Set(sets.filter((s) => s.kind !== 'other').map((s) => s.flag));
      for (const flag of flags) {
        const mine = sets.filter((s) => s.flag === flag);
        for (const risk of risks) {
          const start = [...mine].reverse().find((s) => s.pos < risk.pos && isStart(s));
          if (!start) continue;
          // A flag already cleared again before the risk is not in flight.
          const reset = mine.find((s) => s.pos > start.pos && s.pos < risk.pos && s.kind === 'end');
          if (reset) continue;
          if (judge(fn, flag, start, risk, mine)) break; // one report per flag and function
        }
      }

      // A callback created while the flag is set (a timer, an effect's async
      // load, a .then handler) that awaits something that can reject and then
      // clears the flag: the Distribute preview set `previewing` in its effect
      // and cleared it in the timer after the action answered.
      const starts = sets.filter(isStart);
      if (!starts.length) return;
      const nested: FunctionNode[] = [];
      const findNested = (n: ts.Node) => {
        if (n !== fn && isFunctionNode(n)) nested.push(n);
        ts.forEachChild(n, findNested);
      };
      findNested(body);
      for (const inner of nested) {
        const at = inner.getStart(sf);
        const got = collect(inner);
        if (!got.risks.length) continue;
        for (const flag of new Set(starts.map((s) => s.flag))) {
          const mine = sets.filter((s) => s.flag === flag);
          const start = [...mine].reverse().find((s) => s.pos < at && isStart(s));
          if (!start) continue;
          if (mine.some((s) => s.pos > start.pos && s.pos < at && s.kind === 'end')) continue;
          const innerSets = got.sets.filter((s) => s.flag === flag);
          for (const risk of got.risks) {
            // A callback that sets the flag itself before the risk owns that
            // window; it is judged when the callback is visited.
            if (innerSets.some((s) => s.pos < risk.pos && s.kind !== 'other')) continue;
            if (judge(inner, flag, start, risk, innerSets)) break;
          }
        }
      }
    };

    const visit = (n: ts.Node) => {
      if (isFunctionNode(n)) visitFunction(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  return { findings, guarded, rejecting };
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** True when `call` is the receiver of a further `.then/.catch/.finally` (judged from the top). */
function isInsideChainOf(call: ts.CallExpression): boolean {
  const p = call.parent;
  return (
    ts.isPropertyAccessExpression(p) &&
    ['then', 'catch', 'finally'].includes(p.name.text) &&
    ts.isCallExpression(p.parent) &&
    p.parent.expression === p
  );
}

/** The parent of `node`, past any parentheses. */
function parentSkippingParens(node: ts.Node): ts.Node {
  let p = node.parent;
  while (ts.isParenthesizedExpression(p)) p = p.parent;
  return p;
}

/**
 * A promise chain from its last link down: the call it starts from, the
 * fulfilment handlers (`.then(f)`, and `.finally(h)`, which runs on both
 * paths) and the handlers that run on a rejection (`.catch(h)`, `.then(_, h)`,
 * `.finally(h)`).
 */
function chainOf(last: ts.CallExpression): {
  head: ts.CallExpression | null;
  fulfilled: ts.Node[];
  handlers: ts.Node[];
  /** The handlers that handle a rejection (`.catch(h)`, `.then(_, h)`), not `.finally`. */
  catches: ts.Node[];
} {
  const fulfilled: ts.Node[] = [];
  const handlers: ts.Node[] = [];
  const catches: ts.Node[] = [];
  let c: ts.Expression = last;
  while (ts.isCallExpression(c)) {
    const callee = unwrap(c.expression);
    if (!ts.isPropertyAccessExpression(callee)) break;
    const m = callee.name.text;
    if (m === 'then') {
      if (c.arguments[0]) fulfilled.push(c.arguments[0]);
      if (c.arguments[1]) {
        handlers.push(c.arguments[1]);
        catches.push(c.arguments[1]);
      }
    } else if (m === 'catch') {
      if (c.arguments[0]) {
        handlers.push(c.arguments[0]);
        catches.push(c.arguments[0]);
      }
    } else if (m === 'finally') {
      if (c.arguments[0]) {
        handlers.push(c.arguments[0]);
        fulfilled.push(c.arguments[0]);
      }
    } else {
      break;
    }
    c = unwrap(callee.expression);
  }
  return { head: ts.isCallExpression(c) ? c : null, fulfilled, handlers, catches };
}

/** True when `node` calls the setter (or assigns the ref) `flag` anywhere inside it. */
function callsFlag(node: ts.Node, flag: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(unwrap(n.expression))) {
      if ((unwrap(n.expression) as ts.Identifier).text === flag) {
        found = true;
        return;
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      n.left.getText() === flag
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `if (isControlFlow(e)) return ...;`: keeps the flag while the router navigates. */
function isControlFlowReturn(st: ts.Node): boolean {
  if (!ts.isIfStatement(st) || st.elseStatement) return false;
  const cond = unwrap(st.expression);
  if (!ts.isCallExpression(cond) || !ts.isIdentifier(unwrap(cond.expression))) return false;
  if ((unwrap(cond.expression) as ts.Identifier).text !== 'isControlFlow') return false;
  let then: ts.Statement | undefined = st.thenStatement;
  if (ts.isBlock(then)) then = then.statements.length === 1 ? then.statements[0] : undefined;
  return !!then && ts.isReturnStatement(then);
}

/** True when a catch block always falls through to what follows its `try`. */
function fallsThrough(block: ts.Block): boolean {
  let exits = false;
  const visit = (n: ts.Node) => {
    if (exits || isFunctionNode(n)) return;
    if (isControlFlowReturn(n)) return;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      exits = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(block);
  return !exits;
}

/**
 * True when a `try` around `node` (inside `fn`) clears `flag` when `node`
 * throws: in `finally`, in its catch, or after it when the catch falls through.
 */
function protectedByTry(node: ts.Node, fn: FunctionNode, flag: string): boolean {
  for (let child: ts.Node = node, p = node.parent; p && p !== fn; child = p, p = p.parent) {
    if (!ts.isTryStatement(p) || p.tryBlock !== child) continue;
    if (p.finallyBlock && callsFlag(p.finallyBlock, flag)) return true;
    if (p.catchClause) {
      if (callsFlag(p.catchClause.block, flag)) return true;
      if (fallsThrough(p.catchClause.block) && clearedAfter(p, fn, flag)) return true;
      // A catch that leaves without clearing: an outer try may still clear it.
    }
  }
  return false;
}

/** True when a `try` with a catch around `node` (inside `fn`) handles its rejection. */
function caughtWithin(node: ts.Node, fn: FunctionNode): boolean {
  for (let child: ts.Node = node, p = node.parent; p && p !== fn; child = p, p = p.parent) {
    if (ts.isTryStatement(p) && p.tryBlock === child && p.catchClause) return true;
  }
  return false;
}

/** True when a call's rejection is handled where it is made: a try with a catch, or `.catch`. */
function callIsCaught(call: ts.CallExpression): boolean {
  // `save().catch(...)`, `save().then(ok, fail)`.
  const chainParent = call.parent;
  if (
    ts.isPropertyAccessExpression(chainParent) &&
    ts.isCallExpression(chainParent.parent) &&
    (chainParent.name.text === 'catch' ||
      (chainParent.name.text === 'then' && chainParent.parent.arguments.length >= 2))
  ) {
    return true;
  }
  for (let child: ts.Node = call, p = call.parent; p; child = p, p = p.parent) {
    if (isFunctionNode(p)) return false;
    if (ts.isTryStatement(p) && p.tryBlock === child && p.catchClause) return true;
  }
  return false;
}

/** The name `fn` is declared under: `function save()`, `const save = async () =>`, `useCallback`. */
function declaredName(fn: FunctionNode): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  let p: ts.Node = fn.parent;
  if (
    ts.isCallExpression(p) &&
    /(^|\.)(useCallback|useEvent|useEffectEvent)$/.test(p.expression.getText())
  ) {
    p = p.parent;
  }
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

/** The statement that declares `fn` (for its export modifier). */
function declarationOf(fn: FunctionNode): ts.Node | null {
  if (ts.isFunctionDeclaration(fn)) return fn;
  for (let p: ts.Node | undefined = fn.parent; p; p = p.parent) {
    if (ts.isVariableStatement(p)) return p;
    if (ts.isBlock(p) || ts.isSourceFile(p)) return null;
  }
  return null;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p)) &&
      p.name === id) ||
    ts.isBindingElement(p)
  );
}

/** `{ save: save }` in an object a function returns (a hook handing out its functions). */
function isReturnedObject(prop: ts.PropertyAssignment): boolean {
  const obj = prop.parent;
  const p = obj && parentSkippingParens(obj);
  return !!p && (ts.isReturnStatement(p) || ts.isArrowFunction(p));
}

/** True when `flag` is set again after statement `st` ends, inside `fn`. */
function clearedAfter(st: ts.Node, fn: FunctionNode, flag: string): boolean {
  let found = false;
  const end = st.getEnd();
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n !== fn && isFunctionNode(n)) return;
    if (n.getStart() >= end && callsFlag(n, flag)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}
