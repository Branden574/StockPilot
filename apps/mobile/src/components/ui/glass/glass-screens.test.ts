import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: {
    create: <T>(s: T) => s,
    flatten: (s: unknown) =>
      Object.assign(
        {},
        ...(Array.isArray(s) ? s : [s]).flat(Infinity).filter((x) => x && typeof x === 'object'),
      ),
    hairlineWidth: 0.5,
  },
}));

const { themeValueFor } = await import('../../../lib/appearance/theme-value');
const { withGlass } = await import('./merge-styles');
const { glassScanStyles } = await import('./screens/scan');
const { glassAddCardStyles } = await import('./screens/add-cards');

type Look = Parameters<typeof glassScanStyles>[0];

/** Every Liquid Glass look a phone can draw: Day and Night, translucent and opaque. */
const LOOKS: [string, Look][] = (
  [
    ['Day glass', 'light', 'glass'],
    ['Night glass', 'dark', 'glass'],
    ['Day, blur', 'light', 'blur'],
    ['Day, opaque', 'light', 'opaque'],
    ['Night, opaque', 'dark', 'opaque'],
  ] as const
).map(([name, mode, material]) => [
  name,
  themeValueFor('liquid-glass', mode, material, material !== 'opaque') as Look,
]);

describe('withGlass: Classic style keys with the glass values laid over them', () => {
  const classic = { a: { color: 'red', margin: 2 }, b: { padding: 4 } };
  const glass = { a: { color: 'blue' }, extra: { width: 1 } };

  it('merges a key both name, keeps Classic objects for the rest, adds glass-only keys', () => {
    const merged = withGlass(classic, glass as Partial<Record<'a' | 'b', object>>);
    expect(merged.a).toEqual({ color: 'blue', margin: 2 });
    expect(merged.b).toBe(classic.b);
    expect((merged as Record<string, unknown>).extra).toEqual({ width: 1 });
    // Classic itself is never written to.
    expect(classic.a).toEqual({ color: 'red', margin: 2 });
  });

  it('is made once per (Classic set, glass set)', () => {
    const g = glass as Partial<Record<'a' | 'b', object>>;
    expect(withGlass(classic, g)).toBe(withGlass(classic, g));
    expect(withGlass(classic, { a: { color: 'blue' } })).not.toBe(withGlass(classic, g));
  });
});

/**
 * NO CLASSIC PALETTE IN LIQUID GLASS. A screen that picks its style set as
 * `lg ? withGlass(X_STYLES[mode], glassFor(lg)) : X_STYLES[mode]` draws
 * Classic's values for every key the glass set does not name, and its
 * X_STYLES are made from the CLASSIC palette (makeStyles(palette(mode))). So
 * every key whose Classic style takes a colour from that palette (`c.ink`,
 * `c.card`...) must be named by the glass set with that same colour property,
 * or the glass screen would draw a Classic colour.
 */
function paletteColourKeys(file: string): Map<string, string[]> {
  const src = readFileSync(path.resolve(__dirname, '../../../..', file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = new Map<string, string[]>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'makeStyles') {
      const create = (function find(x: ts.Node): ts.ObjectLiteralExpression | null {
        if (
          ts.isCallExpression(x) &&
          x.expression.getText(sf) === 'StyleSheet.create' &&
          ts.isObjectLiteralExpression(x.arguments[0]!)
        ) {
          return x.arguments[0] as ts.ObjectLiteralExpression;
        }
        let hit: ts.ObjectLiteralExpression | null = null;
        ts.forEachChild(x, (ch) => {
          hit ??= find(ch);
        });
        return hit;
      })(n);
      for (const prop of create?.properties ?? []) {
        if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) {
          continue;
        }
        const colours: string[] = [];
        for (const p of prop.initializer.properties) {
          if (ts.isPropertyAssignment(p) && /\bc\.\w+/.test(p.initializer.getText(sf))) {
            colours.push(p.name.getText(sf));
          }
        }
        if (colours.length > 0) out.set(prop.name.getText(sf), colours);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SCREENS: [string, string, (lg: Look) => Record<string, object>][] = [
  ['the Scan tab', 'app/(drawer)/(tabs)/scan.tsx', glassScanStyles],
  ['the Add item card', 'src/components/AddItemCard.tsx', glassAddCardStyles],
  ['the Add book card', 'src/components/AddBookCard.tsx', glassAddCardStyles],
];

describe.each(SCREENS)(
  '%s draws no Classic palette colour in Liquid Glass',
  (_n, file, glassFor) => {
    const keys = paletteColourKeys(file);

    it('reads the Classic palette keys from the file (the check is not empty)', () => {
      expect(keys.size).toBeGreaterThan(4);
    });

    it.each(LOOKS)('%s: every Classic palette colour is replaced', (_look, lg) => {
      const glass = glassFor(lg) as Record<string, Record<string, unknown>>;
      const missing: string[] = [];
      for (const [key, props] of keys) {
        for (const prop of props) {
          if (!glass[key] || !(prop in glass[key]!)) missing.push(`${key}.${prop}`);
        }
      }
      expect(missing).toEqual([]);
    });
  },
);
