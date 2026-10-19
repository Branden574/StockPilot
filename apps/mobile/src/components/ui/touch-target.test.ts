import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  attrText,
  listTsx,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from '../../lib/__fixtures__/jsx-touch-audit';
import { palette } from '../../lib/theme';
import { BUTTON_MIN_TARGET, Button, splitButtonStyle } from './button';
import { CHIP_MIN_TARGET, Chip } from './chip';
import { PAGER_BUTTON_SIZE, PAGER_MIN_TARGET, Paginator } from './paginator';
import { TOGGLE_MIN_TARGET, TOGGLE_TRACK, Toggle } from './toggle';

/**
 * THE 44pt TOUCH TARGET IN THE PHONE PRIMITIVES (redesign package P2.5c).
 *
 * Button size sm, a Chip that is a control, the Toggle and the Paginator's
 * page buttons and arrows were drawn at 36pt (28pt for the switch) with no
 * 44pt target, or with a hitSlop the row clipped. Each is now a 44pt frame
 * (the Pressable) with the drawn box centred in it, so it looks as it did.
 *
 * The mobile suite has no React Native renderer (the checkbox.test.ts
 * method): react-native, the lucide icons and the text primitives are
 * stand-ins that are only their names, and the components are called as
 * plain functions, so each hands back the element tree it would draw with
 * the style and accessibility props the layout and VoiceOver read.
 */

const rn = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' | null }));
vi.mock('react-native', () => {
  const flatten = (s: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(s)) return Object.assign({}, ...s.map((x) => flatten(x) ?? {}));
    return typeof s === 'object' && s !== null ? { ...(s as Record<string, unknown>) } : undefined;
  };
  return {
    Pressable: 'Pressable',
    View: 'View',
    Text: 'Text',
    StyleSheet: { create: (styles: unknown) => styles, flatten },
    useColorScheme: () => rn.scheme,
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
  };
});
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
}));
vi.mock('./text', () => ({ Mono: 'Mono', Body: 'Body' }));

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const at = (file: string) => path.join(MOBILE_ROOT, file);

// ── The element tree ─────────────────────────────────────────────────────

type Props = { children?: unknown; [key: string]: unknown };
type Node = { type: unknown; props: Props };

function isNode(n: unknown): n is Node {
  return typeof n === 'object' && n !== null && 'type' in n && 'props' in n;
}

/** Runs the primitives' own components (and a Pressable's function child,
 *  with its press state) so the tree shows what they draw. */
function drawn(n: unknown, pressed = false): unknown {
  if (Array.isArray(n)) return n.map((x) => drawn(x, pressed));
  if (!isNode(n)) return n;
  if (typeof n.type === 'function') {
    return drawn((n.type as (p: Props) => unknown)(n.props), pressed);
  }
  let children = n.props.children;
  if (typeof children === 'function')
    children = (children as (s: { pressed: boolean }) => unknown)({ pressed });
  return { type: n.type, props: { ...n.props, children: drawn(children, pressed) } };
}

/** Every element of one type in a tree, outermost first. */
function every(n: unknown, type: unknown): Node[] {
  const out: Node[] = [];
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      x.forEach(visit);
      return;
    }
    if (!isNode(x)) return;
    if (x.type === type) out.push(x);
    visit(x.props.children);
  };
  visit(n);
  return out;
}

/** The element children of a node (fragments and arrays opened up). */
function kids(n: Node): Node[] {
  const out: Node[] = [];
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(visit);
    else if (isNode(x) && x.type === Symbol.for('react.fragment')) visit(x.props.children);
    else if (isNode(x)) out.push(x);
  };
  visit(n.props.children);
  return out;
}

/** A style prop (object, array, or Pressable's function of its press state)
 *  as one object. */
function flat(style: unknown, pressed = false): Record<string, unknown> {
  const s =
    typeof style === 'function'
      ? (style as (st: { pressed: boolean }) => unknown)({ pressed })
      : style;
  if (Array.isArray(s)) return Object.assign({}, ...s.map((x: unknown) => flat(x, pressed)));
  return typeof s === 'object' && s !== null ? { ...(s as Record<string, unknown>) } : {};
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** The height a frame takes in its row: its minimum less any negative
 *  vertical margins that give space back. */
function footprint(style: Record<string, unknown>): number {
  const mv = num(style.marginVertical);
  const top = num(style.marginTop ?? mv);
  const bottom = num(style.marginBottom ?? mv);
  return Math.max(num(style.minHeight), num(style.height)) + top + bottom;
}

const LIGHT = palette('light');

// ── 1. Button size sm ────────────────────────────────────────────────────

function button(props: Partial<Parameters<typeof Button>[0]> = {}, pressed = false): Node {
  return drawn(
    Button({ children: 'Try again', onPress: () => undefined, size: 'sm', ...props }),
    pressed,
  ) as Node;
}

/** What the sm Pressable drew before P2.5c (button.tsx at 9079cf659), the
 *  look the drawn button must keep. */
const SM_LOOK_BEFORE = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderWidth: 1,
  minHeight: 36,
  paddingVertical: 6,
  paddingHorizontal: 14,
  borderRadius: 10,
  backgroundColor: LIGHT.ink,
  borderColor: LIGHT.ink,
  opacity: 1,
  transform: [{ scale: 1 }],
};

describe('Button size sm: a 44pt target round the 36pt button', () => {
  it('the Pressable is a frame at least 44pt each way, still the one button VoiceOver hears', () => {
    const root = button();
    expect(root.type).toBe('Pressable');
    expect(root.props.accessibilityRole).toBe('button');
    const frame = flat(root.props.style);
    expect(BUTTON_MIN_TARGET).toBe(44);
    expect(frame.minHeight).toBe(44);
    expect(frame.minWidth).toBe(44);
    expect(frame.justifyContent).toBe('center');
    // The frame draws nothing: no fill, no border, no press scale.
    expect(frame.backgroundColor).toBeUndefined();
    expect(frame.borderWidth).toBeUndefined();
    expect(frame.transform).toBeUndefined();
  });

  it('the drawn button inside looks exactly as the 36pt button did', () => {
    const [face] = kids(button());
    expect(face?.type).toBe('View');
    expect(flat(face!.props.style)).toEqual(SM_LOOK_BEFORE);
    // The label is the same Text, on one line, under the control cap.
    const [label] = every(face, 'Text');
    expect(label!.props.numberOfLines).toBe(1);
    expect(label!.props.children).toBe('Try again');
  });

  it('a press scales the drawn button, never the frame', () => {
    const root = button({}, true);
    expect(flat(root.props.style, true).transform).toBeUndefined();
    expect(flat(kids(root)[0]!.props.style).transform).toEqual([{ scale: 0.98 }]);
  });

  it('disabled dims the drawn button and the frame takes no tap', () => {
    const root = button({ disabled: true });
    expect(root.props.disabled).toBe(true);
    expect(root.props.onPress).toBeUndefined();
    expect(flat(kids(root)[0]!.props.style).opacity).toBe(0.5);
  });

  it("a caller's style: placement on the frame, look on the drawn button", () => {
    // app/item/[id].tsx Restore, and every screen's `minHeight: MIN_TAP`.
    const restore = button({ style: { marginTop: 12, alignSelf: 'flex-start', minHeight: 44 } });
    expect(flat(restore.props.style)).toMatchObject({
      marginTop: 12,
      alignSelf: 'flex-start',
      minHeight: 44,
    });
    const face = flat(kids(restore)[0]!.props.style);
    expect(face.minHeight).toBe(44); // the 44pt button those screens drew stays 44pt
    expect(face.marginTop).toBeUndefined();
    expect(face.alignSelf).toBeUndefined();
    // recurring-pos.tsx styles.delete.
    const del = splitButtonStyle({
      minHeight: 44,
      alignSelf: 'flex-start',
      paddingHorizontal: 0,
      marginTop: 4,
    });
    expect(del).toEqual({
      frame: { alignSelf: 'flex-start', marginTop: 4 },
      drawn: { minHeight: 44, paddingHorizontal: 0 },
    });
  });

  it('block and a flex width reach the drawn button through the frame (it stretches across it)', () => {
    const root = button({ block: true, style: { flex: 1 } });
    expect(flat(root.props.style)).toMatchObject({ width: '100%', flex: 1 });
    // A column frame with the default stretch: no alignItems that would
    // shrink the drawn button to its label.
    expect(flat(root.props.style).alignItems).toBeUndefined();
    expect(flat(kids(root)[0]!.props.style).flex).toBeUndefined();
  });

  it('size md is unchanged: the Pressable is the 52pt button itself, no frame', () => {
    const root = button({ size: 'md' });
    const style = flat(root.props.style);
    expect(style.minHeight).toBe(52);
    expect(style.paddingHorizontal).toBe(20);
    expect(style.borderRadius).toBe(14);
    expect(every(root, 'View').some((v) => flat(v.props.style).borderRadius !== undefined)).toBe(
      false,
    );
  });

  // Every sm Button on a screen keeps its look: no caller hands the drawn
  // button a key the split would move off it (a height or width cap on the
  // frame would squeeze the 44pt target).
  it('no screen passes an sm Button a style that would cap its 44pt frame', () => {
    const files = listTsx(at('app'), at('src')).filter((f) => !f.includes('components/ui/'));
    const smButtons: string[] = [];
    for (const file of files) {
      const src = readSource(file);
      if (!src.includes('<Button')) continue;
      const sf = parseTsx(src, file);
      walkJsx(sf, (el: JsxNode) => {
        if (tagOf(el, sf) !== 'Button' || attrText(el, 'size', sf) !== 'sm') return;
        const style = attrText(el, 'style', sf) ?? '';
        smButtons.push(`${path.relative(MOBILE_ROOT, file)} ${style}`);
        expect(style, file).not.toMatch(/\b(?:height|maxHeight|maxWidth)\s*:/);
        expect(style, file).not.toMatch(/\bminWidth\s*:/);
      });
    }
    // The sweep is not vacuous (72 at 9079cf659).
    expect(smButtons.length).toBeGreaterThan(60);
    // The named local styles keep to the same rule.
    for (const [file, name] of [
      ['app/(drawer)/recurring-pos.tsx', 'delete'],
      ['app/group-selected.tsx', 'smallButton'],
      ['app/ungroup-selected.tsx', 'smallButton'],
      ['src/components/po-attachments.tsx', 'smallButton'],
      ['src/components/po-attachments.tsx', 'scanButton'],
    ] as const) {
      const block = new RegExp(`\\b${name}: \\{[^}]*\\}`).exec(readSource(at(file)))?.[0];
      expect(block, `${file} ${name}`).toBeDefined();
      expect(block).not.toMatch(/\b(?:height|maxHeight|maxWidth|minWidth)\s*:/);
    }
  });
});

// ── 2. Chip ──────────────────────────────────────────────────────────────

function chip(props: Partial<Parameters<typeof Chip>[0]> = {}): Node {
  return drawn(Chip({ label: 'DC4', active: false, onPress: () => undefined, ...props })) as Node;
}

describe('Chip: a control chip in a 44pt frame, a display chip as it was', () => {
  it('with onPress, the Pressable is a 44pt frame and the chip is centred in it at its own size', () => {
    const root = chip();
    expect(root.type).toBe('Pressable');
    expect(root.props.accessibilityRole).toBe('button');
    expect(root.props.accessibilityState).toEqual({ selected: false });
    const frame = flat(root.props.style);
    expect(CHIP_MIN_TARGET).toBe(44);
    expect(frame).toMatchObject({
      minHeight: 44,
      minWidth: 44,
      justifyContent: 'center',
      alignItems: 'center',
    });
    expect(frame.backgroundColor).toBeUndefined();
  });

  it('the drawn chip keeps the look it had: 9 / 12pt padding, radius 8, the sunk fill or the ink fill', () => {
    const idle = flat(kids(chip())[0]!.props.style);
    expect(idle).toEqual({
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: LIGHT.hair2,
      backgroundColor: LIGHT.sunk,
    });
    const chosen = chip({ active: true });
    expect(chosen.props.accessibilityState).toEqual({ selected: true });
    expect(flat(kids(chosen)[0]!.props.style)).toMatchObject({
      backgroundColor: LIGHT.ink,
      borderColor: LIGHT.ink,
    });
    const [label] = every(chosen, 'Mono');
    expect(label!.props).toMatchObject({ size: 12.5, color: LIGHT.card, children: 'DC4' });
  });

  it('a swatch chip keeps its ringed dot beside the label', () => {
    const dots = every(chip({ swatch: '#ff0000' }), 'View').filter(
      (v) => flat(v.props.style).width === 10,
    );
    expect(dots).toHaveLength(1);
    expect(flat(dots[0]!.props.style).backgroundColor).toBe('#ff0000');
  });

  it('without onPress it is display only: the chip alone, no frame and no button role', () => {
    const root = chip({ onPress: undefined });
    expect(root.type).toBe('View');
    expect(root.props.accessibilityRole).toBeUndefined();
    expect(every(root, 'Pressable')).toHaveLength(0);
    expect(flat(root.props.style).paddingVertical).toBe(9);
  });
});

// ── 3. Toggle ────────────────────────────────────────────────────────────

function toggle(props: Partial<Parameters<typeof Toggle>[0]> = {}, pressed = false): Node {
  return drawn(
    Toggle({
      value: true,
      onValueChange: () => undefined,
      accessibilityLabel: 'Face ID unlock',
      ...props,
    }),
    pressed,
  ) as Node;
}

describe('Toggle: a 44pt tall target round the 48 x 28 switch', () => {
  it('the Pressable is 44pt tall and still the switch VoiceOver hears', () => {
    const root = toggle();
    expect(root.type).toBe('Pressable');
    expect(root.props.accessibilityRole).toBe('switch');
    expect(root.props.accessibilityLabel).toBe('Face ID unlock');
    expect(root.props.accessibilityState).toEqual({ checked: true, disabled: false });
    expect(TOGGLE_MIN_TARGET).toBe(44);
    const frame = flat(root.props.style);
    expect(frame.minHeight).toBe(44);
    expect(frame).toMatchObject({ alignItems: 'center', justifyContent: 'center' });
  });

  it("the frame takes the track's 28pt in its row, so no settings or card row grows", () => {
    // -8pt above and below: 44 - 16 = 28, the height the 28pt Pressable took.
    expect(footprint(flat(toggle().props.style))).toBe(TOGGLE_TRACK.height);
  });

  it('the drawn switch is the 48 x 28 track with the 22pt knob, as before', () => {
    const [track] = kids(toggle());
    const t = flat(track!.props.style);
    expect(t).toMatchObject({ width: 48, height: 28, borderRadius: 999, opacity: 1 });
    const knob = flat(kids(track!)[0]!.props.style);
    expect(knob).toMatchObject({ width: 22, height: 22, top: 3, left: 23 });
    expect(flat(kids(kids(toggle({ value: false }))[0]!)[0]!.props.style).left).toBe(3);
    // A press dims the track, as it dimmed the old Pressable.
    expect(flat(kids(toggle({}, true))[0]!.props.style).opacity).toBe(0.85);
  });

  it('still dimmed and inert while the caller withholds onValueChange', () => {
    const root = toggle({ onValueChange: undefined });
    expect(root.props.disabled).toBe(true);
    expect(root.props.accessibilityState).toEqual({ checked: true, disabled: true });
  });
});

// ── 4. Paginator ─────────────────────────────────────────────────────────

function pager(page: number, pageCount: number, pressed = false): Node {
  return drawn(
    Paginator({
      page,
      pageCount,
      rangeStart: 1,
      rangeEnd: 50,
      total: 50 * pageCount,
      onPageChange: () => undefined,
    }),
    pressed,
  ) as Node;
}

/** The pager's button row (the View holding the Pressables). */
function buttonRow(root: Node): Node {
  const row = every(root, 'View').find((v) => flat(v.props.style).flexWrap === 'wrap');
  expect(row).toBeDefined();
  return row!;
}

/** iOS Dynamic Type at AX5. */
const AX5 = 3.57;
/** A conservative advance for an Inter Tight digit (tabular figures are
 *  about 0.56em; 0.62em errs wide). */
const DIGIT_EM = 0.62;

/** The width a page button or arrow is DRAWN at `fontScale`, read from the
 *  styles it renders: its fixed or least width, or its digits (capped at the
 *  chrome ceiling) plus its padding and its border each side when they make
 *  it wider. */
function drawnWidth(n: Node, fontScale: number): number {
  const face = kids(n)[0]!;
  const f = flat(face.props.style);
  const [digits] = every(face, 'Mono');
  let faceWidth = Math.max(num(f.width), num(f.minWidth));
  if (digits) {
    const p = digits.props as { size: number; maxFontSizeMultiplier: number; children: number };
    const scale = Math.min(fontScale, p.maxFontSizeMultiplier);
    const text = String(p.children).length * p.size * scale * DIGIT_EM;
    faceWidth = Math.max(faceWidth, text + 2 * num(f.paddingHorizontal) + 2 * num(f.borderWidth));
  }
  return faceWidth;
}

/** The width one child of the row takes at `fontScale`: the frame's
 *  minimum, or the drawn box plus the frame's padding each side when that is
 *  wider (Yoga counts padding inside minWidth). */
function childWidth(n: Node, fontScale: number): number {
  const style = flat(n.props.style);
  if (n.type !== 'Pressable') return num(style.width); // the "·" gap marker
  return Math.max(num(style.minWidth), drawnWidth(n, fontScale) + 2 * num(style.paddingHorizontal));
}

/** Flex-wrap lines of `widths` in `width` points with `gap` between items. */
function lines(widths: number[], width: number, gap: number): number[][] {
  const out: number[][] = [];
  let line: number[] = [];
  let used = 0;
  for (const w of widths) {
    const need = line.length ? used + gap + w : w;
    if (line.length && need > width) {
      out.push(line);
      line = [w];
      used = w;
    } else {
      line.push(w);
      used = need;
    }
  }
  if (line.length) out.push(line);
  return out;
}

/** The row before P2.5c: 36pt buttons and arrows, a 22pt marker, 6pt gaps. */
function widthsBefore(root: Node): number[] {
  return kids(buttonRow(root)).map((n) => (n.type === 'Pressable' ? 36 : 22));
}

/** Every pager shape: few pages, the windowed ellipses at each end and in
 *  the middle, and 3-digit pages. */
const SHAPES: [page: number, pageCount: number][] = [
  [1, 2],
  [1, 4],
  [2, 5],
  [3, 6],
  [4, 7],
  [1, 8],
  [5, 8],
  [8, 8],
  [5, 20],
  [50, 120],
  [120, 120],
];
/** Content widths: a 393pt and a 375pt phone, and a 320pt phone (iPhone SE
 *  1st gen or Display Zoom), less the lists' 20pt side padding. */
const WIDTHS = [393 - 40, 375 - 40, 320 - 40];

describe('Paginator: 44pt page buttons and arrows', () => {
  it('every page button and arrow is a 44 x 44 frame with the 36pt box centred in it, no hitSlop', () => {
    const presses = every(pager(5, 9), 'Pressable');
    // Page 5 of 9: the two arrows and 1, 4, 5, 6, 9 (two "·" markers between).
    expect(presses).toHaveLength(7);
    expect(PAGER_MIN_TARGET).toBe(44);
    for (const p of presses) {
      expect(p.props.hitSlop).toBeUndefined();
      expect(flat(p.props.style)).toMatchObject({
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 3,
        paddingVertical: 3,
        alignItems: 'center',
        justifyContent: 'center',
      });
      const face = flat(kids(p)[0]!.props.style);
      expect(Math.max(num(face.width), num(face.minWidth))).toBe(PAGER_BUTTON_SIZE);
      expect(Math.max(num(face.height), num(face.minHeight))).toBe(PAGER_BUTTON_SIZE);
      expect(face.borderRadius).toBe(8);
    }
  });

  it('keeps every word, role and state VoiceOver reads', () => {
    const presses = every(pager(5, 9), 'Pressable');
    expect(presses.map((p) => p.props.accessibilityLabel)).toEqual([
      'Previous page',
      'Page 1',
      'Page 4',
      'Page 5',
      'Page 6',
      'Page 9',
      'Next page',
    ]);
    for (const p of presses) expect(p.props.accessibilityRole).toBe('button');
    expect(
      presses.find((p) => p.props.accessibilityLabel === 'Page 5')!.props.accessibilityState,
    ).toEqual({ selected: true });
    const first = every(pager(1, 8), 'Pressable')[0]!;
    expect(first.props.disabled).toBe(true);
    expect(first.props.accessibilityState).toEqual({ disabled: true });
    expect(flat(kids(first)[0]!.props.style).opacity).toBe(0.3);
  });

  it('the drawn page button keeps its look: card fill and stronger border, the current page in ink', () => {
    const presses = every(pager(5, 8), 'Pressable');
    const idle = flat(
      kids(presses.find((p) => p.props.accessibilityLabel === 'Page 4')!)[0]!.props.style,
    );
    expect(idle).toMatchObject({
      backgroundColor: LIGHT.card,
      borderWidth: 1,
      borderColor: LIGHT.hair2,
      paddingHorizontal: 9,
      paddingVertical: 6,
    });
    const current = flat(
      kids(presses.find((p) => p.props.accessibilityLabel === 'Page 5')!)[0]!.props.style,
    );
    expect(current).toMatchObject({ backgroundColor: LIGHT.ink, borderWidth: 0 });
  });

  it('the frames sit edge to edge: the row has no gap', () => {
    const row = flat(buttonRow(pager(5, 8)).props.style);
    expect(row).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' });
    expect(row.gap ?? 0).toBe(0);
    expect(row.columnGap ?? 0).toBe(0);
  });

  it('on a 320pt phone, at the default size and at AX5, every control fits and both arrows are on screen', () => {
    for (const fontScale of [1, AX5]) {
      for (const [page, count] of SHAPES) {
        const row = kids(buttonRow(pager(page, count)));
        const widths = row.map((n) => childWidth(n, fontScale));
        for (const width of WIDTHS) {
          // flexWrap clips nothing so long as no one control is wider than
          // the line; the widest (a 3-digit page at AX5) is about 63pt.
          expect(
            Math.max(...widths),
            `${page}/${count} @${fontScale} in ${width}`,
          ).toBeLessThanOrEqual(width);
          const laid = lines(widths, width, 0);
          expect(laid.flat()).toHaveLength(row.length);
          expect(laid.length).toBeLessThanOrEqual(3);
        }
      }
    }
    expect(row0Labels()).toEqual(['Previous page', 'Next page']);
  });

  it('neighbouring drawn page buttons stand at least 6pt apart at every text size, as the old 6pt gap kept them', () => {
    // Before the frame had padding a page button its digits grew to 44pt or
    // wider filled its frame and touched the next one (0pt; 2-digit pages at
    // AX1 and up, 3-digit pages at the default size).
    for (const fontScale of [1, 1.35, 1.65, AX5]) {
      for (const [page, count] of SHAPES) {
        for (const n of kids(buttonRow(pager(page, count)))) {
          if (n.type !== 'Pressable') continue;
          // Each frame's spare width is split evenly round its centred box,
          // so two frames edge to edge leave this much between the boxes.
          const spare = childWidth(n, fontScale) - drawnWidth(n, fontScale);
          expect(
            spare,
            `${n.props.accessibilityLabel} ${page}/${count} @${fontScale}`,
          ).toBeGreaterThanOrEqual(6);
        }
      }
    }
    // The same 3pt each way keeps wrapped lines apart: a box taller than
    // 38pt (large digits) grows its frame rather than filling it.
    const frame = flat(every(pager(5, 8), 'Pressable')[0]!.props.style);
    expect(2 * num(frame.paddingVertical)).toBeGreaterThanOrEqual(6);
    expect(PAGER_MIN_TARGET - PAGER_BUTTON_SIZE).toBeGreaterThanOrEqual(6);
  });

  it('on a 393pt phone the row breaks into as many lines as it did with 36pt buttons; on a 375pt phone only a six-page pager gains one', () => {
    for (const [page, count] of SHAPES.filter(([, n]) => n < 100)) {
      const root = pager(page, count);
      const after = kids(buttonRow(root)).map((n) => childWidth(n, 1));
      const [w393, w375] = WIDTHS as [number, number];
      expect(lines(after, w393, 0).length, `${page}/${count} in ${w393}`).toBe(
        lines(widthsBefore(root), w393, 6).length,
      );
      // Eight controls (six pages and two arrows) were 330pt and fit a
      // 335pt line; they are 352pt now and take two.
      expect(lines(after, w375, 0).length, `${page}/${count} in ${w375}`).toBe(
        lines(widthsBefore(root), w375, 6).length + (count === 6 ? 1 : 0),
      );
    }
  });
});

/** The arrows' names, first and last in the row. */
function row0Labels(): string[] {
  const row = kids(buttonRow(pager(5, 8)));
  return [row[0]!, row[row.length - 1]!].map((n) => n.props.accessibilityLabel as string);
}

// ── 5. Pill's tone prop ──────────────────────────────────────────────────

describe("Pill's tone prop says who uses it", () => {
  it('the doc no longer names the serial statuses as its callers, and the prop stays', () => {
    const src = readSource(at('src/components/ui/pill.tsx'));
    const doc = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*tone\?:/.exec(src)?.[1] ?? '';
    expect(doc).not.toBe('');
    expect(doc).not.toMatch(/today the six serial-number statuses/);
    expect(doc).toMatch(/No screen passes it today/);
    expect(src).toMatch(/tone\?: \{ fg: string; bg: string; border: string \};/);
  });

  it('no screen passes it (the doc stays true)', () => {
    const files = listTsx(at('app'), at('src'));
    const callers: string[] = [];
    for (const file of files) {
      const src = readSource(file);
      if (!src.includes('<Pill')) continue;
      const sf = parseTsx(src, file);
      walkJsx(sf, (el: JsxNode) => {
        if (tagOf(el, sf) === 'Pill' && attrText(el, 'tone', sf) !== undefined) callers.push(file);
      });
    }
    expect(callers).toEqual([]);
  });
});
