import { readFileSync } from 'node:fs';
import * as path from 'node:path';

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
const { glassTipFoot, glassTipShape } = await import('./overlays');

type Look = Parameters<typeof glassTipShape>[0];
const MOBILE_ROOT = path.resolve(__dirname, '../../../../..');
const source = (file: string) => readFileSync(path.join(MOBILE_ROOT, file), 'utf8');

describe('the scanner tip in Liquid Glass is the iOS sheet (COVERAGE: inferred from the iOS sheet)', () => {
  it.each([
    ['Day', 'light'],
    ['Night', 'dark'],
  ] as const)(
    '%s: the card is the .ios-sheet at the foot: 8 in, radius 36, padding 8/18, over the glass scrim',
    (_n, mode) => {
      const lg = themeValueFor('liquid-glass', mode, 'glass', true) as Look;
      const shape = glassTipShape(lg);
      expect(shape.card).toMatchObject({
        backgroundColor: 'transparent',
        borderWidth: 0,
        borderRadius: 36,
        marginHorizontal: 8,
        marginBottom: 8,
        paddingTop: 8,
        paddingHorizontal: 18,
        alignSelf: 'stretch',
      });
      // Classic's centred 340pt card does not carry over.
      expect(shape.card.maxWidth).toBeUndefined();
      expect(shape.card.width).toBeUndefined();
      expect(shape.centerWrap).toMatchObject({ justifyContent: 'flex-end', padding: 0 });
      expect(shape.backdrop.backgroundColor).toBe(lg.g.scrim);
    },
  );

  it('the foot is the sheet padding 22, plus the home indicator past the 8pt margin', () => {
    expect(glassTipFoot(0)).toBe(22);
    expect(glassTipFoot(34)).toBe(22 + 26);
  });

  it('draws the material and the grabber as the card’s first children and keeps the recipe’s Classic set', () => {
    const src = source('src/components/scanner-tip.tsx');
    expect(src).toContain(
      '{lg ? <GlassSheetBackdrop /> : null}\n          {lg ? <GlassSheetGrabber /> : null}',
    );
    expect(src).toContain(': TIP_STYLES[mode];');
    expect(src).not.toContain('GLASS_DIALOG_RADIUS');
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
