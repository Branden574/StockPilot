import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attrText,
  hasContent,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * STRUCTURE PINS: each converted sheet exposes its fields and buttons to
 * VoiceOver as SEPARATE elements.
 *
 * The mobile suite has no React Native renderer (vitest runs pure modules in
 * node; there is no @testing-library/react-native), so this reads the element
 * tree the screen declares, with the TypeScript parser, and asserts the shape
 * that decides what iOS exposes:
 *
 *  - An element is folded into its nearest ACCESSIBLE ancestor. A Pressable is
 *    accessible by default; a plain View is not. So a TextInput or a Button is
 *    its own VoiceOver element exactly when no ancestor is a touchable or a
 *    View marked `accessible`.
 *  - The scrim is a separate element, so it must say what it does: a "Close"
 *    button.
 *  - `accessibilityViewIsModal` on the container keeps VoiceOver inside the
 *    open sheet (iOS; it also stops Fabric flattening the container away).
 *  - The scrim sets `onAccessibilityTap` to its close handler. In RN 0.86
 *    Fabric, RCTViewComponentView `accessibilityActivate` returns YES only
 *    when that prop is set (Pressable does not add it). Otherwise UIKit falls
 *    back to a synthetic touch at the CENTRE of the scrim's frame, which is
 *    the container's centre, and hit-testing picks the card whenever the card
 *    covers that point (every centred dialog; Adjust stock with the keyboard
 *    up). The "Close" element then did not close. The container sets
 *    `onAccessibilityEscape` to the same handler (two-finger scrub).
 *  - Every other control in the card is announced as a button with a name.
 *
 * The defect this pins (simulator walk 2026-09-25): the Adjust stock card was
 * a `Pressable onPress={() => undefined}` inside a scrim Pressable, and
 * VoiceOver read the whole sheet as one label with the CHANGE field and the
 * Confirm button unreachable.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

type Tree = { sf: ts.SourceFile; nodes: { el: JsxNode; ancestors: JsxNode[] }[] };

function treeOf(file: string, root?: ts.Node): Tree {
  const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
  const nodes: Tree['nodes'] = [];
  walkJsx(root ?? sf, (el, ancestors) => nodes.push({ el, ancestors: [...ancestors] }));
  return { sf, nodes };
}

function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (!fn) throw new Error(`function ${name} not found`);
  return fn;
}

function jsxChildren(el: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(el)) return [];
  return el.children.filter(
    (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
  );
}

/** The text a node renders, flattened: JSX text plus string literals inside expressions. */
function textOf(node: ts.Node, sf: ts.SourceFile): string {
  let out = '';
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) out += n.text;
    else if (ts.isStringLiteral(n) && !ts.isJsxAttribute(n.parent)) out += n.text;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out.replace(/\s+/g, ' ').trim();
}

/** Why this element is NOT its own VoiceOver element, or null when it is. */
function collapsedBy(ancestors: JsxNode[], sf: ts.SourceFile): string | null {
  for (const a of ancestors) {
    const tag = tagOf(a, sf);
    if (TOUCHABLE_TAG.test(tag)) return `inside <${tag}>`;
    const accessible = attrText(a, 'accessible', sf);
    if (accessible !== undefined && accessible !== 'false') return `inside <${tag} accessible>`;
  }
  return null;
}

type SheetShape = { container: JsxNode; scrim: JsxNode; next: JsxNode; card: JsxNode };

/** Container -> [scrim, card] (bottom sheet) or [scrim, box-none layer -> card] (centred dialog). */
function shapeAround(anchor: { el: JsxNode; ancestors: JsxNode[] }, sf: ts.SourceFile): SheetShape {
  const idx = anchor.ancestors.findIndex((a) => attrText(a, 'accessibilityViewIsModal', sf) === 'true');
  if (idx < 0) throw new Error('no accessibilityViewIsModal container above the anchor');
  const container = anchor.ancestors[idx]!;
  const [scrim, next, ...rest] = jsxChildren(container);
  if (!scrim || !next || rest.length > 0) throw new Error('container must hold exactly [scrim, sheet]');
  const layered = attrText(next, 'pointerEvents', sf) === 'box-none';
  const card = layered ? jsxChildren(next)[0] : next;
  if (!card) throw new Error('no card');
  return { container, scrim, next, card };
}

describe('Adjust stock sheet (app/item/[id].tsx AdjustModalContent)', () => {
  const file = 'app/item/[id].tsx';
  const base = treeOf(file);
  const { sf } = base;
  const { nodes } = treeOf(file, functionNamed(sf, 'AdjustModalContent'));

  const find = (pred: (el: JsxNode) => boolean, what: string) => {
    const hits = nodes.filter((n) => pred(n.el));
    if (hits.length !== 1) throw new Error(`${what}: expected 1, found ${hits.length}`);
    return hits[0]!;
  };
  const changeField = find(
    (el) => tagOf(el, sf) === 'TextInput' && attrText(el, 'value', sf) === 'delta',
    'CHANGE field',
  );
  const reasonField = find(
    (el) => tagOf(el, sf) === 'TextInput' && attrText(el, 'value', sf) === 'reason',
    'REASON field',
  );
  const cancel = find((el) => tagOf(el, sf) === 'Button' && textOf(el, sf) === 'Cancel', 'Cancel');
  const confirm = find(
    (el) => tagOf(el, sf) === 'Button' && textOf(el, sf).includes('Confirm'),
    'Confirm',
  );
  const controls = { changeField, reasonField, cancel, confirm };
  // Resolved inside each test, so a regression reports which pin broke
  // instead of failing the whole file at collection time.
  const shapeOf = () => shapeAround(changeField, sf);

  it.each(Object.keys(controls))('%s is its own accessibility element', (key) => {
    const n = controls[key as keyof typeof controls];
    expect(collapsedBy(n.ancestors, sf)).toBeNull();
  });

  it('both fields and both buttons sit in the card, and the card is a plain View', () => {
    const shape = shapeOf();
    for (const n of Object.values(controls)) expect(n.ancestors).toContain(shape.card);
    expect(tagOf(shape.card, sf)).toBe('View');
    for (const prop of ['onPress', 'onLongPress', 'accessible', 'onStartShouldSetResponder']) {
      expect(attrText(shape.card, prop, sf)).toBeUndefined();
    }
  });

  it('the scrim is a separate, childless "Close" button behind the card', () => {
    const { scrim, container, card } = shapeOf();
    expect(tagOf(scrim, sf)).toBe('Pressable');
    expect(hasContent(scrim)).toBe(false);
    expect(attrText(scrim, 'onPress', sf)).toBe('onClose');
    // A VoiceOver double-tap calls this directly instead of tapping the
    // scrim's centre, which this card covers once the keyboard is up.
    expect(attrText(scrim, 'onAccessibilityTap', sf)).toBe('onClose');
    expect(attrText(scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(scrim, 'style', sf)).toContain('StyleSheet.absoluteFill');
    // Painted first, so the card covers it: a tap on the card never reaches it.
    const kids = jsxChildren(container);
    expect(kids).toHaveLength(2);
    expect(kids[0]).toBe(scrim);
    expect(kids[1]).toBe(card);
  });

  it('the container keeps VoiceOver inside the sheet and sits in the keyboard wrapper', () => {
    const { container } = shapeOf();
    expect(tagOf(container, sf)).toBe('View');
    expect(attrText(container, 'accessibilityViewIsModal', sf)).toBe('true');
    expect(attrText(container, 'onAccessibilityEscape', sf)).toBe('onClose');
    const style = attrText(container, 'style', sf) ?? '';
    expect(style).toContain('flex: 1');
    expect(style).toContain("justifyContent: 'flex-end'");
    const parent = changeField.ancestors[changeField.ancestors.indexOf(container) - 1];
    expect(parent && tagOf(parent, sf)).toBe('KeyboardAvoidingView');
  });

  it('keeps the look: same scrim colour per theme, same card shape', () => {
    const shape = shapeOf();
    expect(attrText(shape.scrim, 'style', sf)).toContain(
      "mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'",
    );
    const card = attrText(shape.card, 'style', sf) ?? '';
    for (const piece of [
      'backgroundColor: c.card',
      'borderTopLeftRadius: 24',
      'borderTopRightRadius: 24',
      'paddingTop: 12',
      'paddingBottom: 36',
      'paddingHorizontal: 22',
      'SHADOW.sheet',
    ]) {
      expect(card).toContain(piece);
    }
  });

  it('the Button primitive is itself one element (a Pressable root, never accessible={false}) announced as a button', () => {
    const btn = treeOf('src/components/ui/button.tsx');
    const root = btn.nodes.find((n) => n.ancestors.length === 0);
    expect(root && tagOf(root.el, btn.sf)).toBe('Pressable');
    expect(root && attrText(root.el, 'accessible', btn.sf)).toBeUndefined();
    expect(root && attrText(root.el, 'accessibilityRole', btn.sf)).toBe('button');
  });
});

/**
 * Every converted spot, by the heading its card shows. `layout` pins the
 * geometry each one had before: bottom sheets anchor the card at the foot of
 * the container; centred dialogs keep their 24pt inset on a box-none layer so
 * the scrim still dims the whole screen.
 */
const CONVERTED: {
  file: string;
  heading: string;
  layout: 'bottom' | 'centred';
  close: string;
  scrim: string;
}[] = [
  { file: 'app/item/[id].tsx', heading: 'EDIT NOTE', layout: 'bottom', close: 'onClose', scrim: "'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'" },
  { file: 'app/item/[id].tsx', heading: 'ADJUST STOCK', layout: 'bottom', close: 'onClose', scrim: "'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'" },
  { file: 'app/item/[id].tsx', heading: 'SET STATUS', layout: 'bottom', close: 'onClose', scrim: "'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'" },
  { file: 'app/item/[id].tsx', heading: 'ADD SERIALS', layout: 'bottom', close: 'onClose', scrim: "'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'" },
  { file: 'app/order/[id].tsx', heading: 'Customer signature', layout: 'centred', close: '() => setSigOpen(false)', scrim: "'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)'" },
  { file: 'app/order/[id].tsx', heading: 'Deny this request?', layout: 'centred', close: 'dismissDenyModal', scrim: "'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)'" },
  { file: 'app/order/[id].tsx', heading: 'Reopen picking?', layout: 'centred', close: 'dismissReopenModal', scrim: "'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)'" },
  { file: 'src/components/biometric-optin-sheet.tsx', heading: 'ONE-TAP SIGN-IN', layout: 'bottom', close: 'onDismiss', scrim: "'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'" },
];

describe.each(CONVERTED)('$file — "$heading"', ({ file, heading, layout, close, scrim }) => {
  const { sf, nodes } = treeOf(file);
  const anchors = nodes.filter(
    (n) => jsxChildren(n.el).length === 0 && textOf(n.el, sf).includes(heading),
  );

  it('has one heading to anchor on', () => {
    expect(anchors).toHaveLength(1);
  });

  const anchor = () => {
    if (anchors.length !== 1) throw new Error(`heading "${heading}" found ${anchors.length} times`);
    return anchors[0]!;
  };
  const shapeOf = () => shapeAround(anchor(), sf);

  it('the scrim is a childless, labelled Close button that closes the sheet', () => {
    const shape = shapeOf();
    expect(tagOf(shape.scrim, sf)).toBe('Pressable');
    expect(hasContent(shape.scrim)).toBe(false);
    expect(attrText(shape.scrim, 'onPress', sf)).toBe(close);
    expect(attrText(shape.scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(shape.scrim, 'accessibilityLabel', sf)).toBe('Close');
    const style = attrText(shape.scrim, 'style', sf) ?? '';
    expect(style).toContain('StyleSheet.absoluteFill');
    expect(style).toContain(scrim);
  });

  it('a VoiceOver double-tap on the scrim closes (onAccessibilityTap), and so does the escape scrub', () => {
    const shape = shapeOf();
    // Same handler as onPress: without it iOS injects a tap at the scrim's
    // centre, and the card sits on that point in this sheet or dialog.
    expect(attrText(shape.scrim, 'onAccessibilityTap', sf)).toBe(close);
    expect(attrText(shape.container, 'onAccessibilityEscape', sf)).toBe(close);
  });

  it('every button in the card is announced as a button with a name', () => {
    const shape = shapeOf();
    const buttons = nodes.filter(
      (n) => n.ancestors.includes(shape.card) && ['Button', 'Pressable'].includes(tagOf(n.el, sf)),
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      const tag = tagOf(b.el, sf);
      const where = `${tag} at line ${sf.getLineAndCharacterOfPosition(b.el.getStart(sf)).line + 1}`;
      const name = attrText(b.el, 'accessibilityLabel', sf) ?? textOf(b.el, sf);
      expect(name, `${where} has no accessible name`).not.toBe('');
      // The Button primitive carries the role itself (pinned above).
      if (tag === 'Pressable') {
        expect(attrText(b.el, 'accessibilityRole', sf), `${where} has no button role`).toBe('button');
      }
    }
  });

  it('nothing between the container and the card content is a touchable', () => {
    // Checked before the shape lookup, so the pre-fix tree fails HERE with
    // the reason ("inside <Pressable>"), not with a missing container.
    expect(collapsedBy(anchor().ancestors, sf)).toBeNull();
    const shape = shapeOf();
    expect(tagOf(shape.card, sf)).toBe('View');
    expect(collapsedBy([shape.container, shape.next, shape.card], sf)).toBeNull();
    // Every control in the card: fields, buttons and inner Pressables stay
    // reachable on their own.
    const controls = nodes.filter(
      (n) =>
        n.ancestors.includes(shape.card) &&
        ['TextInput', 'Button', 'Pressable'].includes(tagOf(n.el, sf)),
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const ctl of controls) {
      const above = ctl.ancestors.slice(ctl.ancestors.indexOf(shape.card));
      expect(collapsedBy(above, sf)).toBeNull();
    }
    const card = nodes.find((n) => n.el === shape.card)!;
    expect(card.ancestors).toContain(shape.container);
  });

  it(`keeps the ${layout} layout`, () => {
    const shape = shapeOf();
    const containerStyle = attrText(shape.container, 'style', sf) ?? '';
    if (layout === 'bottom') {
      expect(shape.next).toBe(shape.card);
      // biometric-optin-sheet names the same style `styles.container`.
      expect(
        containerStyle.includes("justifyContent: 'flex-end'") ||
          containerStyle === 'styles.container',
      ).toBe(true);
    } else {
      expect(attrText(shape.next, 'pointerEvents', sf)).toBe('box-none');
      const layer = attrText(shape.next, 'style', sf) ?? '';
      expect(layer).toContain("justifyContent: 'center'");
      expect(layer).toContain('padding: 24');
      // The scrim's parent is unpadded, so it dims the full screen.
      expect(containerStyle).not.toContain('padding');
      expect(attrText(shape.card, 'style', sf)).toBe(
        '{ backgroundColor: c.card, borderRadius: 16, padding: 18, gap: 12 }',
      );
    }
  });
});

it('the Customer signature X is a button named "Close" (an icon has no text to read)', () => {
  const file = 'app/order/[id].tsx';
  const { sf, nodes } = treeOf(file);
  const xs = nodes.filter(
    (n) =>
      tagOf(n.el, sf) === 'Pressable' &&
      attrText(n.el, 'onPress', sf) === '() => setSigOpen(false)' &&
      jsxChildren(n.el).some((ch) => tagOf(ch, sf) === 'X'),
  );
  expect(xs).toHaveLength(1);
  expect(attrText(xs[0]!.el, 'accessibilityRole', sf)).toBe('button');
  expect(attrText(xs[0]!.el, 'accessibilityLabel', sf)).toBe('Close');
});

it('biometric-optin-sheet keeps its bottom-anchored container style', () => {
  const src = readSource(path.join(MOBILE_ROOT, 'src/components/biometric-optin-sheet.tsx'));
  expect(src).toMatch(/container: \{\s*flex: 1,\s*justifyContent: 'flex-end',\s*\}/);
});

describe('Adjust stock sheet: text fields have spoken names', () => {
  it('CHANGE and REASON fields carry accessibilityLabel, so VoiceOver does not read the placeholder', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8');
    expect(src).toMatch(/placeholder="e\.g\. -3 or 12"\s*\n\s*accessibilityLabel="Change, plus adds, minus removes"/);
    expect(src).toMatch(/placeholder="Cycle count variance, damage, etc\."\s*\n\s*accessibilityLabel="Reason, optional"/);
  });
});
