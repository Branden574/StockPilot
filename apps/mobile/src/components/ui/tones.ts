import type { SyncBadgeTone } from '../../lib/sync-badge';
import type { Palette } from '../../lib/theme';

/**
 * The colour recipes the shared primitives draw with, as pure functions of
 * one mode's palette, so tones.test.ts can measure every text and mark
 * against the fill it sits on, in both modes. The primitives themselves
 * import react-native and cannot load in the node test runner; these can.
 *
 * Relative imports on purpose: the test runner does not resolve the `@/`
 * alias, and both imports are types or pure modules.
 */

export interface Tone {
  fg: string;
  bg: string;
  border: string;
}

// ── Buttons ──────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'accent' | 'ghost' | 'destructive' | 'outline';

/**
 * The phone's button hierarchy, decided once here (redesign plan P2.5) and
 * matching the web's rule (DESIGN-SPEC 6.2):
 *
 *   primary      ink fill: committing the work in front of you (Post
 *                receipt, Save count, Distribute, Submit order request)
 *   accent       accent fill: creating something new at page level (New
 *                item, Place an order, Start count)
 *   outline      secondary: elevated fill, stronger border, ink words
 *   ghost        tertiary: words only ("Not now", "Use password instead")
 *   destructive  refusal-red words only, never a full red bar
 *
 * A screen shows at most one ink and one accent button.
 */
export function buttonTone(variant: ButtonVariant, c: Palette): Tone {
  switch (variant) {
    case 'primary':
      return { bg: c.ink, fg: c.paper, border: c.ink };
    case 'accent':
      return { bg: c.accent, fg: c.accentInk, border: c.accent };
    case 'outline':
      return { bg: c.card, fg: c.ink, border: c.hair2 };
    case 'ghost':
      return { bg: 'transparent', fg: c.ink, border: 'transparent' };
    case 'destructive':
      return { bg: 'transparent', fg: c.critText, border: 'transparent' };
  }
}

/**
 * Corner radius per button size: the reference phone's 52pt confirm is
 * radius 14; the 36pt small button takes 10 so the two read as one family.
 * (The pill shape is retired for buttons; status pills keep it.)
 */
export const BUTTON_RADIUS = { sm: 10, md: 14 } as const;

// ── Status pills ─────────────────────────────────────────────────────────

export type PillStatus = 'default' | 'ok' | 'warn' | 'crit';

/**
 * Status pill tones (DESIGN-SPEC 6.10). The toned pills are a wash with the
 * tone's own words and no visible border: the border is painted in the fill
 * colour so the box keeps its 1pt (dynamic-type-layout.ts measures the pill
 * with it). The default pill is the reference's outline tone on the card.
 */
export function pillTone(status: PillStatus, c: Palette): Tone {
  switch (status) {
    case 'ok':
      return { fg: c.accent, bg: c.accentWash, border: c.accentWash };
    case 'warn':
      return { fg: c.warnText, bg: c.warnWash, border: c.warnWash };
    case 'crit':
      return { fg: c.critText, bg: c.critWash, border: c.critWash };
    case 'default':
      return { fg: c.ink3, bg: c.card, border: c.hair2 };
  }
}

// ── Meters: StockBar fills and Sparkline strokes ─────────────────────────

export type MeterKind = 'ok' | 'warn' | 'crit' | 'ink';

/** Fill or stroke for a meter mark, per mode. */
export function meterColor(kind: MeterKind, c: Palette): string {
  switch (kind) {
    case 'ok':
      return c.accent;
    case 'warn':
      return c.warnText;
    case 'crit':
      return c.critText;
    case 'ink':
      return c.ink;
  }
}

/** The track a StockBar fill runs in [--line2], so the fill reads at 3:1+. */
export function meterTrack(c: Palette): string {
  return c.hair2;
}

/** A sparkline's 'ink' kind is the muted ink, as the reference's monochrome line. */
export function sparkStroke(kind: MeterKind, c: Palette): string {
  return kind === 'ink' ? c.ink3 : meterColor(kind, c);
}

// ── The header sync badge's dot ──────────────────────────────────────────

/** The dot colour for each of the sync badge's tones (words: lib/sync-badge.ts). */
export function syncBadgeDot(tone: SyncBadgeTone, c: Palette): string {
  switch (tone) {
    case 'primary':
      return c.ink;
    case 'muted':
      return c.ink3;
    case 'destructive':
      return c.critText;
    case 'success':
      return c.accent;
    case 'warning':
      return c.warnText;
  }
}

/** The sync badge's own surface: the reference's neutral chip. */
export function syncBadgeSurface(c: Palette): Tone {
  return { fg: c.ink2, bg: c.sunk, border: c.hair2 };
}

// ── Toggle ───────────────────────────────────────────────────────────────

/**
 * Track and knob for the settings switch, one recipe for both modes. The
 * knob stands out from its track at 3:1 or more in every state, so the
 * position reads: paper on the ink track when on; muted ink on the
 * stronger-border track when off (and the muted knob stands out from the
 * card too). Before, dark mode drew a white knob on a near-white track (on,
 * 1.05:1) and a card-dark knob on a dark track (off, 1.11:1), and light mode a
 * white knob on a near-white track (off, 1.26:1).
 */
export function toggleTone(value: boolean, c: Palette): { track: string; knob: string } {
  if (value) return { track: c.ink, knob: c.paper };
  return { track: c.hair2, knob: c.ink3 };
}

// ── Fixed colours ────────────────────────────────────────────────────────

/**
 * Skeleton placeholder blocks. The hairline tone, not paper2: in dark mode
 * paper2 is the card colour itself, so the blocks drew nothing on a card.
 */
export function skeletonFill(c: Palette): string {
  return c.hair;
}

/**
 * Behind a product photo, in both modes, so photos shot on white read the
 * same in light and dark (the reference's thumbnail background).
 */
export const PHOTO_BACKGROUND = '#ffffff';

/**
 * The unread-count badge on a header icon chip: one red that carries white
 * digits at AA in both modes (the reference light --dan). The old #e5484d
 * held them at 3.9:1.
 */
export const COUNT_BADGE: Omit<Tone, 'border'> = { bg: '#bc4224', fg: '#ffffff' };
