import { describe, expect, it } from 'vitest';

import { AA_TEXT, contrast, hexOf } from '../../components/ui/__fixtures__/contrast';
import { GLASS_TOKENS, type GlassTokens } from './glass-tokens.generated';

/**
 * Every word Liquid Glass draws through the shared palette reads at WCAG AA
 * (4.5:1) on the surfaces it sits on, measured on the COMPOSED surface: a
 * translucent card or well over what is under it, here the opaque --bg (what
 * shows under Reduce Transparency, on Android and while the scene loads).
 * Over the scene illustration itself (committed, scene-assets.ts) the figure
 * depends on the pixels behind each card, which no token fixes: that is the
 * composed-pixel measurement of stage 5.
 */

function rgbaOf(colour: string): [number, number, number, number] {
  const c = colour.trim();
  if (c.startsWith('#')) {
    const [r, g, b] = hexOf(c.length === 4 ? `#${[...c.slice(1)].map((x) => x + x).join('')}` : c)
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

const VARIANTS: [string, GlassTokens][] = [
  ['Day glass', GLASS_TOKENS.day],
  ['Night glass', GLASS_TOKENS.night],
  ['Day glass, opaque', GLASS_TOKENS.dayOpaque],
  ['Night glass, opaque', GLASS_TOKENS.nightOpaque],
];

describe.each(VARIANTS)('%s', (_name, t) => {
  const bg = over(t.bg, '#000000');
  const surfaces: [string, string][] = [
    ['the page', bg],
    ['a card', over(t.cardFill, bg)],
    ['a sheet, sticky bar or menu (c.card, opaque --surface)', over(t.surface, bg)],
    ['a well', over(t.cardFill2, bg)],
  ];
  const words: [string, string][] = [
    ['ink', t.ink],
    ['ink2', t.ink2],
    ['ink3 (secondary words)', t.ink3],
    ['accent', t.accent],
    ['accentText', t.accentText],
    ['warn', t.warn],
    ['danger', t.danger],
    ['ok', t.ok],
  ];

  it.each(surfaces)('every word reads at 4.5:1 on %s', (_s, surface) => {
    for (const [word, colour] of words) {
      expect(contrast(over(colour, bg), surface), word).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('each status word reads at 4.5:1 on its own wash', () => {
    for (const [word, wash] of [
      [t.warn, t.warnWash],
      [t.danger, t.dangerWash],
      [t.ok, t.okWash],
      [t.accentText, t.accentWash],
    ] as const) {
      expect(contrast(over(word, bg), over(wash, bg)), word).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
