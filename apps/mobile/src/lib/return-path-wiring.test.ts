import { readdirSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseTsx, readSource } from './__fixtures__/jsx-touch-audit';

/**
 * EVERY `?return=` BACK GOES THROUGH goBackFromReturn (docket T14) — WIRING PINS.
 *
 * Five Back buttons honour a `?return=` search param: Settings, Support, the
 * AI screen, the Books tab and DataListScreen (the shared header of every
 * drawer list). Each passed the raw value to router.replace, and expo-router
 * opens a value with a scheme or a leading `//` outside the app, so a crafted
 * stockpilot:// link made the app's own Back open any website or app. The
 * check now lives in one helper (return-path.ts); these pins keep every reader
 * of the param on it:
 *
 *   1. the set of files that read a `return` search param is exactly the five
 *      known screens, found from the source tree, so a sixth reader fails here
 *      until it is wired and added;
 *   2. in each, the value read is used only as goBackFromReturn's argument:
 *      never handed to router.replace / push / navigate, a Redirect or a Link.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const EXPECTED_READERS = [
  'app/(drawer)/(tabs)/books.tsx',
  'app/(drawer)/ai.tsx',
  'app/(drawer)/settings.tsx',
  'app/(drawer)/support.tsx',
  'src/components/data-list-screen.tsx',
];

const SEARCH_PARAM_HOOKS = new Set(['useLocalSearchParams', 'useGlobalSearchParams']);

/** Every non-test .ts/.tsx file under app/ and src/. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(MOBILE_ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk('app');
  walk('src');
  return out.sort();
}

function isSearchParamHookCall(node: ts.Node | undefined): node is ts.CallExpression {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    SEARCH_PARAM_HOOKS.has(node.expression.text)
  );
}

/** The call a declaration's initializer makes, looking through `as` casts and parentheses. */
function unwrapInitializer(node: ts.Expression | undefined): ts.Expression | undefined {
  let n = node;
  while (
    n &&
    (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n))
  ) {
    n = n.expression;
  }
  return n;
}

type ReturnReader = {
  /** The local names the `return` value is bound to (`{ return: returnPath }`). */
  aliases: string[];
  /** `params.return` / `params['return']` reads on a variable holding the hook's result. */
  memberReads: ts.Expression[];
  /** A `return` key declared in the hook's type argument. */
  typed: boolean;
};

function returnReaders(sf: ts.SourceFile): ReturnReader {
  const reader: ReturnReader = { aliases: [], memberReads: [], typed: false };
  const paramObjects = new Set<string>();
  const visit = (node: ts.Node) => {
    if (isSearchParamHookCall(node)) {
      for (const arg of node.typeArguments ?? []) {
        if (
          ts.isTypeLiteralNode(arg) &&
          arg.members.some((m) => m.name && ts.isIdentifier(m.name) && m.name.text === 'return')
        ) {
          reader.typed = true;
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      isSearchParamHookCall(unwrapInitializer(node.initializer))
    ) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          if (
            (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
            key.text === 'return' &&
            ts.isIdentifier(el.name)
          ) {
            reader.aliases.push(el.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        paramObjects.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const collectMembers = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'return' &&
      ts.isIdentifier(node.expression) &&
      paramObjects.has(node.expression.text)
    ) {
      reader.memberReads.push(node);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'return' &&
      ts.isIdentifier(node.expression) &&
      paramObjects.has(node.expression.text)
    ) {
      reader.memberReads.push(node);
    }
    ts.forEachChild(node, collectMembers);
  };
  collectMembers(sf);
  return reader;
}

const isReader = (r: ReturnReader) => r.typed || r.aliases.length > 0 || r.memberReads.length > 0;

/** True when `node` is the second argument of a `goBackFromReturn(router, <node>)` call. */
function isGoBackFromReturnArgument(node: ts.Node): boolean {
  const call = node.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'goBackFromReturn' &&
    call.arguments.length === 2 &&
    call.arguments[1] === node &&
    ts.isIdentifier(call.arguments[0]!) &&
    call.arguments[0].text === 'router'
  );
}

/** Every use of `name` in the file other than its binding in the hook's destructure. */
function usesOf(sf: ts.SourceFile, name: string): ts.Identifier[] {
  const uses: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      const isBinding = ts.isBindingElement(p) && p.name === node;
      const isPropertyName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node);
      if (!isBinding && !isPropertyName) uses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

const FILES = sourceFiles();
const READERS = FILES.filter((file) =>
  isReader(returnReaders(parseTsx(readSource(path.join(MOBILE_ROOT, file)), file))),
);

describe('?return= Back targets: one checked helper at every reader (T14)', () => {
  it('finds the source tree (guard against a walk that reads nothing)', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('src/components/data-list-screen.tsx');
  });

  it('exactly the five known screens read a `return` search param', () => {
    expect(READERS).toEqual(EXPECTED_READERS);
  });

  for (const file of EXPECTED_READERS) {
    describe(file, () => {
      const src = readSource(path.join(MOBILE_ROOT, file));
      const sf = parseTsx(src, file);
      const reader = returnReaders(sf);

      it('imports goBackFromReturn from the one helper module', () => {
        expect(src).toMatch(/import \{ goBackFromReturn \} from '@\/lib\/return-path';/);
      });

      it('binds the param once and uses it only as goBackFromReturn(router, …)', () => {
        expect(reader.memberReads).toEqual([]);
        expect(reader.aliases).toHaveLength(1);
        const [alias] = reader.aliases;
        const uses = usesOf(sf, alias!);
        expect(uses.length, `${alias} is never passed to goBackFromReturn`).toBeGreaterThan(0);
        for (const use of uses) {
          const at = sf.getLineAndCharacterOfPosition(use.getStart(sf)).line + 1;
          expect(
            isGoBackFromReturnArgument(use),
            `${file}:${at} uses ${alias} outside goBackFromReturn`,
          ).toBe(true);
        }
      });

      it('never hands a raw param to the router', () => {
        expect(src).not.toMatch(/router\.(?:replace|push|navigate|dismissTo)\(\s*returnPath\b/);
        expect(src).not.toMatch(/returnPath as never/);
      });
    });
  }
});
