import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, readSource, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * THE ORDER SCREEN AND THE KEYBOARD (F2-2 walk, O2).
 *
 * The order screen's ScrollView had no keyboard handling, so with the iPad's
 * docked keyboard a focused field low on the screen (a digital-pick quantity,
 * including the one "Review short lines" focuses) sat under the keyboard,
 * focused and typed into but hidden, and could not be scrolled above it. The
 * ScrollView now sits in a KeyboardAvoidingView, the wrapper the app's form
 * screens use (item/new, maintenance/new, schedule/new, rentals/new):
 * padding on iOS, nothing on Android, where the window already resizes.
 */

const FILE = 'app/order/[id].tsx';
const sf = parseTsx(readSource(path.resolve(__dirname, '../..', FILE)), FILE);

function parentElement(node: ts.Node): JsxNode | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isJsxElement(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

describe('order screen: the ScrollView keeps fields above the keyboard', () => {
  const scrolls: JsxNode[] = [];
  walkJsx(sf, (el) => {
    // The screen's own ScrollView: the one with the pull-to-refresh.
    if (tagOf(el, sf) === 'ScrollView' && attrText(el, 'refreshControl', sf)) scrolls.push(el);
  });

  it('finds the screen ScrollView', () => {
    expect(scrolls).toHaveLength(1);
  });

  // Mutation caught: the wrapper removed, or its behavior changed.
  it('it sits directly in a KeyboardAvoidingView with padding on iOS', () => {
    const scroll = scrolls[0]!;
    const opening = ts.isJsxElement(scroll) ? scroll.openingElement : scroll;
    const kav = parentElement(ts.isJsxElement(scroll) ? scroll : opening);
    expect(kav && tagOf(kav, sf)).toBe('KeyboardAvoidingView');
    expect(attrText(kav!, 'behavior', sf)).toBe("Platform.OS === 'ios' ? 'padding' : undefined");
    expect(attrText(kav!, 'style', sf)).toBe('{ flex: 1 }');
  });
});
