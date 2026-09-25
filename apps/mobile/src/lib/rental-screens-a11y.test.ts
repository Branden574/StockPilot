import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * VOICEOVER NAMES ON THE RENTAL SCREENS (simulator walk 2026-09-25).
 *
 * The list's New rental "+" chip, New rental's quantity steppers (+ and -) and
 * its warehouse chips were read as unnamed elements with no button role, so
 * VoiceOver could not say what they do. These read the element tree each
 * screen declares (the mobile suite has no React Native renderer; same
 * technique as sheet-a11y-structure.test.ts) and pin that every touchable is a
 * button with words to read, and that every icon-only chip is labelled.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCREENS = ['app/rentals/[id].tsx', 'app/rentals/new.tsx', 'src/screens/rentals.tsx'];

type Found = { el: JsxNode; sf: ts.SourceFile; file: string };

function elementsOf(file: string, pred: (el: JsxNode, sf: ts.SourceFile) => boolean): Found[] {
  const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
  const out: Found[] = [];
  walkJsx(sf, (el) => {
    if (pred(el, sf)) out.push({ el, sf, file });
  });
  return out;
}

/** True when the element renders words: JSX text, or an expression child. */
function rendersText(el: JsxNode): boolean {
  if (!ts.isJsxElement(el)) return false;
  return el.children.some((ch) => {
    if (ts.isJsxText(ch)) return !ch.containsOnlyTriviaWhiteSpaces;
    if (ts.isJsxExpression(ch)) return ch.expression !== undefined;
    if (ts.isJsxElement(ch)) return rendersText(ch);
    return false;
  });
}

function where(f: Found): string {
  const { line } = f.sf.getLineAndCharacterOfPosition(f.el.getStart(f.sf));
  return `${f.file}:${line + 1} <${tagOf(f.el, f.sf)}>`;
}

describe('rental screens: every touchable is a named button', () => {
  it.each(SCREENS)('%s', (file) => {
    const touchables = elementsOf(file, (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)));
    expect(touchables.length).toBeGreaterThan(0);
    for (const t of touchables) {
      expect(attrText(t.el, 'accessibilityRole', t.sf), `${where(t)} has no button role`).toBe('button');
      const named = attrText(t.el, 'accessibilityLabel', t.sf) !== undefined || rendersText(t.el);
      expect(named, `${where(t)} has nothing for VoiceOver to read`).toBe(true);
    }
  });

  it.each(SCREENS)('%s: every icon-only chip has a label', (file) => {
    for (const chip of elementsOf(file, (el, sf) => tagOf(el, sf) === 'IconChip')) {
      expect(attrText(chip.el, 'accessibilityLabel', chip.sf), `${where(chip)} is unlabelled`).toBeTruthy();
    }
  });
});

describe('the words VoiceOver reads', () => {
  it("the list's + chip says New rental", () => {
    const chips = elementsOf('src/screens/rentals.tsx', (el, sf) => tagOf(el, sf) === 'IconChip');
    expect(chips.map((c) => attrText(c.el, 'accessibilityLabel', c.sf))).toEqual(['New rental']);
  });

  it('the steppers name the item and what a tap does, and say when they are off', () => {
    const steppers = elementsOf('app/rentals/new.tsx', (el, sf) => {
      const press = attrText(el, 'onPress', sf) ?? '';
      return tagOf(el, sf) === 'Pressable' && /(addOne|removeOne)\(it\)/.test(press);
    });
    expect(steppers.map((s) => attrText(s.el, 'accessibilityLabel', s.sf))).toEqual([
      '`Remove one ${itemName}`',
      '`Add one ${itemName}`',
    ]);
    expect(steppers.map((s) => attrText(s.el, 'accessibilityState', s.sf))).toEqual([
      '{ disabled: qty === 0 }',
      '{ disabled: qty >= avail }',
    ]);
    // The same name the row shows.
    expect(readSource(path.join(MOBILE_ROOT, 'app/rentals/new.tsx'))).toContain(
      "const itemName = it.name ?? 'Untitled item';",
    );
  });

  it('a warehouse chip reads its name and whether it is the one chosen', () => {
    const chips = elementsOf('app/rentals/new.tsx', (el, sf) => attrText(el, 'onPress', sf) === '() => setWarehouseId(w.id)');
    expect(chips).toHaveLength(1);
    const [chip] = chips;
    expect(attrText(chip!.el, 'accessibilityLabel', chip!.sf)).toBe('w.name');
    expect(attrText(chip!.el, 'accessibilityState', chip!.sf)).toBe('{ selected: active }');
  });

  it('IconChip announces a labelled chip as a button', () => {
    const sf = parseTsx(readSource(path.join(MOBILE_ROOT, 'src/components/ui/row.tsx')), 'row.tsx');
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'IconChip',
    );
    expect(fn).toBeDefined();
    const pressables: JsxNode[] = [];
    walkJsx(fn!, (el) => {
      if (tagOf(el, sf) === 'Pressable') pressables.push(el);
    });
    expect(pressables).toHaveLength(1);
    expect(attrText(pressables[0]!, 'accessibilityRole', sf)).toBe("accessibilityLabel ? 'button' : undefined");
    expect(attrText(pressables[0]!, 'accessibilityLabel', sf)).toBe('accessibilityLabel');
  });
});
