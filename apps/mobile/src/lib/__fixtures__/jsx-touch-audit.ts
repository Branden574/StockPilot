import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';

/**
 * TEST-ONLY JSX audit for the "touchable wraps the sheet" defect class.
 *
 * Parses .tsx with the TypeScript compiler (no regex over markup), so a
 * reformat, a prop moved to another line or a `() => {}` spelled instead of
 * `() => undefined` cannot slip past it. Used by sheet-backdrop-guard.test.ts
 * (sweeps every screen and component) and sheet-a11y-structure.test.ts (pins
 * the converted sheets' element tree).
 *
 * WHY THE SHAPE MATTERS: a Pressable (or any Touchable*) is an accessibility
 * element by default, and iOS folds everything inside one into ONE element
 * whose label concatenates every text. A sheet card wrapped in
 * `Pressable onPress={() => undefined}` (to keep taps inside it from reaching
 * a scrim parent) was read by VoiceOver as one long label, with its text
 * fields and Confirm/Cancel buttons unreachable (simulator walk 2026-09-25,
 * item screen Adjust stock sheet). The same wrapper claims the touch responder
 * and blocks scrolling inside the sheet (add-order-items-sheet.tsx).
 */

export const TOUCHABLE_TAG =
  /^(?:Animated\.)?(?:Pressable|AnimatedPressable|TouchableWithoutFeedback|TouchableOpacity|TouchableHighlight|TouchableNativeFeedback)$/;

const PRESS_HANDLERS = ['onPress', 'onLongPress', 'onPressIn', 'onPressOut'] as const;

export type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

export type TouchFinding = {
  file: string;
  line: number;
  tag: string;
  rule: 'noop-onpress' | 'no-press-handler' | 'wraps-text-input' | 'swallows-responder';
  detail: string;
};

export function parseTsx(source: string, fileName = 'probe.tsx'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function tagOf(el: JsxNode, sf: ts.SourceFile): string {
  return (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText(sf);
}

function attributesOf(el: JsxNode): ts.NodeArray<ts.JsxAttributeLike> {
  return (ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes).properties;
}

export function attr(el: JsxNode, name: string, sf: ts.SourceFile): ts.JsxAttribute | undefined {
  return attributesOf(el).find(
    (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name,
  );
}

/** The attribute's value as source text: `{onClose}` -> `onClose`, `"Close"` -> `Close`, bare -> `true`. */
export function attrText(el: JsxNode, name: string, sf: ts.SourceFile): string | undefined {
  const a = attr(el, name, sf);
  if (!a) return undefined;
  const init = a.initializer;
  if (!init) return 'true';
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init)) return init.expression ? init.expression.getText(sf) : '';
  return init.getText(sf);
}

function hasSpread(el: JsxNode): boolean {
  return attributesOf(el).some((a) => ts.isJsxSpreadAttribute(a));
}

/** True when the element renders any child (whitespace-only text does not count). */
export function hasContent(el: JsxNode): boolean {
  if (!ts.isJsxElement(el)) return false;
  return el.children.some((ch) => !(ts.isJsxText(ch) && ch.containsOnlyTriviaWhiteSpaces));
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isNothing(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (ts.isIdentifier(u) && u.text === 'undefined') return true;
  if (u.kind === ts.SyntaxKind.NullKeyword) return true;
  // `void 0` — but NOT `void submit()`, which does real work.
  if (ts.isVoidExpression(u) && ts.isLiteralExpression(unwrap(u.expression))) return true;
  return false;
}

/** `e.stopPropagation()` / `e?.stopPropagation?.()` / `e.preventDefault()` — swallows, does nothing. */
function isSwallowCall(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (!ts.isCallExpression(u)) return false;
  const callee = unwrap(u.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'stopPropagation' || callee.name.text === 'preventDefault')
  );
}

/**
 * A press handler that does nothing: `() => undefined`, `() => {}`, `() => null`,
 * `() => void 0`, `(e) => e.stopPropagation()`, `function () {}`, `noop`.
 */
export function isNoopHandler(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isIdentifier(e) && /^noop$/i.test(e.text)) return true;
  if (!ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) return false;
  const body = e.body;
  if (ts.isBlock(body)) {
    return body.statements.every(
      (st) =>
        st.kind === ts.SyntaxKind.EmptyStatement ||
        (ts.isExpressionStatement(st) && (isNothing(st.expression) || isSwallowCall(st.expression))) ||
        (ts.isReturnStatement(st) && (!st.expression || isNothing(st.expression))),
    );
  }
  return isNothing(body) || isSwallowCall(body);
}

/** A press handler attribute that can do something: present, and not literally undefined/null. */
function hasRealPressHandler(el: JsxNode, sf: ts.SourceFile): boolean {
  return PRESS_HANDLERS.some((name) => {
    const a = attr(el, name, sf);
    if (!a) return false;
    if (!a.initializer) return true;
    if (ts.isJsxExpression(a.initializer)) {
      const x = a.initializer.expression;
      return !!x && !isNothing(x) && !isNoopHandler(x);
    }
    return true;
  });
}

/** Visit every JSX element with its JSX ancestor chain (outermost first). */
export function walkJsx(
  node: ts.Node,
  visit: (el: JsxNode, ancestors: readonly JsxNode[]) => void,
  ancestors: JsxNode[] = [],
): void {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    visit(node, ancestors);
    ancestors.push(node);
    ts.forEachChild(node, (ch) => walkJsx(ch, visit, ancestors));
    ancestors.pop();
    return;
  }
  ts.forEachChild(node, (ch) => walkJsx(ch, visit, ancestors));
}

/** Every touchable-wraps-content defect in one source file. */
export function auditTouchSinks(source: string, file = 'probe.tsx'): TouchFinding[] {
  const sf = parseTsx(source, file);
  const out: TouchFinding[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  walkJsx(sf, (el, ancestors) => {
    const tag = tagOf(el, sf);
    const nearestTouchable = [...ancestors].reverse().find((a) => TOUCHABLE_TAG.test(tagOf(a, sf)));

    if (TOUCHABLE_TAG.test(tag) && hasContent(el)) {
      const onPress = attr(el, 'onPress', sf);
      const onPressExpr =
        onPress?.initializer && ts.isJsxExpression(onPress.initializer)
          ? onPress.initializer.expression
          : undefined;
      if (onPressExpr && isNoopHandler(onPressExpr)) {
        out.push({
          file,
          line: lineOf(el),
          tag,
          rule: 'noop-onpress',
          detail: `onPress={${onPressExpr.getText(sf)}} wraps content`,
        });
      } else if (!hasSpread(el) && !hasRealPressHandler(el, sf)) {
        out.push({
          file,
          line: lineOf(el),
          tag,
          rule: 'no-press-handler',
          detail: 'wraps content without any press handler',
        });
      }
    }

    if (tag === 'TextInput') {
      // Every touchable above a text field is a defect — the scrim parent as
      // much as the no-op card — so report each one, outermost first.
      for (const a of ancestors) {
        if (!TOUCHABLE_TAG.test(tagOf(a, sf))) continue;
        out.push({
          file,
          line: lineOf(a),
          tag: tagOf(a, sf),
          rule: 'wraps-text-input',
          detail: `wraps the TextInput at line ${lineOf(el)}`,
        });
      }
    }

    const responder = attr(el, 'onStartShouldSetResponder', sf);
    if (responder && nearestTouchable) {
      out.push({
        file,
        line: lineOf(el),
        tag,
        rule: 'swallows-responder',
        detail: 'claims the responder inside a touchable (the other spelling of the no-op card)',
      });
    }
  });

  // One touchable wrapping two TextInputs is one defect, not two.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every non-test .tsx under the given directories. */
export function listTsx(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.tsx') && !/\.test\.tsx$/.test(entry.name)) out.push(p);
    }
  };
  dirs.forEach(walk);
  return out.sort();
}

export function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}
