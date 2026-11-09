import type { ViewStyle } from 'react-native';

import type { GlassLook } from '../use-glass';

/**
 * The phone's overlays in Liquid Glass (inferred: the DS dialog as an iOS
 * card, the DS sheet as the iOS sheet). Used only inside `lg` branches;
 * Classic never reaches this file.
 *
 *   dialog   a centred card on the overlay glass with the glass-strong fill
 *            (GlassSheetBackdrop as its first child) at the iOS alert-card
 *            radius 30, the same radius the order screen's dialogs use;
 *   scrim    the glass scrim (--scrim) behind it.
 */
export const GLASS_DIALOG_RADIUS = 30;

/** The scanner tip's card and backdrop laid over its Classic recipe. */
export function glassTipShape(lg: GlassLook): { card: ViewStyle; backdrop: ViewStyle } {
  return {
    card: {
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderColor: 'transparent',
      borderRadius: GLASS_DIALOG_RADIUS,
      shadowOpacity: 0,
      elevation: 0,
    },
    backdrop: { backgroundColor: lg.g.scrim },
  };
}
