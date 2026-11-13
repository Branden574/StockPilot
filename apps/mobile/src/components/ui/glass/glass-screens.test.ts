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

/**
 * glassRecipe: a screen's own Classic recipe (makeStyles(c: Palette)) run on
 * the glass palette, so no Classic colour can survive it by construction;
 * each Classic face swapped for the glass face of the same role (the system
 * face; references stay mono); then the screen's glass shape laid over it.
 */
describe('glassRecipe: the Classic recipe drawn in the glass palette and faces', async () => {
  const { glassRecipe } = await import('./merge-styles');
  const { palette, FONT } = await import('../../../lib/theme');
  const make = (c: ReturnType<typeof palette>) => ({
    root: { flex: 1, backgroundColor: c.paper },
    title: { color: c.ink, fontFamily: FONT.display, fontSize: 20 },
    sku: { color: c.ink3, fontFamily: FONT.monoRegular, fontSize: 11 },
    semi: { color: c.ink, fontFamily: FONT.displaySemi, fontWeight: '600' as const },
    card: { backgroundColor: c.card, borderColor: c.hair, borderWidth: 1 },
  });
  const shape = (lg: Look) => ({ card: { borderRadius: 24, backgroundColor: lg.g.cardFill } });

  it.each(LOOKS)('%s: every colour is the glass palette, every face the glass role', (_n, lg) => {
    const s = glassRecipe(lg, make, shape);
    const classicColours = new Set(
      (['light', 'dark'] as const).flatMap((m) => Object.values(palette(m))),
    );
    const glassColours = new Set([...Object.values(lg.c), ...Object.values(lg.g)]);
    for (const [key, style] of Object.entries(s)) {
      for (const [prop, value] of Object.entries(style as Record<string, unknown>)) {
        if (!/color$/i.test(prop)) continue;
        expect(glassColours.has(value as string), `${key}.${prop} = ${String(value)}`).toBe(true);
        if (!glassColours.has(value as string))
          expect(classicColours.has(value as string)).toBe(false);
      }
    }
    expect(s.title).toMatchObject({ ...lg.font.display, fontSize: 20 });
    expect(s.semi).toMatchObject(lg.font.displaySemi);
    // References keep the bundled mono face.
    expect(s.sku.fontFamily).toBe(FONT.monoRegular);
    expect(s.card).toMatchObject({
      borderRadius: 24,
      backgroundColor: lg.g.cardFill,
      borderWidth: 1,
    });
  });

  it('is made once per look and recipe, and never writes to Classic', () => {
    const [, day] = LOOKS[0]!;
    expect(glassRecipe(day, make, shape)).toBe(glassRecipe(day, make, shape));
    const classic = make(palette('light'));
    glassRecipe(day, () => classic);
    expect(classic.title.fontFamily).toBe(FONT.display);
    expect(classic.root.backgroundColor).toBe(palette('light').paper);
  });
});

describe('the selection chip is the iOS capsule (.ios-capsule [705])', () => {
  it.each(LOOKS)(
    '%s: 44 tall at radius 22 with 6/16 padding; the iOS fill, ink when chosen',
    async (_n, lg) => {
      const { glassChip } = await import('./primitive-styles');
      for (const active of [false, true]) {
        expect(glassChip(lg, active)).toMatchObject({
          minHeight: 44,
          borderRadius: 22,
          paddingVertical: 6,
          paddingHorizontal: 16,
          backgroundColor: active ? lg.c.ink : lg.ios.fill,
        });
      }
    },
  );
});

describe("Items draws the board's large title in the nav (iOS-Lookup: .ios-large.f1 at 30)", () => {
  const file = 'app/(drawer)/(tabs)/inventory.tsx';
  const src = readFileSync(path.resolve(__dirname, '../../../..', file), 'utf8');

  it('the glass nav row holds the 30pt title, flexible, before the trailing circles', async () => {
    const { GLASS_LOOKUP, GLASS_LOOKUP_NAV_TITLE } = await import('./screens/lookup');
    expect(GLASS_LOOKUP_NAV_TITLE).toBe(30);
    expect(GLASS_LOOKUP.navTitle).toMatchObject({ flex: 1, minWidth: 0 });
    const nav = src.slice(
      src.indexOf('<View style={lg ? GLASS_LOOKUP.nav : styles.topbar}>'),
      src.indexOf('<View style={lg ? GLASS_LOOKUP.head : styles.head}>'),
    );
    expect(nav.length).toBeGreaterThan(0);
    const title = nav.indexOf('size={GLASS_LOOKUP_NAV_TITLE}');
    expect(title).toBeGreaterThan(nav.indexOf('accessibilityLabel="Open menu"'));
    expect(title).toBeLessThan(nav.indexOf('accessibilityLabel="New item"'));
    expect(nav).toContain('style={GLASS_LOOKUP.navTitle}');
  });

  it('the 34pt title under the nav is Classic only', () => {
    const head = src.slice(src.indexOf('<View style={lg ? GLASS_LOOKUP.head : styles.head}>'));
    expect(head).toMatch(/\{lg \? null : \(\s*<Display size=\{34\} style=\{\{ marginTop: 12 \}\}>/);
  });
});
