import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  attr,
  attrText,
  listTsx,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from '../../lib/__fixtures__/jsx-touch-audit';
import type { SyncBadgeTone } from '../../lib/sync-badge';
import { palette } from '../../lib/theme';
import { AA_TEXT, AA_UI, contrast } from './__fixtures__/contrast';
import { syncBadgeDot, syncBadgeSurface } from './tones';

/**
 * THE SHARED PHONE PRIMITIVES, READ AS SOURCE (redesign package P2.5).
 *
 * The mobile suite has no React Native renderer, so these pin the element
 * trees the way header-chip-a11y.test.ts and sheet-a11y-structure.test.ts do:
 * parsed with the TypeScript compiler, never by regex over markup. The
 * colours themselves are measured in tones.test.ts and lib/theme.test.ts.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const rel = (abs: string) => path.relative(MOBILE_ROOT, abs);
const at = (file: string) => path.join(MOBILE_ROOT, file);

/** Every file this package owns that draws or decides colour. */
const OWNED = [
  ...listTsx(at('src/components/ui')),
  at('src/components/ui/tones.ts'),
  at('src/components/ui/data-list-state.ts'),
  at('src/components/SyncStatusBadge.tsx'),
  at('src/components/data-list-screen.tsx'),
].map(rel);

function source(file: string): ts.SourceFile {
  return parseTsx(readSource(at(file)), file);
}

/** Named imports a file takes from lib/theme, however it spells the path. */
function themeImports(file: string): string[] {
  const sf = source(file);
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const resolved = spec.startsWith('@/')
      ? at(path.join('src', spec.slice(2)))
      : spec.startsWith('.')
        ? path.resolve(path.dirname(at(file)), spec)
        : null;
    if (resolved !== at('src/lib/theme')) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
    }
  }
  return names;
}

function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = source(file);
  const out: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (match(el, sf)) out.push(el);
  });
  return { sf, els: out };
}

/** The expression inside `name={...}` on an element. */
function attrExpression(el: JsxNode, name: string, sf: ts.SourceFile): ts.Expression | undefined {
  const init = attr(el, name, sf)?.initializer;
  return init && ts.isJsxExpression(init) ? init.expression : undefined;
}

describe('every shared primitive follows the device mode', () => {
  it('finds the files (the sweep is not vacuous)', () => {
    expect(OWNED.length).toBeGreaterThanOrEqual(20);
    expect(OWNED).toContain('src/components/ui/button.tsx');
    expect(OWNED).toContain('src/components/SyncStatusBadge.tsx');
  });

  // Mutation caught: SyncStatusBadge back on the light-only legacy alias
  // (redesign plan P2.5 puts every shared primitive on the device mode; the
  // badge's hosts follow when P5.9 migrates them), or a primitive colouring
  // words with a single-mode ACCENT value (ACCENT.warn is 3.4:1 on light
  // paper, ACCENT.crit 3.1:1 on dark).
  it('none reads the light-only legacy `theme` alias or the single-mode ACCENT values', () => {
    const offenders = OWNED.flatMap((file) =>
      themeImports(file)
        .filter((name) => name === 'theme' || name === 'ACCENT')
        .map((name) => `${file} imports ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  // ink4 and ink5 are 1.8-3.7:1: fine for an arrow or a glyph, under AA for
  // words. Mutation caught: an eyebrow, a row subtitle, a stat label, the
  // pager's range line, a field label or placeholder, or the calendar's
  // weekday letters put back on ink4 / ink5. Inventory, P2.5b: the shared
  // Checkbox's clear-box edge is ink4, a UI mark held at 3:1 on the card and
  // the page in both modes (checkbox.test.ts measures it); no words.
  it('the faint inks colour decorative marks only', () => {
    const uses: string[] = [];
    for (const file of OWNED) {
      const sf = source(file);
      const visit = (node: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'c' &&
          /^ink[45]$/.test(node.name.text)
        ) {
          let up: ts.Node | undefined = node.parent;
          while (up && !ts.isJsxOpeningElement(up) && !ts.isJsxSelfClosingElement(up))
            up = up.parent;
          const tag = up ? up.tagName.getText(sf) : '(not in JSX)';
          uses.push(`${file} ${tag} ${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(uses.sort()).toEqual([
      'src/components/data-list-screen.tsx EmptyIcon ink4', // the empty state's glyph
      'src/components/ui/checkbox.tsx (not in JSX) ink4', // checkboxTone: a clear box's edge
      'src/components/ui/paginator.tsx Mono ink4', // the "·" gap marker, hidden from VoiceOver
      'src/components/ui/row.tsx ChevronRight ink4', // the row's arrow
    ]);
    const { sf, els } = elements(
      'src/components/ui/paginator.tsx',
      (el, s) => tagOf(el, s) === 'View',
    );
    expect(els.some((el) => attrText(el, 'accessibilityElementsHidden', sf) === 'true')).toBe(true);
  });
});

describe('Toggle is a switch to VoiceOver', () => {
  // Mutation caught: it was an unnamed, roleless Pressable, so VoiceOver read
  // nothing about what it was or whether it was on.
  it('announced as a switch with its on / off state, named when the caller names it', () => {
    const { sf, els } = elements(
      'src/components/ui/toggle.tsx',
      (el, s) => tagOf(el, s) === 'Pressable',
    );
    expect(els).toHaveLength(1);
    const root = els[0]!;
    expect(attrText(root, 'accessibilityRole', sf)).toBe('switch');
    expect(attrText(root, 'accessibilityLabel', sf)).toBe('accessibilityLabel');
    expect(attrText(root, 'accessibilityState', sf)).toBe('{ checked: value, disabled: inert }');
  });

  it('dimmed, and a tap does nothing, while the caller withholds onValueChange (a save in flight)', () => {
    const src = readSource(at('src/components/ui/toggle.tsx'));
    expect(src).toContain('const inert = !onValueChange;');
    const { sf, els } = elements(
      'src/components/ui/toggle.tsx',
      (el, s) => tagOf(el, s) === 'Pressable',
    );
    expect(attrText(els[0]!, 'disabled', sf)).toBe('inert');
    expect(attrText(els[0]!, 'onPress', sf)).toBe('() => onValueChange?.(!value)');
  });
});

describe('SyncStatusBadge keeps its words and its tap', () => {
  const file = 'src/components/SyncStatusBadge.tsx';

  it('reads the colours of the mode it is drawn in', () => {
    const src = readSource(at(file));
    expect(src).toContain('const { c } = useTheme();');
    expect(src).toContain('syncBadgeDot(tone, c)');
    expect(src).toContain('syncBadgeSurface(c)');
  });

  // The words come from lib/sync-badge.ts (sync-badge.test.ts) and the tap
  // drains the outbox (drain-rejection-wiring.test.ts pins the call shape).
  it('one button: the same spoken words, and a tap still forces a sync', () => {
    const { sf, els } = elements(file, (el, s) => tagOf(el, s) === 'Pressable');
    expect(els).toHaveLength(1);
    const pill = els[0]!;
    expect(attrText(pill, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(pill, 'accessibilityLabel', sf)).toBe('`Sync status: ${label}. Tap to retry.`');
    expect(attrText(pill, 'onPress', sf)).toMatch(/void cycleCountSync\.forceSync\(\)/);
  });

  it('the label still shows the state words, capped as chrome, on one line', () => {
    const { sf, els } = elements(file, (el, s) => tagOf(el, s) === 'Text');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'numberOfLines', sf)).toBe('1');
    expect(attrText(els[0]!, 'maxFontSizeMultiplier', sf)).toBe('LABEL_CAP');
    expect(readSource(at(file))).toContain('const LABEL_CAP = capTo(11, TYPE_CEILING.chrome);');
  });
});

/**
 * THE BADGE ON A CAMERA BAR (redesign P3.8, an integrator grant on this
 * P2.5 file). The count scanner draws the badge on its always-dark camera
 * bar, where the device-mode chip's outline was 1.47:1 in dark mode. One
 * optional prop, `surface="camera"`, draws it from the dark palette in both
 * modes; without it the badge is exactly what it was.
 */
describe('SyncStatusBadge on a camera bar', () => {
  const file = 'src/components/SyncStatusBadge.tsx';
  const src = readSource(at(file));
  const dark = palette('dark');
  const TONES: SyncBadgeTone[] = ['primary', 'muted', 'destructive', 'success', 'warning'];
  /** An opaque colour laid at `alpha` over another, as '#rrggbb'. */
  const over = (top: string, alpha: number, under: string): string =>
    `#${[1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(top.slice(i, i + 2), 16) * alpha +
            parseInt(under.slice(i, i + 2), 16) * (1 - alpha),
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  /** The dark bars a camera screen draws: black, the viewfinder colour, and
   *  the 55% black bar (ai-scan) over a black and over a white scene. */
  const BARS = [
    '#000000',
    '#0a0b09',
    over('#000000', 0.55, '#000000'),
    over('#000000', 0.55, '#ffffff'),
  ];
  /** The camera chip's tokens, read from the source (each a dark-palette key). */
  const chipTokens = (() => {
    const m =
      /const CAMERA_CHIP: Tone = \{\s*fg: CAMERA_PALETTE\.(\w+),\s*bg: CAMERA_PALETTE\.(\w+),\s*border: CAMERA_PALETTE\.(\w+),?\s*\};/.exec(
        src,
      );
    expect(m, 'CAMERA_CHIP is not three dark-palette tokens').not.toBeNull();
    return { fg: m![1]!, bg: m![2]!, border: m![3]! } as Record<
      'fg' | 'bg' | 'border',
      keyof typeof dark
    >;
  })();
  const chip = {
    fg: dark[chipTokens.fg],
    bg: dark[chipTokens.bg],
    border: dark[chipTokens.border],
  };

  // Mutation caught: the default changed, so the cycle-count header's badge
  // (no prop) would draw the camera chip.
  it('without the prop it is the device-mode chip it was, hairline and all', () => {
    expect(src).toContain(
      "export function SyncStatusBadge({ surface = 'screen' }: { surface?: SyncBadgeSurface })",
    );
    expect(src).toContain("export type SyncBadgeSurface = 'screen' | 'camera';");
    expect(src).toContain("const onCamera = surface === 'camera';");
    expect(src).toContain(
      'const dotColor = onCamera ? syncBadgeDot(tone, CAMERA_PALETTE) : syncBadgeDot(tone, c);',
    );
    expect(src).toContain('const chip = onCamera ? CAMERA_CHIP : syncBadgeSurface(c);');
    expect(src).toMatch(/\n {2}pill: \{[^}]*borderWidth: StyleSheet\.hairlineWidth,/);
    const { sf, els } = elements(file, (el, s) => tagOf(el, s) === 'Pressable');
    expect(attrText(els[0]!, 'style', sf)).toMatch(
      /styles\.pill,\s*onCamera && styles\.pillOnCamera,/,
    );
  });

  // Mutation caught: the camera chip read from the device palette (light in
  // light mode, on a bar that is always dark).
  it('the camera chip is the dark palette in both modes, a full point outline', () => {
    expect(src).toContain("const CAMERA_PALETTE = palette('dark');");
    expect(chipTokens).toEqual({ fg: 'ink2', bg: 'card', border: 'ink4' });
    expect(src).toMatch(/\n {2}pillOnCamera: \{\s*borderWidth: 1,\s*\}/);
  });

  it('its words read at AA and every state dot (or spinner) at 3:1 on the chip', () => {
    expect(contrast(chip.fg, chip.bg)).toBeGreaterThanOrEqual(AA_TEXT);
    for (const tone of TONES) {
      expect(contrast(syncBadgeDot(tone, dark), chip.bg), tone).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  // The P2.5 review's finding: the device-mode chip's outline was 1.47:1 on a
  // camera bar in dark mode. Mutation caught: an outline or fill that loses
  // the chip on any of the bars (for example the old sunk / hair2 chip).
  it('stands out at 3:1 from every dark bar, by its outline or by its fill', () => {
    for (const bar of BARS) {
      const best = Math.max(contrast(chip.border, bar), contrast(chip.bg, bar));
      expect(best, bar).toBeGreaterThanOrEqual(AA_UI);
    }
    // On the solid bars it is the outline that does it.
    expect(contrast(chip.border, '#0a0b09')).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(chip.border, '#000000')).toBeGreaterThanOrEqual(AA_UI);
    // The old device-mode chip in dark mode fails the same check (vacuity control).
    const old = syncBadgeSurface(dark);
    expect(Math.max(contrast(old.border, '#000000'), contrast(old.bg, '#000000'))).toBeLessThan(
      AA_UI,
    );
  });
});

describe('DataListScreen keeps loading, empty, failed and offline apart', () => {
  const file = 'src/components/data-list-screen.tsx';
  const { sf, els } = elements(file, (el, s) => tagOf(el, s) === 'FlatList');

  it('loading is the spinner, before any list', () => {
    expect(readSource(at(file))).toMatch(/\{loading \? \(\s*<ActivityIndicator color=\{c\.ink\}/);
  });

  // Mutation caught (D25): the failed read showing the screen's "No X yet."
  // copy, or the empty state losing its own words.
  it('a failed read with no rows shows its own words, never the empty copy', () => {
    expect(els).toHaveLength(1);
    const empty = attrExpression(els[0]!, 'ListEmptyComponent', sf);
    expect(empty && ts.isConditionalExpression(empty)).toBe(true);
    const cond = empty as ts.ConditionalExpression;
    expect(cond.condition.getText(sf)).toBe('failed');
    const whenFailed = cond.whenTrue.getText(sf);
    const whenEmpty = cond.whenFalse.getText(sf);
    expect(whenFailed).toContain('{failed.title}');
    expect(whenFailed).toContain('{failed.body}');
    expect(whenFailed).not.toMatch(/emptyTitle|emptyBody|emptyAction/);
    expect(whenEmpty).toContain('{emptyTitle}');
    expect(whenEmpty).toContain('{emptyBody}');
    expect(whenEmpty).toContain('{emptyAction}');
    expect(whenEmpty).not.toMatch(/failed/);
  });

  it('offline has its own glyph; any other failure the warning glyph', () => {
    const empty = attrExpression(els[0]!, 'ListEmptyComponent', sf) as ts.ConditionalExpression;
    const whenFailed = empty.whenTrue.getText(sf);
    expect(whenFailed).toMatch(/emptyKind === 'offline' \? \(\s*<WifiOff/);
    expect(whenFailed).toContain('<TriangleAlert');
    expect(readSource(at(file))).toContain('const emptyKind = dataListEmptyKind(failed);');
  });

  it('rows an earlier read left stay on screen, with the reload note above them', () => {
    const header = attrExpression(els[0]!, 'ListHeaderComponent', sf);
    expect(header && ts.isConditionalExpression(header)).toBe(true);
    const cond = header as ts.ConditionalExpression;
    expect(cond.condition.getText(sf)).toBe('reloadNote');
    expect(cond.whenTrue.getText(sf)).toContain('{reloadNote}');
    expect(readSource(at(file))).toContain(
      'const reloadNote = dataListReloadNote(failed, data.length);',
    );
    // The rows are the caller's, whatever the read did.
    expect(attrText(els[0]!, 'data', sf)).toBe('data');
  });

  // B32: the phone Rentals list's "Showing the newest 100 of N returned or
  // cancelled rentals" line reaches the screen only through `footer`
  // (screens/rentals.tsx passes it: rental-detail-wiring.test.ts). The
  // FlatList's footer is taken from the source, compiled and drawn with
  // stand-in elements. Mutation caught: ListFooterComponent dropped (the
  // line never drawn), or drawn under the empty or failed state's words.
  it("the caller's footer is drawn under the last row, and only when there are rows", () => {
    const footer = attrExpression(els[0]!, 'ListFooterComponent', sf);
    expect(footer, 'ListFooterComponent').toBeDefined();
    const js = ts.transpileModule(`(${footer!.getText(sf)});`, {
      fileName: 'footer.tsx',
      compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
    }).outputText;
    const draw = (given: unknown, data: unknown[]) =>
      new vm.Script(js).runInNewContext({
        h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
        View: 'View',
        footer: given,
        data,
      }) as unknown;
    const note = { type: 'Body', props: null, children: ['Showing the newest 100 of 240'] };
    expect(draw(note, [{ id: 'r1' }])).toEqual({ type: 'View', props: null, children: [note] });
    // No rows (the empty state, or a failed read's words): no footer under them.
    expect(draw(note, [])).toBeFalsy();
    // No footer given: nothing drawn.
    expect(draw(undefined, [{ id: 'r1' }])).toBeFalsy();
    expect(draw(null, [{ id: 'r1' }])).toBeFalsy();
  });
});
