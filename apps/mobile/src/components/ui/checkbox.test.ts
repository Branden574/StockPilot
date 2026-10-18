import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  TOUCHABLE_TAG,
  attr,
  attrText,
  listTsx,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from '../../lib/__fixtures__/jsx-touch-audit';
import { palette, type Palette } from '../../lib/theme';
import { AA_TEXT, AA_UI, contrast } from './__fixtures__/contrast';
import {
  CHECKBOX_LABEL_SIZE,
  CHECKBOX_MIN_TARGET,
  CHECKBOX_SIZE,
  Checkbox,
  CheckboxMark,
  checkboxLayout,
  checkboxTone,
  nextChecked,
  type CheckboxValue,
} from './checkbox';

/**
 * THE SHARED PHONE CHECKBOX (redesign package P2.5b; the owner: "make sure
 * our check boxes and grouping and ungrouping works in the redeisgn").
 *
 * The mobile suite has no React Native renderer, so react-native, the lucide
 * icons and the Body primitive are stand-ins below that are only their names.
 * The components are then plain functions: called here, each hands back the
 * element tree it would draw, with the props VoiceOver and the layout read.
 * The colours are measured in both modes with the contrast fixture (the
 * tones.test.ts method), and what a returned tree cannot show (no state hook,
 * no nested touchable, where the checkbox may be used) is read from the source
 * with the TypeScript compiler (the primitives-structure.test.ts method).
 */

const rn = vi.hoisted(() => ({
  scheme: 'light' as 'light' | 'dark' | null,
  fontScale: 1,
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
  useColorScheme: () => rn.scheme,
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: rn.fontScale }),
}));
vi.mock('lucide-react-native', () => ({ Check: 'Check', Minus: 'Minus' }));
vi.mock('./text', () => ({ Body: 'Body' }));

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const at = (file: string) => path.join(MOBILE_ROOT, file);
const FILE = 'src/components/ui/checkbox.tsx';

const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];
const each = (fn: (p: Palette, mode: Mode) => void) => {
  for (const mode of MODES) fn(palette(mode), mode);
};
const VALUES: CheckboxValue[] = [true, false, 'mixed'];
/** A WCAG ratio to two decimals, as the tables below are written. */
const ratio = (a: string, b: string) => Math.round(contrast(a, b) * 100) / 100;

/** The group review's acknowledgement (GROUP_COPY.acknowledgeFamily). */
const LABEL = 'Show product-family records in this group';

// ── The element tree ─────────────────────────────────────────────────────

type Props = { children?: unknown; [key: string]: unknown };
type Node = { type: unknown; props: Props };

function isNode(n: unknown): n is Node {
  return typeof n === 'object' && n !== null && 'type' in n && 'props' in n;
}

/** Runs the checkbox's own components so the tree shows what they draw; the
 *  stand-ins are names and stay as they are. */
function drawn(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(drawn);
  if (!isNode(n)) return n;
  if (typeof n.type === 'function') return drawn((n.type as (p: Props) => unknown)(n.props));
  return { type: n.type, props: { ...n.props, children: drawn(n.props.children) } };
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

/** A style prop (an object, an array, or Pressable's function of its press
 *  state) as one object. */
function flat(style: unknown, pressed = false): Record<string, unknown> {
  const s =
    typeof style === 'function'
      ? (style as (st: { pressed: boolean }) => unknown)({ pressed })
      : style;
  if (Array.isArray(s)) return Object.assign({}, ...s.map((x: unknown) => flat(x, pressed)));
  return typeof s === 'object' && s !== null ? { ...(s as Record<string, unknown>) } : {};
}

/** The 22pt boxes in a tree. */
const boxes = (tree: unknown) =>
  every(tree, 'View').filter((v) => flat(v.props.style).width === CHECKBOX_SIZE);

function checkbox(props: Partial<Parameters<typeof Checkbox>[0]> = {}): Node {
  return Checkbox({
    checked: false,
    onChange: () => undefined,
    label: LABEL,
    ...props,
  }) as unknown as Node;
}

function inMode<T>(mode: Mode, fn: () => T): T {
  const before = rn.scheme;
  rn.scheme = mode;
  try {
    return fn();
  } finally {
    rn.scheme = before;
  }
}

function atScale<T>(fontScale: number, fn: () => T): T {
  const before = rn.fontScale;
  rn.fontScale = fontScale;
  try {
    return fn();
  } finally {
    rn.fontScale = before;
  }
}

// ── The source ───────────────────────────────────────────────────────────

const sourceOf = (file: string) => parseTsx(readSource(at(file)), file);

function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (!fn) throw new Error(`${name} is not declared in ${sf.fileName}`);
  return fn;
}

/** The touchable elements one function of a file draws. */
function touchablesIn(file: string, name: string): string[] {
  const sf = sourceOf(file);
  const out: string[] = [];
  walkJsx(functionNamed(sf, name), (el) => {
    if (TOUCHABLE_TAG.test(tagOf(el, sf))) out.push(tagOf(el, sf));
  });
  return out;
}

/** Every element of a file that sets the JSX attribute `name`. */
function withAttribute(file: string, name: string): string[] {
  const sf = sourceOf(file);
  const out: string[] = [];
  walkJsx(sf, (el) => {
    if (attrText(el, name, sf) !== undefined) out.push(`<${tagOf(el, sf)} ${name}>`);
  });
  return out;
}

/** The hooks a file calls, `useX(...)` or `React.useX(...)`. */
function hookCalls(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (/^use[A-Z]/.test(name)) out.push(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceOf(file));
  return out;
}

type Use = { file: string; sf: ts.SourceFile; el: JsxNode; touchables: JsxNode[] };

/** Every `<tag>` in one source, with the touchables around it (outermost
 *  first). */
function usesIn(src: string, file: string, tag: 'Checkbox' | 'CheckboxMark'): Use[] {
  const out: Use[] = [];
  const sf = parseTsx(src, file);
  walkJsx(sf, (el, ancestors) => {
    if (tagOf(el, sf) !== tag) return;
    out.push({
      file,
      sf,
      el,
      touchables: ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf))),
    });
  });
  return out;
}

/** Every `<tag>` in app/ and src/. */
function usesOf(tag: 'Checkbox' | 'CheckboxMark'): Use[] {
  return listTsx(at('app'), at('src')).flatMap((abs) => {
    const src = readSource(abs);
    return src.includes(tag) ? usesIn(src, path.relative(MOBILE_ROOT, abs), tag) : [];
  });
}

function where(u: Use): string {
  const { line } = u.sf.getLineAndCharacterOfPosition(u.el.getStart(u.sf));
  return `${u.file}:${line + 1} <${tagOf(u.el, u.sf)}>`;
}

/** What an expression can come to: through parentheses, `as`, `satisfies`,
 *  `!` and both branches of a condition, so
 *  `selecting ? { checked: picked } : undefined` is the object or undefined. */
function outcomes(e: ts.Expression): ts.Expression[] {
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    return outcomes(e.expression);
  }
  if (ts.isConditionalExpression(e)) return [...outcomes(e.whenTrue), ...outcomes(e.whenFalse)];
  return [e];
}

/** What one JSX attribute can come to (nothing when it is absent or bare). */
function attrOutcomes(el: JsxNode, name: string, sf: ts.SourceFile): ts.Expression[] {
  const init = attr(el, name, sf)?.initializer;
  if (init && ts.isStringLiteral(init)) return [init];
  return init && ts.isJsxExpression(init) && init.expression ? outcomes(init.expression) : [];
}

/** The keys an object literal sets itself: `{ checked, disabled: off }` sets
 *  checked and disabled; `{ selected: row.checked }` sets only selected. */
function ownKeys(o: ts.ObjectLiteralExpression): string[] {
  return o.properties.flatMap((p) =>
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      ? [p.name.text]
      : [],
  );
}

/**
 * D29's rule for the row a mark sits in, read as code, not as words: the
 * innermost touchable around it can take the role "checkbox", and its
 * accessibilityState can be an object with `checked` as one of its own keys.
 * A state whose value is only named checked (`{ selected: row.checked }`, or
 * the shortfall sheet's `{ disabled: !row.checked || locked }`) and a role
 * whose condition only mentions the word (`kind === 'checkbox' ? 'button' :
 * 'radio'`) give VoiceOver "checkbox" with no state, or no checkbox at all.
 */
function announcedAsCheckbox(u: Use): boolean {
  const host = u.touchables[u.touchables.length - 1];
  if (!host) return false;
  const role = attrOutcomes(host, 'accessibilityRole', u.sf).some(
    (e) => ts.isStringLiteralLike(e) && e.text === 'checkbox',
  );
  const state = attrOutcomes(host, 'accessibilityState', u.sf).some(
    (e) => ts.isObjectLiteralExpression(e) && ownKeys(e).includes('checked'),
  );
  return role && state;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Checkbox: one VoiceOver element, a checkbox with its state and its name', () => {
  it('the root is its only Pressable: the checkbox role, and the label as the spoken name', () => {
    const el = checkbox();
    expect(el.type).toBe('Pressable');
    expect(el.props.accessibilityRole).toBe('checkbox');
    expect(el.props.accessibilityLabel).toBe(LABEL);
    const tree = drawn(el);
    expect(every(tree, 'Pressable')).toHaveLength(1);
    // The words on screen are the same label.
    const words = every(tree, 'Body');
    expect(words).toHaveLength(1);
    expect(words[0]!.props.children).toBe(LABEL);
  });

  it('its state is checked, unchecked or mixed, and disabled while it is off', () => {
    for (const checked of VALUES) {
      expect(checkbox({ checked }).props.accessibilityState).toEqual({ checked, disabled: false });
      expect(checkbox({ checked, disabled: true }).props.accessibilityState).toEqual({
        checked,
        disabled: true,
      });
    }
  });

  it('a spoken name in place of the label changes only what VoiceOver says; the label still shows', () => {
    const spoken = 'Select Safety vest, 12 on hand';
    const el = checkbox({ accessibilityLabel: spoken, accessibilityHint: 'Adds it to the count' });
    expect(el.props.accessibilityLabel).toBe(spoken);
    expect(el.props.accessibilityHint).toBe('Adds it to the count');
    expect(every(drawn(el), 'Body')[0]!.props.children).toBe(LABEL);
  });

  it('a mixed box draws the bar, a ticked box the tick, a clear box nothing', () => {
    const glyphs = (checked: CheckboxValue) => {
      const tree = drawn(checkbox({ checked }));
      return [...every(tree, 'Check'), ...every(tree, 'Minus')].map((g) => g.type);
    };
    expect(glyphs('mixed')).toEqual(['Minus']);
    expect(glyphs(true)).toEqual(['Check']);
    expect(glyphs(false)).toEqual([]);
  });
});

describe('a tap asks the caller; the checkbox keeps no state of its own', () => {
  it('a clear or a mixed box asks to be ticked, a ticked box to be cleared (the web select-all rule)', () => {
    expect(VALUES.map(nextChecked)).toEqual([false, true, true]);
    for (const [checked, next] of [
      [false, true],
      ['mixed', true],
      [true, false],
    ] as const) {
      const onChange = vi.fn();
      const el = checkbox({ checked, onChange });
      (el.props.onPress as () => void)();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(next);
    }
  });

  // Mutation caught: a useState copy of `checked` flipped on tap, which would
  // show a tick the caller never stored (and drift from the shared
  // countSelection store the Items, Books and count screens read).
  it('shows what the caller passes, before and after a tap, until the caller passes a new value', () => {
    const onChange = vi.fn();
    const before = checkbox({ checked: false, onChange });
    (before.props.onPress as () => void)();
    const after = checkbox({ checked: false, onChange });
    for (const el of [before, after]) {
      expect(el.props.accessibilityState).toEqual({ checked: false, disabled: false });
      expect(every(drawn(el), 'Check')).toHaveLength(0);
    }
    expect(onChange).toHaveBeenCalledWith(true);
    expect(every(drawn(checkbox({ checked: true })), 'Check')).toHaveLength(1);
  });

  it('the file calls no state, reducer, ref or effect hook: only the mode and the text size', () => {
    expect([...new Set(hookCalls(FILE))].sort()).toEqual(['useTheme', 'useWindowDimensions']);
  });

  it('disabled: a tap does nothing', () => {
    const onChange = vi.fn();
    const el = checkbox({ disabled: true, onChange });
    expect(el.props.disabled).toBe(true);
    expect(el.props.onPress).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the target: a 22pt box in a frame at least 44pt each way', () => {
  // A frame, not hitSlop: VoiceOver outlines the view's own bounds, and
  // hitSlop never reaches past the parent's (header-chip-a11y.test.ts holds
  // the header chips to the same rule).
  it('the Pressable is the frame: minimums of 44pt (so it grows), never a fixed size, never hitSlop', () => {
    const el = checkbox();
    const s = flat(el.props.style);
    expect(CHECKBOX_MIN_TARGET).toBe(44);
    expect(s.minHeight).toBe(CHECKBOX_MIN_TARGET);
    expect(s.minWidth).toBe(CHECKBOX_MIN_TARGET);
    expect(s).not.toHaveProperty('height');
    expect(s).not.toHaveProperty('width');
    expect(el.props.hitSlop).toBeUndefined();
    expect(withAttribute(FILE, 'hitSlop')).toEqual([]);
  });

  it('holds one 22pt box', () => {
    expect(CHECKBOX_SIZE).toBe(22);
    const found = boxes(drawn(checkbox()));
    expect(found).toHaveLength(1);
    expect(flat(found[0]!.props.style)).toMatchObject({ width: 22, height: 22 });
  });

  it('one line at the default text size is exactly 44pt tall, the box 11pt from the top', () => {
    const l = checkboxLayout(1);
    const height = 2 * l.padding + Math.max(l.boxTop + l.box, l.labelTop + l.firstLine);
    expect(height).toBeCloseTo(44, 6);
    expect(l.padding + l.boxTop).toBeCloseTo(11, 6);
    // The tree spends exactly those numbers, from the row's top. Mutation
    // caught: a centred row (or a child that centres itself) keeps a one-line
    // row the same, but puts the box halfway down a wrapped label instead of
    // beside its first line.
    const el = checkbox();
    expect(flat(el.props.style).paddingVertical).toBe(l.padding);
    expect(flat(el.props.style).alignItems).toBe('flex-start');
    const [boxSlot, words] = el.props.children as Node[];
    expect(flat(boxSlot!.props.style).marginTop).toBe(l.boxTop);
    expect(flat(words!.props.style).marginTop).toBe(l.labelTop);
    for (const child of [boxSlot!, words!]) {
      expect(flat(child.props.style)).not.toHaveProperty('alignSelf');
    }
  });
});

describe('Dynamic Type: the box stays 22pt while the label grows and wraps', () => {
  /** iOS's text sizes as React Native reports them (fontScale), xSmall to AX5. */
  const IOS_SCALES = [
    0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143, 3.571,
  ];

  it('at every iOS text size the box is 22pt and centred on the first line, and a row is at least 44pt', () => {
    for (const f of IOS_SCALES) {
      const l = checkboxLayout(f);
      expect(l.box, `${f}`).toBe(22);
      expect(l.firstLine, `${f}`).toBeCloseTo(CHECKBOX_LABEL_SIZE * 1.5 * f, 6);
      expect(l.boxTop + l.box / 2, `${f}`).toBeCloseTo(l.labelTop + l.firstLine / 2, 6);
      const oneLine = 2 * l.padding + Math.max(l.boxTop + l.box, l.labelTop + l.firstLine);
      expect(oneLine, `${f}`).toBeGreaterThanOrEqual(44 - 1e-9);
      expect(Math.min(l.boxTop, l.labelTop, l.padding), `${f}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('only the line grows: from the default size to AX5 the box is unchanged', () => {
    const def = checkboxLayout(1);
    const ax5 = checkboxLayout(3.571);
    expect(ax5.box).toBe(def.box);
    expect(ax5.firstLine).toBeGreaterThan(3 * def.firstLine);
  });

  it('drawn at AX5: still one 22pt box; the label uncapped, never shrunk, with no line limit', () => {
    const tree = atScale(3.571, () => drawn(checkbox())) as Node;
    const found = boxes(tree);
    expect(found).toHaveLength(1);
    expect(flat(found[0]!.props.style)).toMatchObject({ width: 22, height: 22 });
    const words = every(tree, 'Body')[0]!;
    expect(words.props.size).toBe(CHECKBOX_LABEL_SIZE);
    for (const prop of [
      'maxFontSizeMultiplier',
      'numberOfLines',
      'allowFontScaling',
      'adjustsFontSizeToFit',
    ]) {
      expect(words.props, prop).not.toHaveProperty(prop);
      expect(withAttribute(FILE, prop), prop).toEqual([]);
    }
    // It wraps instead of pushing: shrinkable, with its own width (not flex: 1,
    // which would collapse it in a parent with no set width).
    expect(flat(words.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(flat(words.props.style)).not.toHaveProperty('flex');
    const l = checkboxLayout(3.571);
    expect(flat(tree.props.style).paddingVertical).toBe(l.padding);
    expect(flat(tree.props.style).minHeight).toBe(44);
  });

  it('a missing or nonsense scale is read as the default size', () => {
    for (const f of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(checkboxLayout(f), String(f)).toEqual(checkboxLayout(1));
    }
  });

  // The box is centred on the label's first line, which the layout computes
  // from Body's size and line height; if Body changes, the box drifts.
  it('Body still draws 14.5pt lines at 1.5 times the size, as the layout assumes', () => {
    const sf = sourceOf('src/components/ui/text.tsx');
    const body = functionNamed(sf, 'Body').getText(sf);
    expect(body).toContain('size = 14.5');
    expect(body).toContain('lineHeight: size * 1.5');
    expect(CHECKBOX_LABEL_SIZE).toBe(14.5);
  });
});

describe('colours, per mode, measured', () => {
  it('clear: the card fill and the ink4 edge; ticked and mixed: the ink fill and edge, a paper glyph', () => {
    each((p) => {
      expect(checkboxTone(false, false, p)).toEqual({
        fill: p.card,
        border: p.ink4,
        glyph: null,
        label: p.ink,
      });
      expect(checkboxTone(true, false, p)).toEqual({
        fill: p.ink,
        border: p.ink,
        glyph: p.paper,
        label: p.ink,
      });
      expect(checkboxTone('mixed', false, p)).toEqual(checkboxTone(true, false, p));
    });
  });

  it('disabled is greyed: a clear box fills hair2 in the same edge, a ticked one turns ink3, the words ink3', () => {
    each((p) => {
      expect(checkboxTone(false, true, p)).toEqual({
        fill: p.hair2,
        border: p.ink4,
        glyph: null,
        label: p.ink3,
      });
      expect(checkboxTone(true, true, p)).toEqual({
        fill: p.ink3,
        border: p.ink3,
        glyph: p.paper,
        label: p.ink3,
      });
      expect(checkboxTone('mixed', true, p)).toEqual(checkboxTone(true, true, p));
    });
  });

  it('every edge stands out from the card and the page at 3:1, in every state, both modes', () => {
    each((p, mode) => {
      for (const value of VALUES) {
        for (const disabled of [false, true]) {
          const { border } = checkboxTone(value, disabled, p);
          const name = `${mode} ${String(value)}${disabled ? ' disabled' : ''}`;
          expect(contrast(border, p.card), `${name} on card`).toBeGreaterThanOrEqual(AA_UI);
          expect(contrast(border, p.paper), `${name} on paper`).toBeGreaterThanOrEqual(AA_UI);
        }
      }
    });
  });

  it('the tick and the bar stand out from their fill at 3:1, disabled too', () => {
    each((p, mode) => {
      for (const value of [true, 'mixed'] as CheckboxValue[]) {
        for (const disabled of [false, true]) {
          const t = checkboxTone(value, disabled, p);
          expect(
            contrast(t.glyph!, t.fill),
            `${mode} ${String(value)} ${disabled}`,
          ).toBeGreaterThanOrEqual(AA_UI);
        }
      }
    });
  });

  it("a Checkbox's words read at AA on the card and the page, disabled too", () => {
    each((p, mode) => {
      for (const disabled of [false, true]) {
        const { label } = checkboxTone(false, disabled, p);
        expect(contrast(label, p.card), `${mode} ${disabled} on card`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
        expect(contrast(label, p.paper), `${mode} ${disabled} on paper`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });
  });

  /**
   * The ratios (WCAG, two decimals), so a palette change that weakens a box
   * shows here and by how much. Edges are [on the card, on the page]. ink4 is
   * the clear box's edge because it clears 3:1 on both grounds in both modes
   * (the thinnest is light on the page, 3.18), so the ink3 fallback was not
   * needed. hair2, the stronger border token, is only 1.30-1.52:1 on the card
   * and could not carry an edge; it greys a disabled box's inside instead.
   */
  const MEASURED: Record<
    Mode,
    {
      clearEdge: [number, number];
      tickedEdge: [number, number];
      disabledTickedEdge: [number, number];
      tick: number;
      disabledTick: number;
      greyedStep: number;
    }
  > = {
    light: {
      clearEdge: [3.33, 3.18],
      tickedEdge: [19.22, 18.38],
      disabledTickedEdge: [6.7, 6.41],
      tick: 18.38,
      disabledTick: 6.41,
      greyedStep: 1.52,
    },
    dark: {
      clearEdge: [3.43, 3.61],
      tickedEdge: [16.05, 16.91],
      disabledTickedEdge: [6.58, 6.93],
      tick: 16.91,
      disabledTick: 6.93,
      greyedStep: 1.3,
    },
  };

  it('the measured ratios, both modes', () => {
    each((p, mode) => {
      const m = MEASURED[mode];
      const edge = (value: CheckboxValue, disabled: boolean) => {
        const { border } = checkboxTone(value, disabled, p);
        return [ratio(border, p.card), ratio(border, p.paper)];
      };
      expect(edge(false, false), `${mode} clear`).toEqual(m.clearEdge);
      expect(edge(false, true), `${mode} clear, disabled`).toEqual(m.clearEdge);
      expect(edge(true, false), `${mode} ticked`).toEqual(m.tickedEdge);
      expect(edge('mixed', false), `${mode} mixed`).toEqual(m.tickedEdge);
      expect(edge(true, true), `${mode} ticked, disabled`).toEqual(m.disabledTickedEdge);
      const glyph = (disabled: boolean) => {
        const t = checkboxTone(true, disabled, p);
        return ratio(t.glyph!, t.fill);
      };
      expect(glyph(false), `${mode} tick`).toBe(m.tick);
      expect(glyph(true), `${mode} tick, disabled`).toBe(m.disabledTick);
      // How far the greyed inside of a disabled clear box steps from the card.
      expect(ratio(checkboxTone(false, true, p).fill, p.card), `${mode} greyed`).toBe(m.greyedStep);
    });
  });

  it('ticked, clear and disabled look different in both modes, and ticked from clear not by colour alone', () => {
    each((p, mode) => {
      expect(checkboxTone(false, true, p).fill, mode).not.toBe(checkboxTone(false, false, p).fill);
      expect(checkboxTone(true, true, p).fill, mode).not.toBe(checkboxTone(true, false, p).fill);
      expect(checkboxTone(false, false, p).glyph, mode).toBeNull();
      expect(checkboxTone(true, false, p).glyph, mode).not.toBeNull();
    });
  });

  // Mutations caught: the mark reading one fixed mode, as the light-only
  // legacy `theme` alias draws (light boxes in dark mode); and the edge's
  // width deleted or set to 0, which keeps every colour above but leaves a
  // clear box a card-filled square on a card row (1:1), so it vanishes.
  it('the mark paints the recipe of the mode it is drawn in, its edge drawn 1.5pt wide, with no opacity', () => {
    for (const mode of MODES) {
      const p = palette(mode);
      for (const checked of VALUES) {
        for (const disabled of [false, true]) {
          const box = inMode(mode, () => drawn(CheckboxMark({ checked, disabled }))) as Node;
          const t = checkboxTone(checked, disabled, p);
          const s = flat(box.props.style);
          expect(s, `${mode} ${String(checked)} ${disabled}`).toMatchObject({
            backgroundColor: t.fill,
            borderColor: t.border,
            borderWidth: 1.5,
            width: 22,
            height: 22,
          });
          expect(s).not.toHaveProperty('opacity');
          const glyphs = [...every(box, 'Check'), ...every(box, 'Minus')];
          expect(glyphs.map((g) => g.props.color)).toEqual(t.glyph === null ? [] : [t.glyph]);
        }
      }
    }
    const tick = (mode: Mode) =>
      every(
        inMode(mode, () => drawn(CheckboxMark({ checked: true }))),
        'Check',
      )[0]!.props.color;
    expect(tick('dark')).not.toBe(tick('light'));
  });

  it("a Checkbox's words take its mode's label colour, ink3 while disabled", () => {
    for (const mode of MODES) {
      const p = palette(mode);
      for (const disabled of [false, true]) {
        const words = every(
          inMode(mode, () => drawn(checkbox({ disabled }))),
          'Body',
        )[0]!;
        expect(words.props.color, `${mode} ${disabled}`).toBe(disabled ? p.ink3 : p.ink);
      }
    }
  });
});

describe('CheckboxMark: the box alone, for a row that is pressed as a whole', () => {
  it('takes no touch, has no role and is hidden from VoiceOver: the row carries the role and state', () => {
    for (const checked of VALUES) {
      const box = drawn(CheckboxMark({ checked })) as Node;
      expect(box.type).toBe('View');
      expect(box.props.pointerEvents).toBe('none');
      expect(box.props.accessibilityElementsHidden).toBe(true);
      expect(box.props.importantForAccessibility).toBe('no-hide-descendants');
      for (const prop of [
        'accessibilityRole',
        'accessibilityState',
        'accessibilityLabel',
        'onPress',
      ]) {
        expect(box.props, prop).not.toHaveProperty(prop);
      }
      expect(every(box, 'Pressable')).toHaveLength(0);
    }
  });

  it('draws no touchable; the Checkbox draws exactly one, its own root', () => {
    expect(touchablesIn(FILE, 'CheckboxMark')).toEqual([]);
    expect(touchablesIn(FILE, 'Checkbox')).toEqual(['Pressable']);
  });

  it('is the box the Checkbox draws, so both look the same', () => {
    const el = checkbox({ checked: 'mixed', disabled: true });
    const marks = every(el, CheckboxMark);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.props).toEqual({ checked: 'mixed', disabled: true });
  });
});

describe('where a checkbox may be used (sweeps app/ and src/)', () => {
  const marks = usesOf('CheckboxMark');
  const checkboxes = usesOf('Checkbox');

  it('finds the uses (the sweep is not vacuous)', () => {
    expect(marks.map((u) => u.file)).toContain(FILE);
  });

  // iOS folds a Pressable into one VoiceOver element: a Checkbox inside a row
  // Pressable could never be reached and its state never announced, and the
  // two press handlers would compete for one touch.
  it('a Checkbox is never inside another touchable', () => {
    expect(checkboxes.filter((u) => u.touchables.length > 0).map(where)).toEqual([]);
  });

  // D29: the Items and Books select rows drew a check with no checkbox role or
  // state. A row that draws a mark must say what the mark shows.
  it('a CheckboxMark always sits in a touchable announced as a checkbox with its checked state', () => {
    expect(marks.filter((u) => !announcedAsCheckbox(u)).map(where)).toEqual([]);
  });

  // No screen draws a CheckboxMark yet (P5.5, P5.7 and P5.9 adopt it), so the
  // rule is pinned on probe rows. Mutation caught: a word test over the
  // attribute text passed `{ selected: row.checked }`, a real risk where the
  // shortfall sheet's value is named row.checked, and VoiceOver would hear
  // "checkbox" with no state (D29 again).
  it('the rule reads the row as code: checked a key of the state, checkbox a value of the role', () => {
    const announced = (attrs: string) => {
      const uses = usesIn(
        `export const Row = () => (\n  <Pressable onPress={toggle} ${attrs}>\n    <CheckboxMark checked={on} />\n  </Pressable>\n);\n`,
        'probe.tsx',
        'CheckboxMark',
      );
      expect(uses, attrs).toHaveLength(1);
      return announcedAsCheckbox(uses[0]!);
    };
    // The spellings the Checkbox and today's checkbox rows use (the count
    // picker, group review, exceptions, the shortfall sheet, the book order
    // sheet); the Items and Books rows will take the exceptions one.
    for (const attrs of [
      'accessibilityRole="checkbox" accessibilityState={{ checked: picked }}',
      'accessibilityRole="checkbox" accessibilityState={{ checked, disabled }}',
      'accessibilityRole="checkbox" accessibilityState={{ disabled, checked }}',
      'accessibilityRole="checkbox" accessibilityState={{ checked: row.checked, disabled: !row.draftable || locked }}',
      "accessibilityRole={selecting ? 'checkbox' : 'button'} accessibilityState={selecting ? { checked: picked } : undefined}",
      "accessibilityRole={kind === 'radio' ? 'radio' : 'checkbox'} accessibilityState={kind === 'radio' ? { selected } : { checked: selected }}",
    ]) {
      expect(announced(attrs), attrs).toBe(true);
    }
    // A state that only names checked (nested, as an argument or as a value),
    // a role that only mentions the word, or either one missing.
    for (const attrs of [
      'accessibilityRole="checkbox" accessibilityState={{ selected: row.checked }}',
      'accessibilityRole="checkbox" accessibilityState={{ disabled: !row.checked || locked }}',
      'accessibilityRole="checkbox" accessibilityState={{ selected: { checked } }}',
      'accessibilityRole="checkbox" accessibilityState={{ selected: pick(row, checked, 1) }}',
      "accessibilityRole={kind === 'checkbox' ? 'button' : 'radio'} accessibilityState={{ checked }}",
      'accessibilityRole="button" accessibilityState={{ checked }}',
      'accessibilityRole="checkbox"',
      'accessibilityState={{ checked }}',
    ]) {
      expect(announced(attrs), attrs).toBe(false);
    }
    // A mark in no touchable has no row to announce it.
    const loose = usesIn(
      'export const Loose = () => <View><CheckboxMark checked /></View>;\n',
      'probe.tsx',
      'CheckboxMark',
    );
    expect(loose.map(announcedAsCheckbox)).toEqual([false]);
  });
});

describe('no new dependency', () => {
  it('draws with the icon set the app already ships (lucide Check and Minus) and the shared theme', () => {
    const sf = sourceOf(FILE);
    const imports = sf.statements.filter(ts.isImportDeclaration);
    expect(imports.map((d) => (d.moduleSpecifier as ts.StringLiteral).text).sort()).toEqual([
      '../../lib/theme',
      '../../lib/use-theme',
      './text',
      'lucide-react-native',
      'react',
      'react-native',
    ]);
    const lucide = imports.find(
      (d) => (d.moduleSpecifier as ts.StringLiteral).text === 'lucide-react-native',
    );
    const named = lucide?.importClause?.namedBindings;
    expect(named && ts.isNamedImports(named) ? named.elements.map((e) => e.name.text) : []).toEqual(
      ['Check', 'Minus'],
    );
    const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toHaveProperty('lucide-react-native');
  });
});
