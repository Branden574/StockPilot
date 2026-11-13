import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: <T>(s: T) => s, hairlineWidth: 0.5, absoluteFill: {} },
  View: () => null,
}));
vi.mock('../glass-surface', () => ({ GlassSurface: () => null }));
vi.mock('../../../../lib/use-theme', () => ({ useTheme: () => ({}) }));

const { themeValueFor } = await import('../../../../lib/appearance/theme-value');
const { AA_TEXT, AA_UI, contrast, hexOf } = await import('../../__fixtures__/contrast');
const {
  GLASS_AUTH,
  GLASS_AUTH_RING,
  GLASS_STATE_GLYPH,
  glassAuthCardFill,
  glassCodeInput,
  glassStateTile,
} = await import('./auth');
const { INPUT_LINE } = await import('../primitive-styles');

type Look = Parameters<typeof glassCodeInput>[0];

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

describe('the sign-in card and the gates keep the boards geometry', () => {
  it('the ring is 8 round a 23 card at 30, and the card pads 32/28/28 inside it', () => {
    expect(GLASS_AUTH_RING).toEqual({ width: 8, radius: 30, cardRadius: 23 });
    for (const panel of [GLASS_AUTH.panel, GLASS_AUTH.gatePanel, GLASS_AUTH.gateCard]) {
      expect(panel.borderRadius).toBe(30);
      expect(panel.paddingTop).toBe(8 + 32);
      expect(panel.paddingHorizontal).toBe(8 + 28);
      expect(panel.paddingBottom).toBe(8 + 28);
    }
    expect(GLASS_AUTH.gateCard.alignItems).toBe('center');
  });

  it('the Classic hero card draws no surface of its own inside the panel', () => {
    expect(GLASS_AUTH.form).toMatchObject({
      backgroundColor: 'transparent',
      borderWidth: 0,
      padding: 0,
      gap: 16,
    });
  });

  it('the state tiles are .empty-ic: 56 at radius 18, the MFA one 48 at 14, a 26pt glyph', () => {
    expect(GLASS_AUTH.tile).toMatchObject({
      width: 56,
      height: 56,
      borderRadius: 18,
      marginBottom: 14,
    });
    expect(GLASS_AUTH.mfaTile).toMatchObject({ width: 48, height: 48, borderRadius: 14 });
    expect(GLASS_STATE_GLYPH).toBe(26);
  });

  it('the gates keep the boards rhythm: MFA .col.g6 under its tile, account disabled .col.g14', () => {
    expect(GLASS_AUTH.iconWrap.marginBottom).toBe(6);
    expect(GLASS_AUTH.gateLine).toEqual({ marginTop: 14, marginBottom: 14 });
  });

  it('the lock is the iOS sheet: 8 in, radius 36, the Face ID tile 64 at radius 20', () => {
    expect(GLASS_AUTH.lockSheet).toMatchObject({
      marginHorizontal: 8,
      marginBottom: 8,
      borderRadius: 36,
    });
    expect(GLASS_AUTH.lockWell).toMatchObject({ width: 64, height: 64, borderRadius: 20 });
  });
});

describe.each(LOOKS)("%s: the card in the ring is the board's .card", (_name, lg) => {
  it('the card fill with a hairline card-line edge at radius 23 (sp.css .card; auth.glass.css)', () => {
    expect(glassAuthCardFill(lg)).toEqual({
      backgroundColor: lg.g.cardFill,
      borderColor: lg.g.cardLine,
      borderWidth: 0.5,
      borderRadius: 23,
    });
    expect(glassAuthCardFill(lg).backgroundColor).not.toBe(lg.g.glassStrong);
  });

  it('the card is solid in the opaque material (the opaque tokens)', () => {
    if (lg.material === 'opaque') expect(rgbaOf(lg.g.cardFill)[3]).toBe(1);
    else expect(rgbaOf(lg.g.cardFill)[3]).toBeLessThan(1);
  });
});

describe.each(LOOKS)('%s: the gates read at AA', (_name, lg) => {
  const page = over(lg.g.bg, '#000000');
  // The card fill over the ring's glass (its CSS twin, --glass) over the page.
  const card = over(lg.g.cardFill, over(lg.g.glass, page));

  it('words on the panel card and the lock sheet', () => {
    expect(contrast(over(lg.c.ink, card), card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(over(lg.c.ink2, card), card)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('the state tiles', () => {
    const danger = glassStateTile(lg, 'danger');
    const dangerGround = over(danger.fill, card);
    expect(contrast(over(danger.ink, dangerGround), dangerGround)).toBeGreaterThanOrEqual(AA_UI);
    const accent = glassStateTile(lg, 'accent');
    // The MFA shield: .empty-ic's accent wash and accent-text glyph.
    expect(accent).toEqual({ fill: lg.g.accentWash, ink: lg.g.accentText });
    const accentGround = over(accent.fill, card);
    expect(contrast(over(accent.ink, accentGround), accentGround)).toBeGreaterThanOrEqual(AA_UI);
    const face = over(lg.g.accentWash, card);
    expect(contrast(over(lg.g.accentText, face), face)).toBeGreaterThanOrEqual(AA_UI);
  });

  it('the code field: the digits at AA, its line at 3:1, a refusal in the danger line', () => {
    const ok = glassCodeInput(lg, false);
    const bad = glassCodeInput(lg, true);
    expect(ok).toMatchObject({ height: 56, fontSize: 28, borderRadius: 14 });
    expect(ok.borderColor).toBe(INPUT_LINE[lg.mode]);
    expect(bad.borderColor).toBe(lg.g.danger);
    const well = over(lg.g.fieldFill, card);
    expect(contrast(over(lg.c.ink, well), well)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(over(INPUT_LINE[lg.mode], card), card)).toBeGreaterThanOrEqual(AA_UI);
  });
});
