import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const { themeValueFor } = await import('../../../../lib/appearance/theme-value');
const { GLASS_DIALOG_RADIUS, glassTipShape } = await import('./overlays');

type Look = Parameters<typeof glassTipShape>[0];
const MOBILE_ROOT = path.resolve(__dirname, '../../../../..');
const source = (file: string) => readFileSync(path.join(MOBILE_ROOT, file), 'utf8');

describe('the scanner tip in Liquid Glass', () => {
  it.each([
    ['Day', 'light'],
    ['Night', 'dark'],
  ] as const)(
    '%s: the card is clear for its glass material at the dialog radius, over the glass scrim',
    (_n, mode) => {
      const lg = themeValueFor('liquid-glass', mode, 'glass', true) as Look;
      const shape = glassTipShape(lg);
      expect(shape.card).toMatchObject({
        backgroundColor: 'transparent',
        borderWidth: 0,
        borderRadius: GLASS_DIALOG_RADIUS,
      });
      expect(shape.backdrop.backgroundColor).toBe(lg.g.scrim);
    },
  );

  it('draws the material as the card’s first child and keeps the recipe’s Classic set', () => {
    const src = source('src/components/scanner-tip.tsx');
    expect(src).toContain('{lg ? <GlassSheetBackdrop radius={GLASS_DIALOG_RADIUS} /> : null}');
    expect(src).toContain(': TIP_STYLES[mode];');
  });
});

describe('the signature pad: only its frame takes Liquid Glass', () => {
  const src = source('src/components/signature-pad-modal.tsx');

  it('the writing surface stays opaque white, untouched by any glass branch', () => {
    expect(src).toContain("svg: { backgroundColor: '#fff' }");
    const svgLines = src.split('\n').filter((l) => l.includes('styles.svg'));
    expect(svgLines.length).toBeGreaterThan(0);
    for (const line of svgLines) expect(line).not.toMatch(/\blg\b/);
  });

  it('the frame draws the scene behind the header and the buttons', () => {
    expect(src).toContain("backgroundColor: lg ? 'transparent' : c.paper");
    expect(src).toContain('{lg ? <SceneBackground /> : null}');
  });
});
