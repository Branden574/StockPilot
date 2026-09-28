import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, readSource, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * THE NEW MAINTENANCE REQUEST SCREEN'S BACK ARROW (2026-09-28).
 *
 * The header back arrow on app/maintenance/new.tsx, on the form and on its
 * gate screens (module off, no permission, a bad escalation link, no
 * workspace), was an IconChip with no label: VoiceOver found an unnamed
 * element with no button role, and its target was the 38pt chip, under the
 * 44pt iOS minimum. These read the element tree each file declares (the
 * mobile suite has no React Native renderer; same technique as
 * rental-screens-a11y.test.ts) and pin the name, the role and the target.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const FORM = 'app/maintenance/new.tsx';
const ROW = 'src/components/ui/row.tsx';

function load(file: string): { sf: ts.SourceFile; src: string } {
  const src = readSource(path.join(MOBILE_ROOT, file));
  return { sf: parseTsx(src, file), src };
}

function elementsOf(sf: ts.SourceFile, pred: (el: JsxNode) => boolean): JsxNode[] {
  const out: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (pred(el)) out.push(el);
  });
  return out;
}

describe('new maintenance request: the header back arrow', () => {
  // Mutation caught: either chip without its label, without the 44pt frame,
  // or pointed at something other than going back.
  it('both back chips (the form and the gate screen) say Back, go back, and take the 44pt frame', () => {
    const { sf } = load(FORM);
    const chips = elementsOf(sf, (el) => tagOf(el, sf) === 'IconChip');
    expect(chips.map((c) => attrText(c, 'icon', sf))).toEqual(['ArrowLeft', 'ArrowLeft']);
    expect(chips.map((c) => attrText(c, 'accessibilityLabel', sf))).toEqual(['Back', 'Back']);
    expect(chips.map((c) => attrText(c, 'onPress', sf))).toEqual(['goBack', 'onBack']);
    expect(chips.map((c) => attrText(c, 'minTap', sf))).toEqual(['true', 'true']);
    for (const c of chips) expect(attrText(c, 'hitSlop', sf)).toBeUndefined();
  });

  // The frame is 3pt wider than the chip on each side; the bar takes that
  // off its padding so the chip sits where every other screen's back chip
  // does (12pt in, 8pt down). Mutation caught: the padding restored to 12/8
  // (the chip drifts 3pt) or dropped by more than the frame adds.
  it('the bar keeps the chip where a plain 38pt chip sits', () => {
    const { src } = load(FORM);
    const bar = /topbar: \{\s+paddingHorizontal: (\d+),\s+paddingTop: (\d+),/.exec(src);
    expect(bar, 'topbar style').not.toBeNull();
    expect(Number(bar![1]) + 3).toBe(12);
    expect(Number(bar![2]) + 3).toBe(8);
  });
});

describe('IconChip: the 44pt frame', () => {
  const { sf, src } = load(ROW);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'IconChip',
  );

  it('MIN_TAP is at least 44, and the frame is MIN_TAP square', () => {
    const minTap = /const MIN_TAP = (\d+);/.exec(src);
    expect(minTap, 'MIN_TAP').not.toBeNull();
    expect(Number(minTap![1])).toBeGreaterThanOrEqual(44);
    expect(src).toMatch(/chipTapFrame: \{\s+width: MIN_TAP,\s+height: MIN_TAP,/);
  });

  // Mutation caught: minTap accepted and ignored (the frame never applied),
  // or the target widened with hitSlop, which VoiceOver's outline does not
  // show.
  it('with minTap the one button is the frame, with the chip inside it; no hitSlop', () => {
    expect(fn).toBeDefined();
    const pressables = elementsOf(sf, (el) => tagOf(el, sf) === 'Pressable').filter(
      (el) => el.getStart(sf) >= fn!.getStart(sf) && el.getEnd() <= fn!.getEnd(),
    );
    expect(pressables).toHaveLength(1);
    const [p] = pressables;
    expect(attrText(p!, 'style', sf)).toContain('minTap ? styles.chipTapFrame : chipStyle');
    expect(attrText(p!, 'hitSlop', sf)).toBeUndefined();
    expect(src).toContain('{minTap ? <View style={chipStyle}>{face}</View> : face}');
  });
});
