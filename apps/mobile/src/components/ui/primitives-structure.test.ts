import * as path from 'node:path';

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

  // Mutation caught: SyncStatusBadge back on the light-only legacy alias (it
  // drew a light pill on the dark count screens), or a primitive colouring
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
  // weekday letters put back on ink4 / ink5.
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
