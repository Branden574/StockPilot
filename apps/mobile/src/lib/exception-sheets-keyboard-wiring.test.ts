import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, readSource, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * THE KEYBOARD IN THE EXCEPTION SHEETS (R1 walk, 2026-09-29, iPhone 17 at
 * AX5): WIRING PINS.
 *
 * The finding: with the keyboard up, the Acknowledge sheet's focused note was
 * not moved into view (0 of 94 pt showed when the person tapped the field as
 * soon as it appeared, 84 of 94 after scrolling it fully into view first),
 * and nothing but Acknowledge or Close put the keyboard away: a drag on the
 * body and a tap on the title did nothing. The photo sheets had the same
 * keyboard and, on main's fixed-height body, ran off the top of the screen at
 * AX5 with the keyboard up, taking the title and Close with them.
 *
 * Each sheet with a note field (Acknowledge / Add note / Confirm this count;
 * Add a photo; Remove this photo?) now:
 *   1. scrolls the focused note back into view when the body's window changes
 *      under it (lib/use-sheet-keyboard.ts over the pure
 *      lib/sheet-field-reveal.ts): the body reports its scroll offset, its
 *      window and its content height; the note's block and the field report
 *      where they sit; the field reports focus and blur;
 *   2. puts the keyboard away on a drag of the body (keyboardDismissMode
 *      "on-drag", the app's list screens' setting) and on a tap anywhere on
 *      the card outside the field and its buttons (the card claims the touch
 *      only while the keyboard is up; the backdrop stays a sibling behind the
 *      card, so the sheet rules in sheet-backdrop-guard.test.ts hold);
 *   3. is never taller than the space above the keyboard (the photo sheets
 *      now size themselves like the Acknowledge sheet, exception-sheet-layout).
 *
 * The mobile suite has no React Native renderer, so the tree each sheet
 * declares is read with the TypeScript parser and the wiring is asserted on
 * the elements themselves; the reveal logic is tested for behaviour in
 * sheet-field-reveal.test.ts, and the whole was walked on the simulator.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

type Tree = { sf: ts.SourceFile; fn: ts.FunctionDeclaration; nodes: { el: JsxNode; ancestors: JsxNode[] }[] };

function treeOf(file: string, fnName: string): Tree {
  const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fnName,
  );
  if (!fn) throw new Error(`${file}: function ${fnName} not found`);
  const nodes: Tree['nodes'] = [];
  walkJsx(fn, (el, ancestors) => nodes.push({ el, ancestors: [...ancestors] }));
  return { sf, fn, nodes };
}

function only(t: Tree, tag: string): { el: JsxNode; ancestors: JsxNode[] } {
  const hits = t.nodes.filter((n) => tagOf(n.el, t.sf) === tag);
  expect(hits, `one <${tag}>`).toHaveLength(1);
  return hits[0]!;
}

const SHEETS = [
  { file: 'src/components/exception-note-sheet.tsx', fn: 'SheetContent', name: 'Acknowledge / Add note / Confirm' },
  { file: 'src/components/exception-evidence-sheets.tsx', fn: 'AddSheetContent', name: 'Add a photo' },
  { file: 'src/components/exception-evidence-sheets.tsx', fn: 'RemoveSheetContent', name: 'Remove this photo?' },
] as const;

describe.each(SHEETS)('$name sheet ($fn)', ({ file, fn }) => {
  const t = treeOf(file, fn);
  const a = (el: JsxNode, name: string) => attrText(el, name, t.sf);

  it('takes the sheet keyboard hook once per opening', () => {
    expect(t.fn.getText(t.sf)).toContain('const [attachBody, kb] = useSheetKeyboard();');
  });

  // Mutation caught: the body not reporting its window, offset or content,
  // so a shrink under the keyboard leaves the note where it fell.
  it('the body reports where it is scrolled, its window and its content, and scrolls through the hook', () => {
    const body = only(t, 'ScrollView').el;
    expect(a(body, 'ref')).toBe('attachBody');
    expect(a(body, 'onScroll')).toBe('kb.onBodyScroll');
    expect(a(body, 'scrollEventThrottle')).toBe('16');
    expect(a(body, 'onLayout')).toBe('kb.onBodyLayout');
    expect(a(body, 'onContentSizeChange')).toBe('kb.onBodyContentSizeChange');
  });

  // Mutation caught: a drag on the body leaves the keyboard up (the walk's
  // "a drag on the body reveals it; the keyboard cannot be put away").
  it('a drag on the body puts the keyboard away; a tap on its text still does, a tap on a control is kept', () => {
    const body = only(t, 'ScrollView').el;
    expect(a(body, 'keyboardDismissMode')).toBe('on-drag');
    expect(a(body, 'keyboardShouldPersistTaps')).toBe('handled');
  });

  it('the body is capped by the measured space and gives way first', () => {
    const style = a(only(t, 'ScrollView').el, 'style') ?? '';
    expect(style).toContain('maxHeight: layout.bodyMaxHeight');
    expect(style).toContain('flexShrink: 1');
    expect(style).not.toMatch(/maxHeight: \d/);
  });

  // Mutation caught: the field or its block not reporting where it sits, or
  // focus not reported, so there is nothing to scroll to.
  it('the note reports focus, blur and where it sits; its block sits directly in the body', () => {
    const input = only(t, 'TextInput');
    expect(a(input.el, 'onFocus')).toBe('kb.onNoteFocus');
    expect(a(input.el, 'onBlur')).toBe('kb.onNoteBlur');
    expect(a(input.el, 'onLayout')).toBe('kb.onNoteLayout');
    const block = input.ancestors.at(-1)!;
    expect(tagOf(block, t.sf)).toBe('View');
    expect(a(block, 'onLayout')).toBe('kb.onNoteBlockLayout');
    // The block's layout y is in the body's content only when its parent is
    // the ScrollView (the field's y is then relative to the block).
    const body = only(t, 'ScrollView').el;
    expect(input.ancestors.at(-2)).toBe(body);
  });

  // Mutation caught: a tap on the title (outside the body) leaving the
  // keyboard up, the walk's other half of the finding.
  it('a tap on the card outside the field and its buttons puts the keyboard away; the card stays a plain View', () => {
    const card = t.nodes.find((n) => (a(n.el, 'style') ?? '').includes('styles.sheet'));
    expect(card).toBeDefined();
    expect(tagOf(card!.el, t.sf)).toBe('View');
    expect(a(card!.el, 'onStartShouldSetResponder')).toBe('kb.claimTapOutside');
    expect(a(card!.el, 'onResponderRelease')).toBe('kb.onTapOutside');
    expect(a(card!.el, 'accessible')).toBeUndefined();
    expect(a(card!.el, 'style')).toContain('maxHeight: layout.sheetMaxHeight');
    // The backdrop is still the card's sibling, never its parent.
    expect(card!.ancestors.some((n) => /Pressable|Touchable/.test(tagOf(n, t.sf)))).toBe(false);
  });

  it('sizes the sheet to the space the keyboard leaves, below the status bar', () => {
    const src = t.fn.getText(t.sf);
    expect(src).toContain('const { height } = useWindowDimensions();');
    expect(src).toContain('const insets = useSafeAreaInsets();');
    expect(src).toMatch(
      /exceptionSheetLayout\(\{\s+windowHeight: height,\s+availableHeight,\s+topInset: insets\.top,\s+\}\)/,
    );
    const container = t.nodes.find((n) => a(n.el, 'accessibilityViewIsModal') === 'true');
    expect(container && a(container.el, 'onLayout')).toBe('(e) => setAvailableHeight(e.nativeEvent.layout.height)');
  });

  // Mutation caught: the field's text uncapped, so at AX5 its placeholder
  // wraps to four lines and the empty field is taller than the body.
  it('the note\'s text stops at the input ceiling, like every bordered input', () => {
    expect(a(only(t, 'TextInput').el, 'maxFontSizeMultiplier')).toBe('NOTE_FONT_CAP');
    expect(readSource(path.join(MOBILE_ROOT, file))).toContain('const NOTE_FONT_CAP = capTo(15, TYPE_CEILING.input);');
  });

  it('the title stops growing at the display ceiling', () => {
    const title = t.nodes.find((n) => a(n.el, 'accessibilityRole') === 'header');
    expect(title && a(title.el, 'maxFontSizeMultiplier')).toBe('TITLE_CAP');
  });
});

describe('the hook (lib/use-sheet-keyboard.ts)', () => {
  // Read in each test, so a missing hook fails these pins and not the file.
  const hook = () => readSource(path.join(MOBILE_ROOT, 'src/lib/use-sheet-keyboard.ts'));

  it('drives the pure revealer and scrolls the body, animated', () => {
    const src = hook();
    expect(src).toContain('createFieldRevealer(');
    expect(src).toContain('createFieldRevealer((y) => body?.scrollTo({ y, animated: true }))');
    expect(src).toContain('attachBody: (node: ScrollView | null) => {');
    expect(src).toContain('return [sheet.attachBody, handlers] as const;');
  });

  it('reports each measurement to the revealer', () => {
    const src = hook();
    expect(src).toContain('revealer.scrolled(e.nativeEvent.contentOffset.y)');
    expect(src).toContain('revealer.viewportChanged(e.nativeEvent.layout.height)');
    expect(src).toContain('revealer.contentChanged(h)');
    expect(src).toContain('revealer.blockLaid(e.nativeEvent.layout.y, e.nativeEvent.layout.height)');
    expect(src).toContain('revealer.fieldLaid(e.nativeEvent.layout.y, e.nativeEvent.layout.height)');
    expect(src).toContain('revealer.focus()');
    expect(src).toContain('revealer.blur()');
  });

  it('reveals again once the keyboard has shown, and unsubscribes', () => {
    const src = hook();
    expect(src).toMatch(/Keyboard\.addListener\('keyboardDidShow', \(\) => revealer\.keyboardShown\(\)\)/);
    expect(src).toContain('sub.remove()');
  });

  // Mutation caught: claiming every tap on the card (keyboard down too),
  // which changes nothing visible but takes touches the card never took.
  it('claims a tap outside only while the keyboard is up, and puts it away on release', () => {
    const src = hook();
    expect(src).toContain('claimTapOutside: () => Keyboard.isVisible()');
    expect(src).toContain('onTapOutside: () => Keyboard.dismiss()');
  });
});
