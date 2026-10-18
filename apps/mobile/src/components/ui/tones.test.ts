import { describe, expect, it } from 'vitest';

import { palette, type Palette } from '../../lib/theme';
import type { SyncBadgeTone } from '../../lib/sync-badge';
import { AA_TEXT, AA_UI, contrast } from './__fixtures__/contrast';
import {
  BUTTON_RADIUS,
  COUNT_BADGE,
  PHOTO_BACKGROUND,
  buttonTone,
  meterColor,
  meterTrack,
  pillTone,
  skeletonFill,
  sparkStroke,
  syncBadgeDot,
  syncBadgeSurface,
  toggleTone,
  type ButtonVariant,
  type MeterKind,
  type PillStatus,
} from './tones';

/**
 * THE SHARED PRIMITIVES' COLOURS, MEASURED (redesign package P2.5).
 *
 * The primitives import react-native, which the node runner cannot load, so
 * their colour choices live in tones.ts as pure functions of a palette and
 * are measured here in both modes: words at 4.5:1 on whatever they sit on,
 * marks (meter fills, dots, knobs, badges) at 3:1. Each case names the
 * defect it pins where there was one.
 */

const MODES = ['light', 'dark'] as const;
const each = (fn: (p: Palette, mode: (typeof MODES)[number]) => void) => {
  for (const mode of MODES) fn(palette(mode), mode);
};
/** What a transparent control's words can sit on. */
const GROUNDS = ['paper', 'paper2', 'card', 'sunk'] as const;

describe('buttonTone: the hierarchy, decided once (DESIGN-SPEC 6.2)', () => {
  it('ink fill commits the work in front of you; accent fill creates something new', () => {
    each((p) => {
      expect(buttonTone('primary', p)).toEqual({ bg: p.ink, fg: p.paper, border: p.ink });
      expect(buttonTone('accent', p)).toEqual({ bg: p.accent, fg: p.accentInk, border: p.accent });
      // Secondary: the elevated fill with the stronger border, not a hairline
      // (a control must not rely on a hairline alone).
      expect(buttonTone('outline', p)).toEqual({ bg: p.card, fg: p.ink, border: p.hair2 });
      expect(buttonTone('ghost', p)).toEqual({
        bg: 'transparent',
        fg: p.ink,
        border: 'transparent',
      });
      // Refusal-red words, never a full red bar.
      expect(buttonTone('destructive', p)).toEqual({
        bg: 'transparent',
        fg: p.critText,
        border: 'transparent',
      });
    });
  });

  it('every filled button reads at AA on its own fill', () => {
    each((p, mode) => {
      for (const variant of ['primary', 'accent', 'outline'] as ButtonVariant[]) {
        const t = buttonTone(variant, p);
        expect(contrast(t.fg, t.bg), `${mode} ${variant}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
  });

  // Mutation caught: destructive back on ACCENT.crit (#b03a3a), 3.1-3.3:1 on
  // the dark surfaces.
  it('ghost and destructive words read at AA on every surface they can sit on', () => {
    each((p, mode) => {
      for (const variant of ['ghost', 'destructive'] as ButtonVariant[]) {
        const t = buttonTone(variant, p);
        for (const ground of GROUNDS) {
          expect(
            contrast(t.fg, p[ground]),
            `${mode} ${variant} on ${ground}`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    });
  });

  it('a filled button stands out from the page and the card (3:1)', () => {
    each((p, mode) => {
      for (const variant of ['primary', 'accent'] as ButtonVariant[]) {
        const t = buttonTone(variant, p);
        expect(contrast(t.bg, p.paper), `${mode} ${variant} on paper`).toBeGreaterThanOrEqual(
          AA_UI,
        );
        expect(contrast(t.bg, p.card), `${mode} ${variant} on card`).toBeGreaterThanOrEqual(AA_UI);
      }
    });
  });

  it('radius 14 at the 52pt size and 10 at the 36pt size (the pill shape is retired for buttons)', () => {
    expect(BUTTON_RADIUS).toEqual({ md: 14, sm: 10 });
  });
});

describe('pillTone: status pills (DESIGN-SPEC 6.10)', () => {
  const STATUSES: PillStatus[] = ['default', 'ok', 'warn', 'crit'];

  it("each status's words read at AA on its own fill", () => {
    each((p, mode) => {
      for (const status of STATUSES) {
        const t = pillTone(status, p);
        expect(contrast(t.fg, t.bg), `${mode} ${status}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
  });

  // Mutation caught: warn back on ACCENT.warn (#b97a1d, 3.4:1 on light paper)
  // or crit on ACCENT.crit in dark (3.1:1).
  it('ok, warn and crit are the tone on its wash, with the border in the fill colour', () => {
    each((p) => {
      expect(pillTone('ok', p)).toEqual({ fg: p.accent, bg: p.accentWash, border: p.accentWash });
      expect(pillTone('warn', p)).toEqual({ fg: p.warnText, bg: p.warnWash, border: p.warnWash });
      expect(pillTone('crit', p)).toEqual({ fg: p.critText, bg: p.critWash, border: p.critWash });
      // The box keeps its 1pt border either way (dynamic-type-layout.ts
      // `pillWidth` measures it); the default pill draws it.
      expect(pillTone('default', p)).toEqual({ fg: p.ink3, bg: p.card, border: p.hair2 });
    });
  });

  it('the four statuses look different from each other in both modes', () => {
    each((p) => {
      expect(new Set(STATUSES.map((s) => pillTone(s, p).fg)).size).toBe(4);
      expect(new Set(STATUSES.map((s) => pillTone(s, p).bg)).size).toBe(4);
    });
  });
});

describe('meters: StockBar fills and Sparkline strokes', () => {
  const KINDS: MeterKind[] = ['ok', 'warn', 'crit', 'ink'];

  // Mutation caught: the track back on the hairline (the light mint fill was
  // 1.85:1 against it, so how full a bar was barely showed).
  it('every fill stands out from its track at 3:1, in both modes', () => {
    each((p, mode) => {
      expect(meterTrack(p)).toBe(p.hair2);
      for (const kind of KINDS) {
        expect(
          contrast(meterColor(kind, p), meterTrack(p)),
          `${mode} ${kind}`,
        ).toBeGreaterThanOrEqual(AA_UI);
      }
    });
  });

  it('fills and strokes are the per-mode tones, never the single-mode ACCENT values', () => {
    each((p) => {
      expect(KINDS.map((k) => meterColor(k, p))).toEqual([p.accent, p.warnText, p.critText, p.ink]);
      expect(KINDS.map((k) => sparkStroke(k, p))).toEqual([
        p.accent,
        p.warnText,
        p.critText,
        p.ink3,
      ]);
    });
  });

  it('every sparkline stroke stands out from the card it is drawn on (3:1)', () => {
    each((p, mode) => {
      for (const kind of KINDS) {
        expect(contrast(sparkStroke(kind, p), p.card), `${mode} ${kind}`).toBeGreaterThanOrEqual(
          AA_UI,
        );
      }
    });
  });
});

describe('the header sync badge (SyncStatusBadge)', () => {
  const TONES: SyncBadgeTone[] = ['primary', 'muted', 'destructive', 'success', 'warning'];

  // It was drawn from the light-only legacy `theme` alias; redesign plan P2.5
  // makes it follow the device mode. Its hosts (the light-only
  // cycle-count/[id] header, the always-dark camera bars of scan/[id] and
  // ai-scan/[id]) still mismatch it in dark mode until P5.9 migrates them.
  // The words are lib/sync-badge.ts's, unchanged; only the colours moved.
  it('is the neutral chip of the mode it is drawn in, its words at AA', () => {
    each((p, mode) => {
      const s = syncBadgeSurface(p);
      expect(s).toEqual({ fg: p.ink2, bg: p.sunk, border: p.hair2 });
      expect(contrast(s.fg, s.bg), mode).toBeGreaterThanOrEqual(AA_TEXT);
    });
    expect(syncBadgeSurface(palette('dark')).bg).not.toBe(syncBadgeSurface(palette('light')).bg);
  });

  it("each state's dot (or spinner) stands out from the chip (3:1)", () => {
    each((p, mode) => {
      for (const tone of TONES) {
        expect(
          contrast(syncBadgeDot(tone, p), syncBadgeSurface(p).bg),
          `${mode} ${tone}`,
        ).toBeGreaterThanOrEqual(AA_UI);
      }
    });
  });

  it('the dot repeats the tone the words already carry', () => {
    each((p) => {
      expect(TONES.map((t) => syncBadgeDot(t, p))).toEqual([
        p.ink,
        p.ink3,
        p.critText,
        p.accent,
        p.warnText,
      ]);
    });
  });
});

describe('toggleTone: the settings switch', () => {
  // Mutation caught: the old knob colours (white on the near-white dark "on"
  // track, 1.05:1; the card colour on the dark "off" track, 1.11:1; white on
  // the light "off" track, 1.26:1): where the knob sat could not be seen.
  it('the knob stands out from its track at 3:1 in both states and modes', () => {
    each((p, mode) => {
      for (const value of [true, false]) {
        const { track, knob } = toggleTone(value, p);
        expect(contrast(knob, track), `${mode} ${value ? 'on' : 'off'}`).toBeGreaterThanOrEqual(
          AA_UI,
        );
      }
    });
  });

  it('on is the ink track; the off knob stands out from the card it sits on', () => {
    each((p, mode) => {
      expect(toggleTone(true, p)).toEqual({ track: p.ink, knob: p.paper });
      expect(toggleTone(false, p)).toEqual({ track: p.hair2, knob: p.ink3 });
      expect(
        contrast(toggleTone(true, p).track, p.card),
        `${mode} on track`,
      ).toBeGreaterThanOrEqual(AA_UI);
      expect(
        contrast(toggleTone(false, p).knob, p.card),
        `${mode} off knob`,
      ).toBeGreaterThanOrEqual(AA_UI);
    });
  });
});

describe('fixed colours', () => {
  // Mutation caught: skeleton blocks back on paper2, which is the card colour
  // itself in dark mode, so the loading rows drew nothing there.
  it('skeleton blocks differ from the card they sit on, in both modes', () => {
    each((p, mode) => {
      expect(skeletonFill(p), mode).not.toBe(p.card);
      expect(contrast(skeletonFill(p), p.card), mode).toBeGreaterThan(1.1);
    });
  });

  it('a photo sits on white in both modes (the reference thumbnail ground)', () => {
    expect(PHOTO_BACKGROUND).toBe('#ffffff');
  });

  // Mutation caught: the old #e5484d, which held the white digits at 3.9:1.
  it('the unread-count badge carries white digits at AA and stands out in both modes', () => {
    expect(contrast(COUNT_BADGE.fg, COUNT_BADGE.bg)).toBeGreaterThanOrEqual(AA_TEXT);
    each((p, mode) => {
      expect(contrast(COUNT_BADGE.bg, p.paper), `${mode} paper`).toBeGreaterThanOrEqual(AA_UI);
      expect(contrast(COUNT_BADGE.bg, p.card), `${mode} card`).toBeGreaterThanOrEqual(AA_UI);
    });
  });
});
