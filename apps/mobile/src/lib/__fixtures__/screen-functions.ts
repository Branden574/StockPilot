import * as path from 'node:path';

import ts from 'typescript';

import { parseTsx, readSource } from './jsx-touch-audit';

/**
 * A screen's own code, RUN. The mobile suite has no React Native renderer and
 * does not collect app/, so a screen's handlers are read from the
 * repository's source, compiled, and built with `deps` bound to the names they
 * read: state setters, module functions and native modules become stubs the
 * test controls, and everything else is the screen's code as written. Built
 * with `new Function` in the test's own realm, so an `instanceof` check in the
 * screen sees the same classes the test throws. The only text ever compiled
 * is a file of this repository named by the test, never input (the same
 * idiom as the structure tests' screenFunctions and runFunction).
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');

function sourceFile(file: string): ts.SourceFile {
  return parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
}

function compile(text: string): string {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText;
}

function build<T>(js: string, deps: Record<string, unknown>): T {
  const names = Object.keys(deps);
  return new Function(...names, js)(...names.map((n) => deps[n])) as T;
}

/** The function `name` a screen declares, at its top level or inside its component. */
export function screenFunction<T>(file: string, name: string, deps: Record<string, unknown>): T {
  const sf = sourceFile(file);
  let decl: ts.FunctionDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (decl) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) decl = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!decl) throw new Error(`function ${name} not found in ${file}`);
  return build<T>(`${compile(decl.getText(sf))}\nreturn ${name};`, deps);
}

/** The initializer a screen passes to `React.useState(...)` for the state `name`. */
export function stateInitializer<T>(file: string, name: string, deps: Record<string, unknown>): T {
  const sf = sourceFile(file);
  let init: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (init) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.name.elements.some(
        (el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === name,
      ) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'React.useState'
    ) {
      init = n.initializer.arguments[0];
    } else {
      ts.forEachChild(n, visit);
    }
  };
  visit(sf);
  if (!init) throw new Error(`React.useState for ${name} not found in ${file}`);
  return build<T>(
    `return ${compile(`(${init.getText(sf)});`)
      .trim()
      .replace(/;$/, '')};`,
    deps,
  );
}
