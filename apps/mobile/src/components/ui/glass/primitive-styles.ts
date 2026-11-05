import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import type { ButtonVariant } from '../tones';

import { GLASS_METRICS } from './metrics';
import type { GlassLook } from './use-glass';

/**
 * What the shared phone primitives (components/ui/*) draw in Liquid Glass,
 * from the artifact's iOS rules (project/sp.css; line numbers in brackets)
 * and the generated tokens. Classic never reaches this file: each primitive
 * asks for these only inside its `lg ?` / `lg &&` branches.
 *
 * Every builder is cached per look (useTheme() hands out one object per
 * Design, scheme, material and scene), so a list of rows shares one style
 * object per state instead of allocating one per row and render.
 */
function cached<T>(build: (lg: GlassLook) => T): (lg: GlassLook) => T {
  const memo = new WeakMap<GlassLook, T>();
  return (lg) => {
    const hit = memo.get(lg);
    if (hit !== undefined) return hit;
    const value = build(lg);
    memo.set(lg, value);
    return value;
  };
}

/** The opaque material (Reduce Transparency, a low-end phone, Android) draws every layer solid. */
export const isOpaqueLook = (lg: GlassLook) => lg.material === 'opaque';

/**
 * Text-field edge (--input-line, spec/tokens.json variants light.glass and
 * dark.glass; sp.css:1140-1141): drawn at 3:1 or better against the field
 * in every material, unlike --field-line (a white highlight).
 */
export const INPUT_LINE = { light: 'rgba(40,36,28,.70)', dark: 'rgba(255,255,255,.42)' } as const;

/**
 * Content glass: the iOS grouped surface (.ios-group [708, 1042]): the card
 * fill over the scene, radius 24, a .5pt card-line ring; in the reduced
 * material the opaque --ios-card with no ring [1062]. No live blur: the
 * content layer never blurs (the scene photo is pre-blurred).
 */
export const glassCardStyle = cached((lg): ViewStyle => ({
  backgroundColor: isOpaqueLook(lg) ? lg.ios.card : lg.g.cardFill,
  borderColor: lg.g.cardLine,
  borderWidth: isOpaqueLook(lg) ? 0 : StyleSheet.hairlineWidth,
  borderRadius: GLASS_METRICS.group.radius,
}));

/** Row separator inside a group (.ios-row + .ios-row::before [1044]): .5pt --line-2. */
export const glassHairStyle = cached((lg): ViewStyle => ({
  height: StyleSheet.hairlineWidth,
  backgroundColor: lg.g.line2,
}));

/** .ios-row [709-711]: 56 min, 10/16 padding, 12 gap. */
export const GLASS_ROW: ViewStyle = {
  minHeight: GLASS_METRICS.row.minHeight,
  paddingVertical: GLASS_METRICS.row.paddingVertical,
  paddingHorizontal: GLASS_METRICS.row.paddingHorizontal,
  gap: GLASS_METRICS.row.gap,
};

/** Row title 16/21 in the system face. */
export const glassRowTitle = cached((lg): TextStyle => ({
  ...lg.font.displayRegular,
  fontSize: lg.type.row.fontSize,
  lineHeight: lg.type.row.lineHeight,
  letterSpacing: 0,
}));

/**
 * Row sub-line 13/17 (.ios-row .sub [711]) in the system face. Ink-3, not
 * --ios-l2: the translucent l2 falls under 4.5:1 on a card over the plain
 * --bg (the scene photo absent or Reduce Transparency), and the artifact's
 * own legibility pass moves secondary text on glass to ink-3 (sp.css:1049,
 * Handoff-Specs 1.4.3).
 */
export const glassRowSub = cached((lg): TextStyle => ({
  ...lg.font.displayRegular,
  fontSize: lg.type.rowSub.fontSize,
  lineHeight: lg.type.rowSub.lineHeight,
  letterSpacing: 0,
  marginTop: 1,
  color: lg.c.ink3,
}));

/** The 44pt round glass button (.ios-circ [703]); its material is a GlassSurface behind the icon. */
export const GLASS_CIRCLE: ViewStyle = {
  width: GLASS_METRICS.circle.size,
  height: GLASS_METRICS.circle.size,
  borderRadius: GLASS_METRICS.circle.size / 2,
  alignItems: 'center',
  justifyContent: 'center',
};

/** The count on a round button (.ios-badge [747]): 18 tall, danger fill, 11pt 700 tabular. */
export const glassBadge = cached((lg): ViewStyle => ({
  position: 'absolute',
  top: 3,
  right: 3,
  minWidth: 18,
  height: 18,
  paddingHorizontal: 5,
  borderRadius: 9,
  backgroundColor: lg.g.dangerFill,
  alignItems: 'center',
  justifyContent: 'center',
}));

export const GLASS_BADGE_TEXT: TextStyle = {
  color: '#FFFFFF',
  fontSize: 11,
  lineHeight: 13,
  fontWeight: '700',
  fontVariant: ['tabular-nums'],
};

/** .ios-btn [716-720]: 50 min, radius 25, 10/22 padding; the small size is inferred (36, radius 18). */
export const GLASS_BUTTON_FONT = { md: 17, sm: 15 } as const;

function buttonFill(variant: ButtonVariant, lg: GlassLook): string {
  switch (variant) {
    case 'primary':
    case 'accent':
      return lg.g.accent; // .ios-btn.primary: the solid accent
    case 'outline':
      return lg.ios.fill; // .ios-btn.gray
    case 'ghost':
    case 'destructive':
      return 'transparent';
  }
}

function buttonInk(variant: ButtonVariant, lg: GlassLook): string {
  switch (variant) {
    case 'primary':
    case 'accent':
      return lg.g.onAccent;
    case 'outline':
      return lg.c.ink;
    case 'ghost':
      return lg.g.accentText; // a plain iOS button is tinted
    case 'destructive':
      return lg.g.danger;
  }
}

export function glassButtonDrawn(
  lg: GlassLook,
  variant: ButtonVariant,
  size: 'sm' | 'md',
  pressed: boolean,
  disabled: boolean,
): ViewStyle {
  return {
    minHeight: size === 'sm' ? 36 : GLASS_METRICS.button.minHeight,
    paddingVertical: size === 'sm' ? 6 : GLASS_METRICS.button.paddingVertical,
    paddingHorizontal: size === 'sm' ? 14 : GLASS_METRICS.button.paddingHorizontal,
    borderRadius: size === 'sm' ? 18 : GLASS_METRICS.button.radius,
    backgroundColor: buttonFill(variant, lg),
    borderColor: 'transparent',
    borderWidth: 0,
    // [720] disabled .4; the CSS press scale .97 (plan Q18).
    opacity: disabled ? 0.4 : 1,
    transform: [{ scale: pressed ? 0.97 : 1 }],
  };
}

export function glassButtonLabel(
  lg: GlassLook,
  variant: ButtonVariant,
  size: 'sm' | 'md',
): TextStyle {
  return {
    ...lg.font.displaySemi,
    fontSize: GLASS_BUTTON_FONT[size],
    letterSpacing: 0,
    color: buttonInk(variant, lg),
  };
}

/** Display headings in the system face: 700 as .ios-large/.ios-h [702, 706], line 1.2, tracking -1.2%. */
export function glassDisplay(lg: GlassLook, size: number): TextStyle {
  return {
    ...lg.font.displaySemi,
    fontWeight: '700',
    lineHeight: Math.round(size * 1.2),
    letterSpacing: -size * 0.012,
  };
}

/** Body copy in the system face (15/20 on the boards): line 1.35, no tracking. */
export function glassBody(lg: GlassLook, size: number): TextStyle {
  return {
    ...lg.font.displayRegular,
    lineHeight: Math.round(size * 1.35),
    letterSpacing: 0,
  };
}

/**
 * Section eyebrow as the boards draw it ("NEXT FOR YOU": .xs .strong, 12/16
 * 600, +.02em, no em-dash): the system face, upper case kept. Its colour
 * stays the caller's (ink-3 by default), the AA choice over --ios-l2.
 */
export const glassEyebrow = cached((lg): TextStyle => ({
  ...lg.font.displaySemi,
  fontSize: 12,
  lineHeight: 16,
  letterSpacing: 12 * 0.02,
}));

/** A form label (13/18 600, ink-2) over the field. */
export const glassFieldLabel = cached((lg): TextStyle => ({
  ...lg.font.displaySemi,
  fontSize: 13,
  lineHeight: 18,
  letterSpacing: 0,
  color: lg.c.ink2,
}));

/** A text field: the field fill with the 3:1 --input-line edge, radius 12; focus draws the accent edge. */
export function glassFieldBox(lg: GlassLook, focused: boolean): ViewStyle {
  return {
    backgroundColor: lg.g.fieldFill,
    borderColor: focused ? lg.g.focus : INPUT_LINE[lg.mode],
    borderRadius: 12,
  };
}

export const glassFieldInput = cached((lg): TextStyle => ({
  ...lg.font.displayRegular,
  letterSpacing: 0,
}));

/** Status pills as the system face's 12/600 badge words (DS .badge [232]); tones stay the palette's. */
export const glassPillLabel = cached((lg): TextStyle => ({
  ...lg.font.displaySemi,
  fontSize: 12,
  letterSpacing: 0,
}));
export const GLASS_PILL: ViewStyle = { minHeight: 24, paddingHorizontal: 10 };

/** A selection chip as the iOS capsule (.ios-capsule [705, 770-771]): --ios-fill, ink when chosen. */
export function glassChip(lg: GlassLook, active: boolean): ViewStyle {
  return {
    minHeight: 36,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 0,
    backgroundColor: active ? lg.c.ink : lg.ios.fill,
  };
}

export function glassChipLabel(lg: GlassLook, active: boolean): TextStyle {
  return {
    ...lg.font.displaySemi,
    fontSize: 15,
    letterSpacing: 0,
    color: active ? lg.ios.card : lg.c.ink,
  };
}

/** A stat tile on the grouped surface: label 12/16 600 ink-3, value 28 700 tabular. */
export const glassStatLabel = cached((lg): TextStyle => ({
  ...lg.font.displaySemi,
  fontSize: 12,
  lineHeight: 16,
  letterSpacing: 12 * 0.02,
}));
export const glassStatValue = cached((lg): TextStyle => ({
  ...lg.font.displaySemi,
  fontWeight: '700',
  lineHeight: 34,
  letterSpacing: -0.5,
  fontVariant: ['tabular-nums'],
}));
export const glassStatUnit = cached((lg): TextStyle => ({
  ...lg.font.displayRegular,
  fontSize: 13,
  letterSpacing: 0,
}));

/** Thumbnails (.thumb [302]): radius 9 on --surface-3 with no hairline; photos keep their white ground. */
export function glassThumb(lg: GlassLook, hasImage: boolean): ViewStyle {
  return {
    borderRadius: 9,
    borderWidth: 0,
    backgroundColor: hasImage ? '#ffffff' : lg.g.surface3,
  };
}

/**
 * The switch: on is the accent track with a white knob (the artifact's
 * selected controls are accent); off keeps Classic's recipe through the glass
 * palette (a --line-2 track and an ink-3 knob), because a white knob on the
 * pale --ios-fill track would fall under 3:1 (WCAG 1.4.11).
 */
export function glassToggle(lg: GlassLook, value: boolean): { track: string; knob: string } {
  return value ? { track: lg.g.accent, knob: '#FFFFFF' } : { track: lg.c.hair2, knob: lg.c.ink3 };
}

/**
 * The checkbox (.cb [180-189]): the accent fill and an on-accent check when
 * ticked; clear on --surface with the 3:1 --input-line edge (the board's
 * --line-3 falls under 3:1 on a card; stage 3 made the same choice on the
 * web), greyed when disabled.
 */
export function glassCheckboxTone(
  lg: GlassLook,
  value: boolean | 'mixed',
  disabled: boolean,
): { fill: string; border: string; glyph: string | null } {
  if (value === false) {
    return {
      fill: disabled ? lg.c.hair2 : lg.c.card,
      border: INPUT_LINE[lg.mode],
      glyph: null,
    };
  }
  const fill = disabled ? lg.c.ink4 : lg.g.accent;
  return { fill, border: fill, glyph: disabled ? lg.c.card : lg.g.onAccent };
}
