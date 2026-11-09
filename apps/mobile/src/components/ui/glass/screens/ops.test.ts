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
    absoluteFill: {},
  },
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));

// ops.tsx also exports its parts (GlassCircleLook and the backdrops); the
// values under test need neither the theme hook nor the material behind them.
vi.mock('../../../../lib/use-theme', () => ({ useTheme: () => ({}) }));
vi.mock('../glass-backdrop', () => ({ GlassBackdrop: 'GlassBackdrop' }));

const { themeValueFor } = await import('../../../../lib/appearance/theme-value');
const { AA_UI, contrast, hexOf } = await import('../../__fixtures__/contrast');
const { GLASS_METRICS } = await import('../metrics');
const { glassFieldBox } = await import('../primitive-styles');
const ops = await import('./ops');

type Look = Parameters<typeof ops.glassOptionRow>[0];

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

describe('the operations screens’ glass parts (native-ops lane)', () => {
  // Mutation caught: the chosen row's ink edge dropped, which left the
  // choice (a member, a preset reason) resting on a fill colour alone.
  it.each(LOOKS)('%s: a chosen sheet row keeps an ink edge at 3:1 on its fill', (_n, lg) => {
    const chosen = ops.glassOptionRow(lg, true);
    const idle = ops.glassOptionRow(lg, false);
    expect(chosen.borderColor).toBe(lg.c.ink);
    expect(idle.borderColor).toBe('transparent');
    // The row keeps Classic's 1pt edge: the recipe never zeroes it.
    expect(chosen).not.toHaveProperty('borderWidth');
    expect(chosen.backgroundColor).toBe(lg.g!.selFill);
    expect(idle.backgroundColor).toBe(lg.ios!.fill);
    const fill = over(String(chosen.backgroundColor), lg.ios!.card);
    expect(contrast(lg.c.ink, fill)).toBeGreaterThanOrEqual(AA_UI);
  });

  it.each(LOOKS)('%s: a set filter chip differs from an unset one by its fill', (_n, lg) => {
    const set = ops.glassFilterChip(lg, true);
    const unset = ops.glassFilterChip(lg, false);
    expect(set.backgroundColor).not.toBe(unset.backgroundColor);
    // A capsule at the chip's own 44pt frame: half its height round.
    expect(set.borderRadius).toBe(22);
    expect(set.borderWidth).toBe(0);
  });

  it.each(LOOKS)('%s: an icon well is the iOS fill with no ring', (_n, lg) => {
    expect(ops.glassIconWell(lg)).toEqual({
      backgroundColor: lg.ios!.fill,
      borderWidth: 0,
      borderColor: 'transparent',
      borderRadius: 10,
    });
  });

  it.each(LOOKS)('%s: a hand-drawn typed box is the glass field in ink', (_n, lg) => {
    expect(ops.glassTypedBox(lg)).toMatchObject({ ...glassFieldBox(lg, false), color: lg.c.ink });
  });

  // .item-actions [768]: 16 from the sides, 22 up, radius 32; the scroll
  // clears the lift by the same 22 (GLASS_ACTION_BAR_LIFT).
  it('the floating action bar sits where the boards put it, and the scroll clears its lift', () => {
    const m = GLASS_METRICS.actionBar;
    expect(ops.GLASS_ACTION_BAR).toMatchObject({
      left: m.left,
      right: m.right,
      bottom: m.bottom,
      borderRadius: m.radius,
      backgroundColor: 'transparent',
      borderTopWidth: 0,
      overflow: 'hidden',
    });
    expect(ops.GLASS_ACTION_BAR_LIFT).toBe(m.bottom);
    expect(ops.GLASS_FOOT_BAR).toMatchObject({
      marginHorizontal: m.left,
      borderRadius: m.radius,
      backgroundColor: 'transparent',
      borderTopWidth: 0,
      overflow: 'hidden',
    });
  });

  it('a record’s body and its pads sit 16 from the sides (.ios-scroll)', () => {
    expect(ops.GLASS_RECORD_BODY).toMatchObject({ paddingHorizontal: 16 });
    expect(ops.GLASS_RECORD_PAD).toEqual({ paddingHorizontal: 16 });
    expect(ops.GLASS_OPS.controls).toEqual({ paddingHorizontal: 16 });
  });

  // Mutation caught (review fix 2026-11-08): words in the floating bar back
  // at its 7pt edge, where the radius-32 corner clips the first line's ends.
  it('words inside the floating bar sit clear of its clipped corners', () => {
    const m = GLASS_METRICS.actionBar;
    const bar = ops.GLASS_ACTION_BAR;
    const note = ops.GLASS_ACTION_BAR_NOTE;
    const x = Number(bar.paddingHorizontal) + Number(note.paddingHorizontal ?? 0);
    const y = Number(bar.paddingTop) + Number(note.paddingTop ?? 0);
    // 16 from the bar's sides, as the boards inset words on a group.
    expect(x).toBe(16);
    // The line's top corner point lies inside the rounded corner:
    // (r - x)^2 + (r - y)^2 <= r^2.
    const r = m.radius;
    expect((r - x) ** 2 + (r - y) ** 2).toBeLessThanOrEqual(r * r);
    // Without the note's inset the bar's own 7pt edge does not clear it at
    // a glyph's cap height (the reviewers' point: x 7, y 10).
    expect((r - Number(bar.paddingHorizontal)) ** 2 + (r - 10) ** 2).toBeGreaterThan(r * r);
  });

  // Mutation caught (review fix 2026-11-08): the capsule's words at Classic's 13.
  it('a nav capsule says its words at 15 with no tracking (.ios-capsule)', () => {
    expect(ops.GLASS_NAV_CAPSULE_LABEL).toEqual({ fontSize: 15, letterSpacing: 0 });
  });

  // Mutation caught (review fix 2026-11-08): the iPad split's rule left as
  // Classic's 1pt hair line.
  it.each(LOOKS)('%s: the split rule is a hairline in --line-2', (_n, lg) => {
    expect(ops.glassSplitRule(lg)).toEqual({ borderLeftWidth: 0.5, borderColor: lg.g!.line2 });
  });

  it('a record title block keeps its meta line 2 under the name (iOS-Item .col.g2)', () => {
    expect(ops.GLASS_RECORD_TITLE_BLOCK).toEqual({ gap: 2 });
    expect(ops.GLASS_RECORD_META).toEqual({ marginTop: 2 });
  });
});
