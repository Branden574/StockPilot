import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { classicFlat, flatNorm, printClassic } from '../../lib/__fixtures__/classic-projection';
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
      'src/components/ui/glass/parts.tsx View ink5', // the sheet grabber's fallback (decoration, hidden from VoiceOver)
      'src/components/ui/glass/screens/home.tsx (not in JSX) ink4', // the muted sync dot beside its words
      'src/components/ui/glass/screens/home.tsx ChevronRight ink4', // a movement row's arrow (fallback)
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
});

/**
 * A live text-size change remounts the list chrome's head and rows (docket
 * B10). The notifications list kept every row at its old height, text
 * clipped, until the screen was opened again (simulator walk 2026-10-05).
 * Nothing in the rows fixes a height; a remount measures afresh, so the head
 * and the list are keyed on the text size (fontScaleKey,
 * dynamic-type-layout.test.ts). The top bar is not keyed: its trailing slot
 * carries the tour, whose state a remount would reset.
 */
describe('DataListScreen measures its head and rows again at a new text size', () => {
  const file = 'src/components/data-list-screen.tsx';
  const src = readSource(at(file)).replace(/\s+/g, ' ');

  it('reads the live text size and turns it into a key', () => {
    expect(src).toMatch(/import \{[^}]*\buseWindowDimensions\b[^}]*\} from 'react-native';/);
    expect(src).toContain("import { fontScaleKey } from '@/lib/dynamic-type-layout';");
    expect(src).toContain('const { fontScale } = useWindowDimensions();');
    expect(src).toContain('const scaleKey = fontScaleKey(fontScale);');
  });

  it('the list and the head are keyed on it; the top bar is not', () => {
    const { sf: listSf, els: lists } = elements(file, (el, s) => tagOf(el, s) === 'FlatList');
    expect(lists).toHaveLength(1);
    expect(attrText(lists[0]!, 'key', listSf)).toBe('`list-${scaleKey}`');
    // Classic's shape, read off the frame's Classic projection (every Liquid
    // Glass branch folded to Classic: lib/__fixtures__/classic-projection.ts).
    const classic = parseTsx(printClassic(readSource(at(file)), file), file);
    const classicWith = (style: string) => {
      const out: JsxNode[] = [];
      walkJsx(classic, (el) => {
        if (attrText(el, 'style', classic) === style) out.push(el);
      });
      return out;
    };
    const heads = classicWith('styles.head');
    expect(heads).toHaveLength(1);
    expect(attrText(heads[0]!, 'key', classic)).toBe('`head-${scaleKey}`');
    const bars = classicWith('styles.topbar');
    expect(bars).toHaveLength(1);
    expect(attrText(bars[0]!, 'key', classic)).toBeUndefined();
    // Liquid Glass draws the same two elements in its own frames: the head
    // keyed the same, the nav not keyed (the tour in `trailing` keeps its state).
    const { sf, els: glassHeads } = elements(
      file,
      (el, s) => attrText(el, 'style', s) === 'lg ? GLASS_LIST.head : styles.head',
    );
    expect(glassHeads).toHaveLength(1);
    expect(attrText(glassHeads[0]!, 'key', sf)).toBe('`head-${scaleKey}`');
    const { els: navs } = elements(
      file,
      (el, s) => attrText(el, 'style', s) === 'lg ? GLASS_LIST.nav : styles.topbar',
    );
    expect(navs).toHaveLength(1);
    expect(attrText(navs[0]!, 'key', sf)).toBeUndefined();
  });
});

/**
 * THE LIST FRAME IN LIQUID GLASS (stage 4, an inferred extension of the iOS
 * list boards: iOS-Lookup, iPad-Compact's Orders list, iOS-Home's title
 * block). Classic is proved unchanged by the frame's Classic projection pin
 * (lib/appearance/glass-classic-pins.test.ts); these pin what Liquid Glass
 * draws instead, and that every control and state Classic has is drawn in
 * Liquid Glass too, outside any glass branch.
 */
describe('DataListScreen in Liquid Glass', () => {
  const file = 'src/components/data-list-screen.tsx';
  const src = readSource(at(file));
  const sf = source(file);
  // Code text in one spelling on both sides (lib/__fixtures__/classic-projection.ts).
  const code = flatNorm(src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, ''));
  const classicCode = classicFlat(src, file);

  /** True when the node is drawn only in one look: inside a branch on `lg`. */
  function inGlassBranch(node: ts.Node): boolean {
    const isLg = (e: ts.Expression) => {
      let s = e;
      while (ts.isParenthesizedExpression(s)) s = s.expression;
      if (ts.isPrefixUnaryExpression(s)) s = s.operand;
      while (ts.isParenthesizedExpression(s)) s = s.expression;
      return ts.isIdentifier(s) && s.text === 'lg';
    };
    for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
      if (ts.isConditionalExpression(up) && isLg(up.condition) && up.condition !== node)
        return true;
      if (
        ts.isBinaryExpression(up) &&
        up.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        isLg(up.left)
      )
        return true;
    }
    return false;
  }

  /** The head (the View the eyebrow, the title and the header controls sit in), normalised. */
  function head(): string {
    const { sf: s, els } = elements(
      file,
      (el, t) => attrText(el, 'style', t) === 'lg ? GLASS_LIST.head : styles.head',
    );
    expect(els).toHaveLength(1);
    return flatNorm(els[0]!.getText(s));
  }

  /** How many times the code holds this text, both in one spelling. */
  const count = (text: string) => code.split(flatNorm(text)).length - 1;

  // Mutation caught: Back, Menu, the trailing control, the header controls or
  // an empty or failed action drawn in one look only.
  it('every control Classic draws is drawn in Liquid Glass too, in no branch of its own', () => {
    const controls: [string, (el: JsxNode) => boolean][] = [
      ['Back', (el) => attrText(el, 'accessibilityLabel', sf) === 'Back'],
      ['Open menu', (el) => attrText(el, 'accessibilityLabel', sf) === 'Open menu'],
      ['the list', (el) => tagOf(el, sf) === 'FlatList'],
      ['the refresh control', (el) => tagOf(el, sf) === 'RefreshControl'],
      ['the spinner', (el) => tagOf(el, sf) === 'ActivityIndicator'],
    ];
    for (const [name, match] of controls) {
      const found: JsxNode[] = [];
      walkJsx(sf, (el) => {
        if (match(el)) found.push(el);
      });
      expect(found, name).toHaveLength(1);
      expect(inGlassBranch(found[0]!), name).toBe(false);
    }
    // The slots a screen fills: drawn in both looks, never in a glass branch.
    for (const slot of ['trailing', 'header', 'failed.action', 'emptyAction']) {
      const uses: ts.Node[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isJsxExpression(n) && n.expression?.getText(sf) === slot) uses.push(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      expect(uses.length, slot).toBeGreaterThan(0);
      for (const use of uses) expect(inGlassBranch(use), slot).toBe(false);
    }
  });

  it('the scene behind the frame, the page and the safe area clear over it', () => {
    expect(
      count(
        "<View style={[styles.root, { backgroundColor: lg ? 'transparent' : c.paper }]}>{lg ? <SceneBackground /> : null}",
      ),
    ).toBe(1);
    expect(
      count(
        "<SafeAreaView edges={['top']} style={{ backgroundColor: lg ? 'transparent' : c.paper }}>",
      ),
    ).toBe(1);
    expect(count('<View style={lg ? GLASS_LIST.navGroup : styles.chips}>')).toBe(1);
  });

  // The iOS boards draw no line over a large title: a title's meta line is
  // under it (iOS-Home). Mutation caught: the eyebrow drawn over the title in
  // Liquid Glass, or its words dropped.
  it('the eyebrow’s words are the line under the large title, never over it', () => {
    const h = head();
    const pos = (text: string) => h.indexOf(flatNorm(text));
    const eyebrow = pos('{lg ? null : <Eyebrow>{eyebrow}</Eyebrow>}');
    const title = pos('<Display');
    const titleEnd = pos('</Display>');
    const sub = pos('{lg ? <GlassSubline style={GLASS_LIST.sub}>{eyebrow}</GlassSubline> : null}');
    const header = pos('{header ?');
    expect(eyebrow).toBeGreaterThan(-1);
    expect(eyebrow).toBeLessThan(title);
    expect(sub).toBeGreaterThan(titleEnd);
    expect(header).toBeGreaterThan(sub);
    expect(h.split('{eyebrow}').length - 1).toBe(2);
    // Classic keeps its eyebrow over the title and draws no line under it.
    expect(classicCode).toContain(flatNorm('<Eyebrow>{eyebrow}</Eyebrow> <Display size={34}'));
    expect(classicCode).not.toContain('GlassSubline');
  });

  it('the large title is one plain line and a header, in the board’s frame', () => {
    const h = head();
    expect(h).toContain(
      flatNorm(
        "<Display size={34} style={lg ? GLASS_LIST.title : { marginTop: 12 }} accessibilityRole={lg ? 'header' : undefined}>",
      ),
    );
    expect(h).toContain(flatNorm('{lg ? (glassListTitle(title, italic)) : italic ? ('));
  });

  // iOS-Lookup draws its empty line inside the group. Mutation caught: a panel
  // left bare on the scene, or the two panels drawn apart.
  it('the empty, failed and offline panels sit on the grouped surface, at the board’s rhythm', () => {
    expect(count('style={lg ? [glassCardStyle(lg), GLASS_LIST.empty] : styles.empty}')).toBe(2);
    expect(count('style={{ marginBottom: lg ? GLASS_LIST_PANEL.gap : 12 }}')).toBe(2);
    for (const glyph of ['WifiOff', 'TriangleAlert', 'EmptyIcon']) {
      expect(count(`<${glyph} size={lg ? GLASS_LIST_PANEL.glyph : 32}`), glyph).toBe(1);
    }
    expect(count('strokeWidth={lg ? GLASS_LIST_PANEL.strokeWidth : 1.3}')).toBe(3);
    expect(count('color={lg ? c.ink3 : c.ink4}')).toBe(1);
    expect(
      count(
        "style={{ marginTop: lg ? GLASS_LIST_PANEL.gap : 6, textAlign: 'center', maxWidth: 320 }}",
      ),
    ).toBe(2);
  });

  it('the note over rows a failed read left is said on the warning wash', () => {
    expect(
      count(
        '<View style={lg ? [GLASS_LIST.reloadNote, { backgroundColor: c.warnWash }] : styles.reloadNote}>',
      ),
    ).toBe(1);
    expect(
      count(
        '<Body size={lg ? 14 : 13} color={c.warnText} accessibilityRole="alert">{reloadNote}</Body>',
      ),
    ).toBe(1);
  });

  it('the rows: the scroll’s 16pt edges and the tab bar’s room, in both looks', () => {
    expect(
      count(
        'contentContainerStyle={[lg ? GLASS_LIST.list : styles.list, tabBarInset > 0 && { paddingBottom: 24 + tabBarInset }]}',
      ),
    ).toBe(1);
  });
});
