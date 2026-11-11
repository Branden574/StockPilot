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
const { palette } = await import('../../../../lib/theme');
const { AA_TEXT, AA_UI, contrast, hexOf } = await import('../../__fixtures__/contrast');
const { GLASS_NAV_BADGE, glassOrderStyles, glassOrderTitle, glassPickRing, pickProgress } =
  await import('./order');

type Look = Parameters<typeof glassOrderStyles>[0];

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

describe('the order nav and the pick head say what Classic says', () => {
  it('names the order by its number, and the pick as "Pick" before it', () => {
    expect(glassOrderTitle('SO-000229', false)).toBe('SO-000229');
    expect(glassOrderTitle('SO-000229', true)).toBe('Pick SO-000229');
    expect(glassOrderTitle(null, false)).toBe('Order');
    expect(glassOrderTitle(null, true)).toBe('Pick');
  });

  it('counts finished lines and units from the typed quantities, never past a line', () => {
    const p = pickProgress([
      { requested: 5, picked: 5 },
      { requested: 10, picked: 12 },
      { requested: 12, picked: 3 },
      { requested: 8, picked: 0 },
    ]);
    // 12 typed against 10 counts as 10 units and a finished line.
    expect(p.line).toBe('2 of 4 lines · 18 of 35 units');
    expect(p.units).toBe(18);
    expect(p.totalUnits).toBe(35);
    expect(p.ratio).toBeCloseTo(18 / 35);
  });

  it('an order with nothing requested reads 0 and never divides by zero', () => {
    const p = pickProgress([{ requested: 0, picked: 0 }]);
    expect(p.line).toBe('0 of 1 lines · 0 of 0 units');
    expect(p.ratio).toBe(0);
  });

  it('the nav badge is the board’s 26 pt', () => {
    expect(GLASS_NAV_BADGE).toEqual({ minHeight: 26 });
  });
});

describe.each(LOOKS)('%s', (_name, lg) => {
  const s = glassOrderStyles(lg);

  it('is made once per look', () => {
    expect(glassOrderStyles(lg)).toBe(s);
  });

  it('a saved line takes the ok ring when it covers the line, warn when it is short, none while open', () => {
    expect(glassPickRing(lg, 5, 5)).toBe(s.pickDone);
    expect(glassPickRing(lg, 7, 5)).toBe(s.pickDone);
    expect(glassPickRing(lg, 3, 5)).toBe(s.pickShort);
    expect(glassPickRing(lg, 0, 5)).toBeNull();
    expect(glassPickRing(lg, 4, 0)).toBeNull();
  });

  it('draws no Classic palette colour', () => {
    const classic = new Set(
      (['light', 'dark'] as const).flatMap((m) => Object.values(palette(m)) as string[]),
    );
    const glass = new Set<string>([
      ...(Object.values(lg.c) as string[]),
      ...(Object.values(lg.g) as string[]),
      ...(Object.values(lg.ios) as string[]),
      'rgba(40,36,28,.70)',
      'rgba(255,255,255,.42)',
      'transparent',
    ]);
    for (const [key, style] of Object.entries(s)) {
      for (const [prop, value] of Object.entries(style as Record<string, unknown>)) {
        if (!/color$/i.test(prop)) continue;
        expect(glass.has(value as string), `${key}.${prop} = ${String(value)}`).toBe(true);
        if (!glass.has(value as string)) expect(classic.has(value as string)).toBe(false);
      }
    }
  });

  it('every word the pick and the order buttons draw reads at AA on what it sits on', () => {
    const page = over(lg.g.bg, '#000000');
    const card = lg.material === 'opaque' ? over(lg.ios.card, page) : over(lg.g.cardFill, page);
    const pairs: [string, string, string][] = [
      ['the count in its well', lg.c.ink, over(lg.g.fieldFill, card)],
      ['"of N" and the head line', lg.c.ink3, card],
      ['Saved on the gray capsule', lg.c.ink, over(lg.ios.fill, card)],
      ['Save on the tinted capsule', lg.g.accentText, over(lg.g.accentWash, card)],
      ['Fill all as requested', lg.g.accentText, over(lg.g.accentWash, page)],
      ['Complete picking', lg.g.onAccent, over(lg.g.accent, page)],
      ['a gray action button', lg.c.ink, over(lg.ios.fill, page)],
      ['a refusal on the gray button', lg.c.critText, over(lg.ios.fill, page)],
      ['the commit button', lg.g.onAccent, over(lg.g.accent, page)],
      ['the nav title', lg.c.ink, page],
    ];
    for (const [what, ink, ground] of pairs) {
      expect(contrast(over(ink, ground), ground), what).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('the Picked and Short rings and the count well’s edge read at 3:1 on the card', () => {
    const page = over(lg.g.bg, '#000000');
    const card = lg.material === 'opaque' ? over(lg.ios.card, page) : over(lg.g.cardFill, page);
    expect(contrast(over(lg.g.ok, card), card)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(over(lg.g.warn, card), card)).toBeGreaterThanOrEqual(AA_UI);
    const edge = String(s.pickQty.borderColor);
    expect(contrast(over(edge, card), over(lg.g.fieldFill, card))).toBeGreaterThanOrEqual(AA_UI);
  });
});
