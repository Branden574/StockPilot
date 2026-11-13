import ts from 'typescript';

import { parseTsx } from './jsx-touch-audit';

/**
 * Reads a screen's load callback the way a reviewer checks it for the stale
 * load defect: after any await, nothing may change the screen until a check
 * that the load is still the newest one started. Not a test file: vitest only
 * collects `*.test.ts`, and the tests that need it import it.
 */

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The statements of the body a screen passes to `React.useCallback(...)` for the const `name`. */
export function callbackStatements(
  source: string,
  file: string,
  name: string,
): { sf: ts.SourceFile; statements: readonly ts.Statement[] } | null {
  const sf = parseTsx(source, file);
  let body: ts.Block | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'React.useCallback'
    ) {
      const fn = n.initializer.arguments[0];
      if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) body = fn.body;
    }
    if (body === null) ts.forEachChild(n, visit);
  };
  visit(sf);
  if (body === null) return null;
  return { sf, statements: (body as ts.Block).statements };
}

/** The calls of `commits` (state setters and the like) anywhere in `node`. */
export function commitsIn(node: ts.Node, commits: ReadonlySet<string>): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && commits.has(n.expression.text)) {
      out.push(n.expression.text);
    }
  });
  return out;
}

export function awaitsIn(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (ts.isAwaitExpression(n)) found = true;
  });
  return found;
}

/**
 * Walks the top-level statements: every statement that calls one of
 * `commits` after an await (or holds an await itself) with no `guard`
 * statement (`if (<guard>) return;`) since, and how many guards there are.
 */
export function unguardedCommits(
  sf: ts.SourceFile,
  statements: readonly ts.Statement[],
  commits: ReadonlySet<string>,
  guard: string,
): { unguarded: string[]; guards: number } {
  const unguarded: string[] = [];
  let readSinceCheck = false;
  let guards = 0;
  for (const st of statements) {
    if (
      ts.isIfStatement(st) &&
      st.expression.getText(sf) === guard &&
      ts.isReturnStatement(st.thenStatement) &&
      st.elseStatement === undefined
    ) {
      readSinceCheck = false;
      guards += 1;
      continue;
    }
    const found = commitsIn(st, commits);
    const awaits = awaitsIn(st);
    if (found.length > 0 && (readSinceCheck || awaits)) {
      unguarded.push(`${found.join(', ')}: ${st.getText(sf).slice(0, 60)}`);
    }
    if (awaits) readSinceCheck = true;
  }
  return { unguarded, guards };
}
