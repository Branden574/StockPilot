import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A STORED COLOUR NEVER REACHES A STYLE UNCHECKED (docket T14) — SOURCE GUARD.
 *
 * Category, tag and procedure-category colours are plain text columns that a
 * manager (or an admin) can write through the Data API with any text, and
 * React's server renderer copies a style value into the page as given (it
 * escapes HTML, not CSS): `#000;position:fixed;inset:0` added declarations to
 * every member's Items and Books page. Every place a stored colour is drawn,
 * on the web and on the phone, now goes through a checked helper: core's
 * safeHexColor, or tagColor / procedureCategoryColor built on it. Crate
 * colours already went through a fixed table (getCrateColor, CRATE_COLORS).
 *
 * This walks every web and phone screen and component and reads:
 *   1. each colour property (color, backgroundColor, borderColor, fill,
 *      stroke, a CSS variable, ...) inside a JSX `style={...}`;
 *   2. each colour attribute at a call site (color=, fill=, stroke=,
 *      swatch=, fallbackColor=, ...).
 * When the value reads a stored colour (a `.color`, `.crateColor` or
 * `x_color` field), itself or through a const declared in scope before it,
 * it must pass through a checked helper. Components that check their own
 * colour prop, and files that draw only the code's own palettes, are listed
 * below with the reason.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/app', 'apps/mobile/src'];

/** The checked helpers, and the fixed crate-colour table. */
const CHECKED = /\b(safeHexColor|tagColor|procedureCategoryColor|getCrateColor)\(|\bCRATE_COLORS\[/;

/** A read of a stored colour field: `.color`, `.crateColor`, `.category_color`, `book_crate_color`. */
const STORED_COLOR_READ = /\.\s*[A-Za-z_]*[cC]olor\b|\b[a-z]+_color\b/;

/** Style properties that take a colour. */
const COLOR_PROPERTY =
  /^(color|background|backgroundColor|borderColor|border(Top|Right|Bottom|Left)Color|outlineColor|fill|stroke|textDecorationColor|caretColor|accentColor|stopColor|floodColor|lightingColor|tintColor|shadowColor|textShadowColor|--.*)$/;

/** Colour attributes at a call site. */
const COLOR_ATTRIBUTE =
  /^(color|fill|stroke|swatch|tint|tintColor|backgroundColor|fallbackColor|accentColor|stopColor)$/;

/** Components that draw their colour prop only through a checked helper. */
const SELF_CHECKING = new Set([
  'ProcedureCategoryPill', // procedureCategoryColor (procedure-fallback-band.tsx)
  'ProcedureFallbackBand', // procedureCategoryColor (procedure-fallback-band.tsx)
  'ProcedureVideoThumb', // hands it to ProcedureFallbackBand
  'CrateSwatch', // getCrateColor (crate-fields.tsx) or CRATE_COLORS[...] (the landing page)
  'CrateColorTag', // hands it to CrateSwatch (crate-fields.tsx)
]);

/** Files whose dynamic colours are the code's own palettes, never a stored value. */
const PALETTE_ONLY: Record<string, string> = {
  'apps/web/src/components/ui/chart.tsx':
    'chart config colours from each widget, built from fixed palettes (inventory-breakdown, cost-trend)',
  'apps/web/src/components/dashboard/big-chart.tsx':
    'series colours from SERIES_PALETTE; series carry a label and numbers only',
  'apps/web/src/components/dashboard/charts/cost-trend-widget.tsx':
    'the tooltip dot reads the chart config, built from PALETTE',
  'apps/web/src/lib/pdf/inventory-snapshot.tsx':
    "the page background from the PDF's own style sheet",
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '__fixtures__', '__mocks__', '.next', 'dist'].includes(entry.name)) {
          continue;
        }
        walk(child);
      } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return out.sort();
}

/** The initializer of the nearest `const name = …` declared in scope before `from`. */
function resolveLocal(name: string, from: ts.Node, sf: ts.SourceFile): string | undefined {
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    const statements =
      ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) ? n.statements : null;
    if (!statements) continue;
    for (const statement of statements) {
      if (statement.pos > from.pos) break;
      if (!ts.isVariableStatement(statement)) continue;
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          return d.initializer.getText(sf);
        }
      }
    }
  }
  return undefined;
}

/** The value's text, plus `name = init` for each local const it uses (one level). */
function resolvedText(value: ts.Expression, sf: ts.SourceFile): string {
  const parts = [value.getText(sf)];
  const ids = new Set<string>();
  const collect = (node: ts.Node) => {
    const isPropertyName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
    if (ts.isIdentifier(node) && !isPropertyName) ids.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(value);
  for (const id of ids) {
    const init = resolveLocal(id, value, sf);
    if (init !== undefined) parts.push(`${id} = ${init}`);
  }
  return parts.join(' ; ');
}

type Found = { file: string; line: number; where: string; resolved: string };

function scan(file: string): { styles: Found[]; attributes: Found[] } {
  const styles: Found[] = [];
  const attributes: Found[] = [];
  const src = readFileSync(path.join(REPO, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const objectsIn = (expr: ts.Node, out: ts.ObjectLiteralExpression[]) => {
    if (ts.isObjectLiteralExpression(expr)) out.push(expr);
    ts.forEachChild(expr, (child) => objectsIn(child, out));
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      const attr = node.name.getText(sf);
      const expr = node.initializer.expression;
      if (attr === 'style') {
        const objects: ts.ObjectLiteralExpression[] = [];
        objectsIn(expr, objects);
        for (const obj of objects) {
          for (const prop of obj.properties) {
            let name: string;
            let value: ts.Expression;
            if (ts.isPropertyAssignment(prop)) {
              name = prop.name.getText(sf).replace(/^['"]|['"]$/g, '');
              value = prop.initializer;
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              name = prop.name.text;
              value = prop.name;
            } else {
              continue;
            }
            if (!COLOR_PROPERTY.test(name)) continue;
            if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) continue;
            styles.push({
              file,
              line: lineOf(prop),
              where: `${name}: ${value.getText(sf)}`,
              resolved: resolvedText(value, sf),
            });
          }
        }
      } else if (COLOR_ATTRIBUTE.test(attr) && !ts.isStringLiteralLike(expr)) {
        const element = node.parent.parent;
        const tag =
          ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)
            ? element.tagName.getText(sf)
            : '';
        attributes.push({
          file,
          line: lineOf(node),
          where: `<${tag} ${attr}={${expr.getText(sf)}}>`,
          resolved: SELF_CHECKING.has(tag) ? 'self-checking' : resolvedText(expr, sf),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { styles, attributes };
}

const FILES = sourceFiles();
const SCANNED = FILES.map(scan);
const STYLES = SCANNED.flatMap((s) => s.styles);
const ATTRIBUTES = SCANNED.flatMap((s) => s.attributes);

const describeFound = (f: Found) => `${f.file}:${f.line} ${f.where}  (${f.resolved})`;
const unchecked = (found: Found[]) =>
  found
    .filter((f) => !PALETTE_ONLY[f.file])
    .filter((f) => STORED_COLOR_READ.test(f.resolved) && !CHECKED.test(f.resolved))
    .map(describeFound);

describe('stored colours reach a style only through a checked helper (T14)', () => {
  it('reads both apps (guard against a walk that finds nothing)', () => {
    expect(FILES.some((f) => f.startsWith('apps/web/src/'))).toBe(true);
    expect(FILES.some((f) => f.startsWith('apps/mobile/'))).toBe(true);
    expect(STYLES.length).toBeGreaterThan(20);
  });

  it('every place that draws a stored colour draws it through the check', () => {
    for (const file of [
      'apps/web/src/components/inventory/category-label.tsx',
      'apps/web/src/components/categories/categories-manager.tsx',
      'apps/web/src/components/tags/tags-manager.tsx',
      'apps/web/src/components/inventory/item-form.tsx',
      'apps/web/src/components/inventory/bulk-actions.tsx',
      'apps/web/src/components/procedures/procedure-fallback-band.tsx',
      'apps/web/src/components/procedures/procedure-filters.tsx',
      'apps/mobile/src/screens/categories.tsx',
      'apps/mobile/src/screens/tags.tsx',
    ]) {
      expect(
        STYLES.some((s) => s.file === file && CHECKED.test(s.resolved)),
        file,
      ).toBe(true);
    }
  });

  it('no style draws a stored colour field without the check', () => {
    expect(unchecked(STYLES)).toEqual([]);
  });

  it('no call site hands a stored colour field to a colour attribute without the check', () => {
    expect(unchecked(ATTRIBUTES)).toEqual([]);
  });

  it('each palette-only file still exists and still draws a dynamic colour', () => {
    for (const file of Object.keys(PALETTE_ONLY)) {
      expect(FILES, file).toContain(file);
      expect(
        [...STYLES, ...ATTRIBUTES].some((s) => s.file === file),
        file,
      ).toBe(true);
    }
  });
});
