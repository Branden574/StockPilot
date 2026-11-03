import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GLASS_DAY, GLASS_DAY_OPAQUE, GLASS_NIGHT, GLASS_NIGHT_OPAQUE, palette } from '../theme';
import {
  GLASS_IOS_TOKENS,
  GLASS_MD_TOKENS,
  GLASS_TOKENS,
  GLASS_TYPE_TOKENS,
} from './glass-tokens.generated';

/**
 * The phone's glass values come from the artifact through the generator, never
 * typed by hand (plan 5.1, 5.3).
 */
const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const SOURCE = JSON.parse(
  readFileSync(path.join(__dirname, 'glass-tokens.source.json'), 'utf8'),
) as { variants: Record<string, Record<string, string>> };

describe('generated glass tokens', () => {
  it('the committed file is exactly what the generator writes from the source', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/gen-glass-tokens.mjs', '--check'], {
        cwd: MOBILE_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('the translucent variants carry the artifact values as written', () => {
    expect(GLASS_TOKENS.day.bg).toBe(SOURCE.variants['light.glass']!['--bg']);
    expect(GLASS_TOKENS.day.accent).toBe('#0B7A5C');
    expect(GLASS_TOKENS.night.accent).toBe('#3FCB9B');
    expect(GLASS_TOKENS.day.cardFill).toBe(SOURCE.variants['light.glass']!['--card-fill']);
    expect(GLASS_TOKENS.night.glass).toBe(SOURCE.variants['dark.glass']!['--glass']);
  });

  it('finding F1: in the opaque variants floating and overlay glass is opaque (--chrome), in both schemes', () => {
    for (const t of [GLASS_TOKENS.dayOpaque, GLASS_TOKENS.nightOpaque]) {
      expect(t.glass).toBe(t.chrome);
      expect(t.glassStrong).toBe(t.chrome);
      expect(t.glassClear).toBe(t.chrome);
      expect(t.glassRing).toBe(t.line2);
      expect(t.pane).toBe('transparent');
      expect(t.chrome).toMatch(/^#[0-9A-F]{6}$/i);
    }
    // The literal dark reduced CSS was translucent; the generator fixed it.
    expect(SOURCE.variants['dark.reduced']!['--glass']).toMatch(/^rgba/);
    expect(GLASS_TOKENS.nightOpaque.glass).toBe('#1A1E1C');
  });

  it('every value is a plain colour React Native can draw', () => {
    const colour = /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|transparent)$/i;
    for (const group of [GLASS_TOKENS, GLASS_IOS_TOKENS, GLASS_MD_TOKENS]) {
      for (const variant of Object.values(group)) {
        for (const [k, v] of Object.entries(variant as Record<string, string>)) {
          expect(v, k).toMatch(colour);
        }
      }
    }
  });

  it('the native type scale is the artifact’s', () => {
    expect(GLASS_TYPE_TOKENS.largeTitle).toEqual({
      fontSize: 34,
      lineHeight: 41,
      fontWeight: '700',
      letterSpacing: -0.4,
    });
    expect(GLASS_TYPE_TOKENS.tab).toEqual({ fontSize: 10.5, fontWeight: '600' });
    expect(GLASS_TYPE_TOKENS.rowSub).toEqual({ fontSize: 13, lineHeight: 17 });
    expect(GLASS_TYPE_TOKENS.stepper.fontVariant).toEqual(['tabular-nums']);
  });
});

describe('glass palettes', () => {
  it('map the tokens onto the classic Palette shape, so screens draw them without a branch', () => {
    expect(GLASS_DAY).toMatchObject({
      paper: GLASS_TOKENS.day.bg,
      card: GLASS_TOKENS.day.surface,
      ink: GLASS_TOKENS.day.ink,
      ink3: GLASS_TOKENS.day.ink3,
      accent: GLASS_TOKENS.day.accent,
      accentInk: GLASS_TOKENS.day.onAccent,
      critText: GLASS_TOKENS.day.danger,
    });
    expect(GLASS_NIGHT.paper).toBe(GLASS_TOKENS.night.bg);
    expect(GLASS_DAY_OPAQUE.card).toBe(GLASS_TOKENS.dayOpaque.cardFill);
    expect(GLASS_NIGHT_OPAQUE.card).toBe(GLASS_TOKENS.nightOpaque.cardFill);
    expect(Object.keys(GLASS_DAY).sort()).toEqual(Object.keys(palette('light')).sort());
  });

  it('paint c.card opaque in every glass palette, so a sheet, sticky bar or menu hides the page under it', () => {
    // About a hundred files paint sheets, sticky bars and menus with
    // `backgroundColor: c.card` over a light scrim; a translucent card there
    // would show the page's text through the sheet. The frosted content card
    // is GlassSurface variant="content", which reads g.cardFill itself.
    const opaque = (colour: string) =>
      /^#[0-9a-f]{6}$/i.test(colour) ||
      /^rgba?\((\s*[\d.]+\s*,){2}\s*[\d.]+\s*(,\s*(1|1\.0+)\s*)?\)$/.test(colour);
    for (const [name, p] of [
      ['Day glass', GLASS_DAY],
      ['Night glass', GLASS_NIGHT],
      ['Day glass, opaque', GLASS_DAY_OPAQUE],
      ['Night glass, opaque', GLASS_NIGHT_OPAQUE],
    ] as const) {
      expect(opaque(p.card), `${name} card ${p.card}`).toBe(true);
      expect(opaque(p.paper), `${name} paper ${p.paper}`).toBe(true);
    }
    // The opaque twins keep exactly the values they had: their --surface is their card fill.
    expect(GLASS_TOKENS.dayOpaque.surface).toBe(GLASS_TOKENS.dayOpaque.cardFill);
    expect(GLASS_TOKENS.nightOpaque.surface).toBe(GLASS_TOKENS.nightOpaque.cardFill);
  });

  it('leave the classic palettes untouched', () => {
    expect(palette('light').paper).toBe('#fafaf7');
    expect(palette('dark').paper).toBe('#0c0d0a');
    expect(palette('light').accent).toBe('#2f7463');
    expect(palette('dark').accent).toBe('#7acdb8');
  });
});
