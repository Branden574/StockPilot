import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from '../../lib/__fixtures__/jsx-touch-audit';

/**
 * A Button whose label is a sentence wraps instead of being cut (docket B10).
 *
 * THE DEFECT. The shared Button draws its label on one line
 * (numberOfLines={1}, so a short label in a row of buttons ellipsizes inside
 * its own button). On the return workbench, "Release replacement before return
 * is received" read "Release replacement…" at larger text sizes, and was cut
 * short of its end even at the default size on a narrow phone; the returns
 * sheets' other sentence labels ("Approve, replacement on backorder", "Release
 * before return is received") were cut the same way. The label is capped at
 * the control ceiling, so the button was already as wide as its card: the only
 * room left is another line.
 *
 * THE FIX. Button takes `wrap`: the label takes as many lines as it needs,
 * centred, and the button grows taller. Every returns button whose label is
 * computed or comes from the returns copy passes it; a literal short label
 * ("Try again") keeps one line.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const BUTTON = 'src/components/ui/button.tsx';

/** The returns surfaces whose buttons carry sentence labels. */
const RETURNS_FILES = [
  'src/components/return-workbench-view.tsx',
  'src/components/release-replacement-sheet.tsx',
  'src/components/return-action-sheet.tsx',
  'src/components/requester-return-sheet.tsx',
];

function treeOf(file: string): ts.SourceFile {
  return parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
}

/** Comments out, one space per whitespace run, so neither can satisfy a pin. */
function code(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

/** A Button's label when it is literal JSX text ("Try again"), else null. */
function literalLabel(el: JsxNode, sf: ts.SourceFile): string | null {
  if (!ts.isJsxElement(el)) return null;
  const parts = el.children.filter((ch) => !(ts.isJsxText(ch) && ch.containsOnlyTriviaWhiteSpaces));
  if (parts.length !== 1 || !ts.isJsxText(parts[0]!)) return null;
  return parts[0]!.getText(sf).replace(/\s+/g, ' ').trim();
}

function buttonsOf(file: string): { el: JsxNode; sf: ts.SourceFile; where: string }[] {
  const sf = treeOf(file);
  const out: { el: JsxNode; sf: ts.SourceFile; where: string }[] = [];
  walkJsx(sf, (el) => {
    if (tagOf(el, sf) !== 'Button') return;
    const { line } = sf.getLineAndCharacterOfPosition(el.getStart(sf));
    out.push({ el, sf, where: `${file}:${line + 1}` });
  });
  return out;
}

describe('the Button primitive', () => {
  const button = code(BUTTON);

  it('draws one line unless asked to wrap', () => {
    expect(button).toContain('wrap = false,');
    expect(button).toContain('wrap?: boolean;');
    expect(button).toContain('numberOfLines={wrap ? undefined : 1}');
    expect(button).not.toContain('numberOfLines={1}');
  });

  it('a wrapped label centres its lines and keeps the control cap and the shrink pairing', () => {
    expect(button).toContain('styles.label, wrap ? styles.labelWrap : null,');
    expect(button).toContain("labelWrap: { textAlign: 'center', },");
    expect(button).toContain('maxFontSizeMultiplier={capTo(fontSize, TYPE_CEILING.control)}');
    expect(button).toMatch(/label: \{[^}]*flexShrink: 1, minWidth: 0, \}/);
    // The button grows with its lines: a minimum height, never a fixed one.
    expect(button).toContain('minHeight,');
    expect(button).not.toMatch(/[^A-Za-z]height: /);
  });
});

describe('the returns buttons wrap a sentence label', () => {
  it.each(RETURNS_FILES)('%s: every computed or copy label wraps', (file) => {
    const buttons = buttonsOf(file);
    expect(buttons.length, file).toBeGreaterThan(0);
    let computed = 0;
    for (const b of buttons) {
      const literal = literalLabel(b.el, b.sf);
      if (literal !== null) {
        // A literal label is a short word or two, and keeps one line.
        expect(literal.length, `${b.where} "${literal}"`).toBeLessThanOrEqual(12);
        continue;
      }
      computed += 1;
      expect(attrText(b.el, 'wrap', b.sf), `${b.where} has no wrap`).toBe('true');
    }
    expect(computed, file).toBeGreaterThan(0);
  });

  it('the early release button the walk found cut is one of them', () => {
    const workbench = buttonsOf('src/components/return-workbench-view.tsx');
    const secondary = workbench.find((b) => b.el.getText(b.sf).includes('actionLabel(a,'));
    expect(secondary).toBeDefined();
    expect(attrText(secondary!.el, 'wrap', secondary!.sf)).toBe('true');
    const release = buttonsOf('src/components/release-replacement-sheet.tsx').find((b) =>
      b.el.getText(b.sf).includes('RETURNS_COPY.releaseBeforeReturn'),
    );
    expect(release).toBeDefined();
    expect(attrText(release!.el, 'wrap', release!.sf)).toBe('true');
  });
});
