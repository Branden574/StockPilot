import ts from 'typescript';

/**
 * Finds every place in the web app that ends the session in this tab ON
 * PURPOSE, and checks that each one removes what lib/interrupted-run keeps in
 * the tab (purgeInterruptedRuns()) before its request leaves. Used by
 * src/lib/interrupted-run.sign-out.guard.test.ts.
 *
 * WHAT ENDS THE SESSION ON PURPOSE (a sign-out site):
 *   - a Server Action that ends the caller's own session, imported from a
 *     server/actions module under any local name (or through a namespace
 *     import): signOutAction (signs out everywhere), deleteOwnAccountAction
 *     (signs this browser out once the account is gone) and
 *     completePasswordResetAction (signs out everywhere once the new password
 *     is set). Called, or given to a form as its action;
 *   - in a 'use client' module, a call to `<client>.auth.signOut(...)` (the
 *     forced sign-out when this session is revoked);
 *   - the cookie-clearing sign-out route (/auth/session-ended: "Sign out and
 *     back in"), written as the path, as SESSION_ENDED_PATH, or as a constant
 *     holding the path: a link to it, a form (or a button's formAction) that
 *     submits to it, and, in a 'use client' module, a call or an assignment
 *     that navigates there. The SERVER's own redirect there
 *     (lib/auth/session-ended.ts, for a session that expired) is not one: an
 *     expired session keeps its record, which is what the record is for.
 *
 * WHAT IS CHECKED:
 *   - a call: an earlier statement `purgeInterruptedRuns();` in the same
 *     function, in a block that also holds the call, so it always runs first
 *     (a purge in a branch, after the call or inside a callback does not
 *     count);
 *   - a form action: the same form's onSubmit runs purgeInterruptedRuns()
 *     (React runs onSubmit before the form's action, and the browser fires
 *     submit in this tab wherever the submission opens); a button's
 *     formAction: the same button's onClick runs it;
 *   - a link: always reported. A link can be opened in another tab (a
 *     middle-click, the context menu, a long press), which signs the browser
 *     out while this tab runs nothing, so even a link whose onClick purges
 *     leaves the records there. Use a button whose click purges and then
 *     loads the route;
 *   - a handler counts when it IS purgeInterruptedRuns, or calls it before its
 *     first await.
 * A server component cannot attach a handler, so a sign-out form in one is
 * reported: render a client component (components/auth/sign-out-form).
 * Any other use of those Server Actions (passed on as a value) is reported
 * too: the guard cannot follow it.
 *
 * Not followed: dynamic imports of the actions, and paths built at run time.
 * Parsed with the TypeScript compiler, not a regex: comments and strings never
 * count, and a call split over several lines is still one call.
 */

export interface ScanFile {
  /** Absolute path. */
  path: string;
  text: string;
}

export type SiteHow = 'call' | 'form-action' | 'link' | 'navigation' | 'value';

export interface SignOutSite {
  file: string;
  line: number;
  /** The enclosing named function, or '(top level)'. */
  fn: string;
  /** What ends the session: the Server Action, 'auth.signOut', or the route. */
  what: string;
  how: SiteHow;
  /** Why the site breaks the rule; null when it purges first. */
  problem: string | null;
}

/** Server Actions that end the caller's own session in this browser. */
export const SESSION_ENDING_ACTIONS: ReadonlySet<string> = new Set([
  'signOutAction',
  'deleteOwnAccountAction',
  'completePasswordResetAction',
]);

/** The cookie-clearing sign-out route (lib/auth/session-ended.ts SESSION_ENDED_PATH). */
export const SIGN_OUT_ROUTE = '/auth/session-ended';

const PURGE = 'purgeInterruptedRuns';

const PROBLEMS: Record<SiteHow, string> = {
  call: `ends the session without ${PURGE}() first: call it in an earlier statement of the same function, outside any branch, before the request leaves`,
  'form-action': `a form whose action ends the session needs onSubmit={() => ${PURGE}()} (React runs onSubmit before the action); a server component cannot have one, so render a client component such as components/auth/sign-out-form.tsx`,
  link: `a link to the sign-out route can be opened in another tab (a middle-click, the context menu), which signs the browser out while this tab runs nothing: use a button whose onClick runs ${PURGE}() and then loads the route`,
  navigation: `navigates to the sign-out route without ${PURGE}() first, in an earlier statement of the same function`,
  value: `passed on as a value, which this guard cannot follow: call it from a function that runs ${PURGE}() first`,
};

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(n: ts.Node): n is FunctionLike {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** The outermost node of `node` wrapped in parentheses, `!` or type assertions. */
function wrapped(node: ts.Node): ts.Node {
  let n = node;
  while (
    n.parent &&
    (ts.isParenthesizedExpression(n.parent) ||
      ts.isNonNullExpression(n.parent) ||
      ts.isAsExpression(n.parent) ||
      ts.isSatisfiesExpression(n.parent) ||
      ts.isTypeAssertionExpression(n.parent))
  ) {
    n = n.parent;
  }
  return n;
}

function directive(sf: ts.SourceFile): 'client' | 'server' | null {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) break;
    if (s.expression.text === 'use client') return 'client';
    if (s.expression.text === 'use server') return 'server';
  }
  return null;
}

function isActionsModule(specifier: string): boolean {
  return /(^|\/)server\/actions\//.test(specifier);
}

function isRoutePath(text: string): boolean {
  return (
    text === SIGN_OUT_ROUTE ||
    text.startsWith(`${SIGN_OUT_ROUTE}?`) ||
    text.startsWith(`${SIGN_OUT_ROUTE}#`)
  );
}

function isPurgeCall(node: ts.Expression): boolean {
  let n = unwrap(node);
  if (ts.isVoidExpression(n)) n = unwrap(n.expression);
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === PURGE;
}

function isPurgeStatement(s: ts.Statement): boolean {
  return ts.isExpressionStatement(s) && isPurgeCall(s.expression);
}

/** True when `node` awaits (or yields) outside any function nested in it. */
function awaits(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isAwaitExpression(n) || ts.isYieldExpression(n)) {
      found = true;
      return;
    }
    if (isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** A handler that is the purge itself, or calls it before its first await. */
function handlerPurgesFirst(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text === PURGE;
  if (!ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) return false;
  if (!ts.isBlock(e.body)) return isPurgeCall(e.body);
  for (const s of e.body.statements) {
    if (isPurgeStatement(s)) return true;
    if (awaits(s)) return false;
  }
  return false;
}

function statementsOf(n: ts.Node): ts.NodeArray<ts.Statement> | null {
  if (
    ts.isBlock(n) ||
    ts.isSourceFile(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseClause(n) ||
    ts.isDefaultClause(n)
  ) {
    return n.statements;
  }
  return null;
}

/**
 * True when a `purgeInterruptedRuns();` statement always runs before `node`
 * in its function: an earlier statement of a block that holds `node`.
 */
function purgedBefore(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    const statements = statementsOf(parent);
    if (statements) {
      for (const s of statements) {
        if (s === child) break;
        if (isPurgeStatement(s)) return true;
      }
    }
    if (isFunctionLike(parent)) return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return '(top level)';
}

/** The JSX element an attribute belongs to, and that element's attributes. */
function jsxElementOf(attr: ts.JsxAttribute): ts.JsxOpeningLikeElement {
  return attr.parent.parent;
}

function elementHandlerPurges(element: ts.JsxOpeningLikeElement, handler: string): boolean {
  for (const a of element.attributes.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== handler) continue;
    const init = a.initializer;
    return (
      !!init && ts.isJsxExpression(init) && !!init.expression && handlerPurgesFirst(init.expression)
    );
  }
  return false;
}

/** True when an identifier is a use of a binding, not a name being declared or a property name. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isJsxAttribute(p) ||
    ts.isTypeReferenceNode(p) ||
    ts.isTypeQueryNode(p) ||
    ts.isQualifiedName(p)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p)) &&
    p.name === id
  ) {
    return false;
  }
  return true;
}

interface FileBindings {
  /** Local name -> the session-ending action it is. */
  actions: Map<string, string>;
  /** Namespace imports of server/actions modules. */
  namespaces: Set<string>;
  /** Names that hold the sign-out route: SESSION_ENDED_PATH, or a const of the path. */
  routeNames: Set<string>;
}

function bindingsOf(sf: ts.SourceFile): FileBindings {
  const b: FileBindings = { actions: new Map(), namespaces: new Set(), routeNames: new Set() };
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const spec = s.moduleSpecifier.text;
    const clause = s.importClause;
    if (!clause?.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      if (isActionsModule(spec)) b.namespaces.add(clause.namedBindings.name.text);
      continue;
    }
    for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (isActionsModule(spec) && SESSION_ENDING_ACTIONS.has(imported)) {
        b.actions.set(el.name.text, imported);
      }
      if (imported === 'SESSION_ENDED_PATH') b.routeNames.add(el.name.text);
    }
  }
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const init = unwrap(n.initializer);
      if (
        (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) &&
        isRoutePath(init.text)
      ) {
        b.routeNames.add(n.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return b;
}

function isRouteValue(expr: ts.Expression | undefined, routeNames: ReadonlySet<string>): boolean {
  if (!expr) return false;
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return isRoutePath(e.text);
  if (ts.isTemplateExpression(e)) return isRoutePath(e.head.text);
  return ts.isIdentifier(e) && routeNames.has(e.text);
}

/** `<x>.auth.signOut(...)`, for any client `x`. */
function isAuthSignOutCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'signOut') return false;
  const target = unwrap(callee.expression);
  return ts.isPropertyAccessExpression(target) && target.name.text === 'auth';
}

function scanFile(file: ScanFile): SignOutSite[] {
  const kind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
  const mode = directive(sf);
  const isClient = mode === 'client';
  const bindings = bindingsOf(sf);
  const sites: SignOutSite[] = [];

  const add = (node: ts.Node, what: string, how: SiteHow, ok: boolean): void => {
    sites.push({
      file: file.path,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      fn: enclosingName(node),
      what,
      how,
      problem: ok ? null : PROBLEMS[how],
    });
  };

  /** A use of a session-ending action: called, a form's action, or a value. */
  const actionUse = (ref: ts.Node, what: string): void => {
    const outer = wrapped(ref);
    const parent = outer.parent;
    if (parent && ts.isCallExpression(parent) && parent.expression === outer) {
      add(parent, what, 'call', purgedBefore(parent));
      return;
    }
    if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
      const attr = parent.parent;
      const name = attr.name.getText();
      if (name === 'action' || name === 'formAction') {
        const handler = name === 'action' ? 'onSubmit' : 'onClick';
        add(attr, what, 'form-action', elementHandlerPurges(jsxElementOf(attr), handler));
        return;
      }
    }
    add(outer, what, 'value', false);
  };

  const visit = (n: ts.Node): void => {
    // The actions, in any module but a 'use server' one (server code cannot
    // reach the browser's storage, and calls none of them).
    if (mode !== 'server') {
      if (ts.isIdentifier(n) && bindings.actions.has(n.text) && isReference(n)) {
        actionUse(n, bindings.actions.get(n.text)!);
      } else if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        bindings.namespaces.has(n.expression.text) &&
        SESSION_ENDING_ACTIONS.has(n.name.text)
      ) {
        actionUse(n, n.name.text);
      }
    }

    // Links and forms to the sign-out route, in any module that renders one.
    if (ts.isJsxAttribute(n)) {
      const name = n.name.getText();
      const init = n.initializer;
      const value =
        init && ts.isJsxExpression(init)
          ? init.expression
          : init && ts.isStringLiteral(init)
            ? init
            : undefined;
      if (isRouteValue(value, bindings.routeNames)) {
        if (name === 'href') {
          // Never this tab's alone: see PROBLEMS.link.
          add(n, SIGN_OUT_ROUTE, 'link', false);
        } else if (name === 'action' || name === 'formAction') {
          const handler = name === 'action' ? 'onSubmit' : 'onClick';
          add(n, SIGN_OUT_ROUTE, 'form-action', elementHandlerPurges(jsxElementOf(n), handler));
        }
      }
    }

    if (isClient) {
      if (ts.isCallExpression(n)) {
        if (isAuthSignOutCall(n)) {
          add(n, 'auth.signOut', 'call', purgedBefore(n));
        } else if (n.arguments.some((a) => isRouteValue(a, bindings.routeNames))) {
          // router.push(SESSION_ENDED_PATH), location.assign('/auth/session-ended')
          add(n, SIGN_OUT_ROUTE, 'navigation', purgedBefore(n));
        }
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isRouteValue(n.right, bindings.routeNames)
      ) {
        // location.href = SESSION_ENDED_PATH
        add(n, SIGN_OUT_ROUTE, 'navigation', purgedBefore(n));
      }
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

export interface SignOutScan {
  /** Every sign-out site found, in file and line order. */
  sites: SignOutSite[];
  /** The sites that do not purge first. */
  findings: SignOutSite[];
}

export function scanSignOutSites(files: ScanFile[]): SignOutScan {
  const sites = files
    .flatMap(scanFile)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { sites, findings: sites.filter((s) => s.problem !== null) };
}
