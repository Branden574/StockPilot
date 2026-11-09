import { StyleSheet, type ViewStyle } from 'react-native';

import { glassGroupRow } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * The pure values of the admin, settings and help screens in Liquid Glass
 * (screens/admin.tsx draws the parts; stage 4, native-admin lane): tile and
 * monogram colours, the settings rows' separator inset and tone, the Unsent
 * work section heads' tone, and the stacked rows. Kept apart from the parts
 * so the tests read them without a renderer.
 */

/**
 * A settings row's separator inset (--sep-l on the boards' tiled groups):
 * 16 padding, the 30pt tile and the 12pt gap.
 */
export const GLASS_TILED_INSET = 16 + 30 + 12;

/**
 * The fills of the boards' coloured icon tiles (.ios-tile [713]): the
 * accent and the status fills of the tokens, and the iOS-Sync board's two
 * constants (#3D63A8, #6A4FA0). The glyph on them is white and decorative.
 */
export function glassTileFill(lg: GlassLook, tone: GlassTileTone): string {
  switch (tone) {
    case 'accent':
      return lg.g.accent;
    case 'info':
      return lg.g.infoFill;
    case 'ok':
      return lg.g.okFill;
    case 'warn':
      return lg.g.warnFill;
    case 'danger':
      return lg.g.dangerFill;
    case 'blue':
      return '#3D63A8';
    case 'purple':
      return '#6A4FA0';
  }
}

/**
 * The fills of a person's monogram (Routes-Gallery-2's team rows draw each
 * member as a coloured circle with white initials). Every one holds white
 * 13pt 600 text at 4.5:1 or better in both schemes (admin-model.test.ts).
 */
export const GLASS_AVATAR_FILLS = ['#0B7A5C', '#3D63A8', '#6A4FA0', '#A3472B', '#5A6470'] as const;

/** A stable fill for a name, so a person keeps one colour on every visit. */
export function glassAvatarFill(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GLASS_AVATAR_FILLS[h % GLASS_AVATAR_FILLS.length]!;
}

export type GlassTileTone = 'accent' | 'info' | 'ok' | 'warn' | 'danger' | 'blue' | 'purple';

/**
 * The tile colour of a Settings row, by what the row is (the iOS Settings
 * pattern the boards' tiled groups follow: one colour per kind of row). The
 * glyph is decoration; the row's words name it.
 */
export function glassSettingTone(title: string): GlassTileTone {
  if (/delete/i.test(title)) return 'danger';
  if (/unlock|password|two-factor/i.test(title)) return 'blue';
  if (/unsent|offline/i.test(title)) return 'warn';
  if (/appearance|theme|tab bar|what'?s new/i.test(title)) return 'purple';
  if (/notification|push/i.test(title)) return 'danger';
  if (/integration/i.test(title)) return 'info';
  return 'accent';
}

/** #RRGGBB at an alpha (the tab bar's color-mix(var(--ink) 8%, transparent)). */
export function inkAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}

/**
 * One card of a short stack drawn as one grouped surface (.ios-group [708]
 * with its .5pt --line-2 rule between rows [1044], full width here): the
 * group's corners on the first and last, the rule on top of every other.
 */
export function glassStackRow(lg: GlassLook, first: boolean, last: boolean): ViewStyle {
  return {
    ...glassGroupRow(lg, { first, last }),
    ...(first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: lg.g.line2 }),
  };
}

/**
 * The count beside an Unsent work section's heading (iOS-Sync.dc.html): the
 * board's tinted .ios-pill for work that needs checking (the warning wash
 * and words) or was refused (the refusal wash and words), the plain .ios-sub
 * figure in ink-3 for work that is only waiting.
 */
export function glassSyncCountTone(
  lg: GlassLook,
  tone: 'warn' | 'danger' | undefined,
): { wash: string | null; ink: string } {
  if (tone === 'warn') return { wash: lg.c.warnWash, ink: lg.c.warnText };
  if (tone === 'danger') return { wash: lg.c.critWash, ink: lg.c.critText };
  return { wash: null, ink: lg.c.ink3 };
}
