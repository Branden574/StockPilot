import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CLASSIC_PINS } from './glass-classic-pins.test';

/**
 * SWITCHING THE APPEARANCE KEEPS WHAT IS ON SCREEN (plan 8.2, case 8).
 *
 * React keeps a component's state while the same element type stays at the
 * same place. Every Liquid Glass difference is a branch on `lg`, so a switch
 * re-renders the same tree with other styles; a branch that put a DIFFERENT
 * element in place of a stateful one (a field, a list, a scroll, a sheet, a
 * camera) would unmount it and lose what it held: the typed text, the scroll,
 * the open sheet, the camera session. This fails when any branch on `lg` in a
 * pinned file swaps a stateful element for something else; a branch may add
 * or remove a stateless decoration (`lg ? <SceneBackground /> : null`) or
 * restyle the same element, which keeps every slot where it was.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');

/** Elements that hold state a person would lose if they were remounted. */
const STATEFUL = new Set([
  'TextInput',
  'Field',
  'FlatList',
  'SectionList',
  'ScrollView',
  'KeyboardAvoidingView',
  'Modal',
  'CameraView',
  'WebView',
  'Animated.View',
  'Animated.ScrollView',
  'Animated.FlatList',
]);

function tagsIn(node: ts.Node, sf: ts.SourceFile, out: string[] = []): string[] {
  if (ts.isJsxElement(node)) out.push(node.openingElement.tagName.getText(sf));
  else if (ts.isJsxSelfClosingElement(node)) out.push(node.tagName.getText(sf));
  ts.forEachChild(node, (n) => void tagsIn(n, sf, out));
  return out;
}

/**
 * Decorations that happen to be stateful element types, left out by name:
 * each holds nothing a person put there (its animated values live in the
 * screen, which stays mounted).
 */
const DECORATIONS: Record<string, string> = {
  // The Face ID pulse ring: Liquid Glass draws the board's tile instead.
  'src/components/biometric-lock-screen.tsx': 'Animated.View',
};

const isLg = (e: ts.Expression) => ts.isIdentifier(e) && e.text === 'lg';

/** Every `lg ? a : b` and `lg && a` in a file whose branches hold a stateful element. */
function swaps(file: string): string[] {
  const src = readFileSync(path.join(MOBILE_ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isConditionalExpression(node) && isLg(node.condition)) {
      const kept = (t: string) => STATEFUL.has(t) && DECORATIONS[file] !== t;
      const glass = tagsIn(node.whenTrue, sf).filter(kept);
      const classic = tagsIn(node.whenFalse, sf).filter(kept);
      if (glass.length > 0 || classic.length > 0) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.push(`${file}:${line} glass[${glass.join(',')}] classic[${classic.join(',')}]`);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isLg(node.left)
    ) {
      const glass = tagsIn(node.right, sf).filter((t) => STATEFUL.has(t));
      if (glass.length > 0) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.push(`${file}:${line} glass-only[${glass.join(',')}]`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('switching the appearance never remounts a stateful element', () => {
  for (const file of Object.keys(CLASSIC_PINS)) {
    it(`${file}: no branch on the look swaps a field, list, scroll, sheet or camera`, () => {
      expect(swaps(file)).toEqual([]);
    });
  }

  it('catches a swap (the check is not empty)', () => {
    const probe = 'const a = lg ? <View /> : <TextInput value={v} />;';
    const sf = ts.createSourceFile('p.tsx', probe, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let hit = false;
    const visit = (n: ts.Node) => {
      if (ts.isConditionalExpression(n) && isLg(n.condition)) {
        hit ||= tagsIn(n.whenFalse, sf).some((t) => STATEFUL.has(t));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(hit).toBe(true);
  });
});
