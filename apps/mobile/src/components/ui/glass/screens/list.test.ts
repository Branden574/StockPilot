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

const { themeValueFor } = await import('../../../../lib/appearance/theme-value');
const { AA_TEXT, AA_UI, contrast, hexOf } = await import('../../__fixtures__/contrast');
const { glassCardStyle } = await import('../primitive-styles');
const { GLASS_LIST, GLASS_LIST_PANEL, glassListTitle } = await import('./list');

type Look = Parameters<typeof glassCardStyle>[0];

/** Every Liquid Glass look a phone can draw: Day and Night, translucent and opaque. */
const LOOKS: [string, Look][] = (
  [
    ['Day glass', 'light', 'glass'],
    ['Night glass', 'dark', 'glass'],
    ['Day, opaque', 'light', 'opaque'],
    ['Night, opaque', 'dark', 'opaque'],
  ] as const
).map(([name, mode, material]) => [
  name,
  themeValueFor('liquid-glass', mode, material, material !== 'opaque') as Look,
]);

function rgbaOf(colour: string): [number, number, number, number] {
  const c = colour.trim();
  if (c.startsWith('#')) {
    const full = c.length === 4 ? `#${[...c.slice(1)].map((x) => x + x).join('')}` : c;
    const [r, g, b] = hexOf(full)
      .slice(1)
      .match(/../g)!
      .map((h) => parseInt(h, 16)) as [number, number, number];
    return [r, g, b, 1];
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (!m) throw new Error(`not a colour: ${colour}`);
  const [r, g, b, a = '1'] = m[1]!.split(',').map((x) => x.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** `top` composited over the opaque `under`, as #rrggbb. */
function over(top: string, under: string): string {
  const [r, g, b, a] = rgbaOf(top);
  const [R, G, B] = rgbaOf(under);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return `#${[mix(r, R), mix(g, G), mix(b, B)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

describe('the list screens’ large title in Liquid Glass', () => {
  it('keeps every word of the title and its emphasis as one plain line', () => {
    expect(glassListTitle('Order', 'requests.')).toBe('Order requests');
    expect(glassListTitle('Tags', '& flags.')).toBe('Tags & flags');
    expect(glassListTitle('Import', 'history.')).toBe('Import history');
  });

  it('a title with no emphasis is the title', () => {
    expect(glassListTitle('Suppliers')).toBe('Suppliers');
    expect(glassListTitle('Suppliers', '')).toBe('Suppliers');
    expect(glassListTitle('Suppliers', '  ')).toBe('Suppliers');
    // An emphasis that is only the closing full stop ("Charters" + ".").
    expect(glassListTitle('Charters', '.')).toBe('Charters');
  });

  it('only a closing full stop goes; words with stops inside stay', () => {
    expect(glassListTitle('U.S.', 'sites.')).toBe('U.S. sites');
    expect(glassListTitle('Rental', 'items')).toBe('Rental items');
  });
});

describe('the list frame’s geometry, from the iOS list boards', () => {
  it('the nav: 52 tall, 16 from the sides, 10 between its round buttons (.ios-nav)', () => {
    expect(GLASS_LIST.nav).toMatchObject({
      minHeight: 52,
      paddingHorizontal: 16,
      gap: 10,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    });
    expect(GLASS_LIST.navGroup).toMatchObject({ flexDirection: 'row', gap: 10 });
  });

  // .ios-large has no margin of its own (sp.css:702): the boards' titles
  // start at the scroll's 16pt edge (iOS-Home, iOS-Lookup, iPad-Compact).
  // Mutation caught: the 4pt of .ios-h / .ios-sub put on the large title.
  it('the large title at the scroll’s 16pt edge, 2pt under the nav (iOS-Home .col.g2)', () => {
    expect(GLASS_LIST.head).toMatchObject({ paddingHorizontal: 16, paddingTop: 2 });
    expect(GLASS_LIST.title).toEqual({ marginTop: 0 });
  });

  // The boards draw a title's meta line under it (iOS-Home: the warehouse
  // and date 2pt under "Home"), never a line over a large title.
  it('the line under the title sits 2pt under it (.ios-sub, margin 0)', () => {
    expect(GLASS_LIST.sub).toEqual({ marginTop: 2 });
  });

  // The scroll's gap between the title block and the first group is 14 on
  // iOS-Lookup and iPad-Compact's Orders list.
  it('the first row 14pt under the head, 16 from the sides', () => {
    expect((GLASS_LIST.head.paddingBottom as number) + (GLASS_LIST.list.paddingTop as number)).toBe(
      14,
    );
    expect(GLASS_LIST.list).toMatchObject({ paddingHorizontal: 16, paddingBottom: 24 });
  });

  // A screen that draws its rows as one surface takes back the frame's gap
  // between rows (screens/movements.tsx LIST_GAP = 10, pinned against
  // Classic's gap in storage-lists-structure.test.ts). Mutation caught: a
  // glass gap of its own (8 drew Movements' rows 2pt over each other).
  it('keeps Classic’s 10pt between rows, so rows drawn as one surface still meet', () => {
    expect(GLASS_LIST.list.gap).toBe(10);
  });

  // iOS-Lookup draws "No items match" inside its group: .col.ac.g8, padding 32 16,
  // the 28pt glyph.
  it('the empty, failed and offline panel: the board’s in-group panel', () => {
    expect(GLASS_LIST.empty).toEqual({
      paddingVertical: 32,
      paddingHorizontal: 16,
      alignItems: 'center',
    });
    expect(GLASS_LIST_PANEL).toEqual({ glyph: 28, gap: 8, strokeWidth: 1.8 });
  });

  // The boards' status line (iOS-Item, iOS-Count): an .ios-group, radius 24,
  // padding 12 14, its parts 10 apart.
  it('the note over rows a failed read left: the board’s status group', () => {
    expect(GLASS_LIST.reloadNote).toEqual({
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 24,
    });
  });
});

describe.each(LOOKS)(
  '%s: every word the frame draws reads at AA on what it sits on',
  (_name, lg) => {
    const page = over(lg.g.bg, '#000000');
    const card = over(String(glassCardStyle(lg).backgroundColor), page);
    const wash = over(lg.c.warnWash, page);

    it('the title and the line under it, on the page', () => {
      expect(contrast(over(lg.c.ink, page), page)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(over(lg.c.ink2, page), page)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it('the panel’s words on the grouped surface, its glyphs at 3:1', () => {
      expect(contrast(over(lg.c.ink, card), card), 'title').toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(over(lg.c.ink3, card), card), 'body').toBeGreaterThanOrEqual(AA_TEXT);
      for (const glyph of [lg.c.ink3, lg.c.warnText]) {
        expect(contrast(over(glyph, card), card), glyph).toBeGreaterThanOrEqual(AA_UI);
      }
    });

    it('the reload note’s words on the warning wash', () => {
      expect(contrast(over(lg.c.warnText, wash), wash)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  },
);
