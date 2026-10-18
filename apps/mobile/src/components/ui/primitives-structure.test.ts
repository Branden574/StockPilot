import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
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
const OWNED = [...listTsx(at('src/components/ui')), at('src/components/ui/tones.ts')].map(rel);

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

describe('every shared primitive follows the device mode', () => {
  it('finds the files (the sweep is not vacuous)', () => {
    expect(OWNED.length).toBeGreaterThanOrEqual(18);
    expect(OWNED).toContain('src/components/ui/button.tsx');
  });

  // Mutation caught: a primitive on the light-only legacy alias (it renders
  // light in dark mode), or colouring words with a single-mode ACCENT value
  // (ACCENT.warn is 3.4:1 on light paper, ACCENT.crit 3.1:1 on dark).
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
