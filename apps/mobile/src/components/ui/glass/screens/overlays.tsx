import type { ViewStyle } from 'react-native';

import { GLASS_METRICS } from '../metrics';
import { GLASS_SHEET_CARD, GLASS_SHEET_PADDING } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * The phone's overlays in Liquid Glass (inferred: the DS dialog as an iOS
 * card, the DS sheet as the iOS sheet). Used only inside `lg` branches;
 * Classic never reaches this file.
 *
 *   dialog   a centred card on the overlay glass with the glass-strong fill
 *            (GlassSheetBackdrop as its first child) at the iOS alert-card
 *            radius 30, the same radius the order screen's dialogs use (the
 *            mobile tour's floating card);
 *   sheet    the scanner tip (COVERAGE: inferred from the iOS sheet): the
 *            .ios-sheet [740-742] at the foot, 8 from the sides and the
 *            foot, radius 36, the grabber, padding 8/18/22;
 *   scrim    the glass scrim (--scrim) behind either.
 */
export const GLASS_DIALOG_RADIUS = 30;

/**
 * The scanner tip as the iOS sheet, laid over its Classic recipe: the scroll
 * puts the card at the foot instead of the centre (it still scrolls to its
 * button at the largest text sizes), and the card is the sheet card, as wide
 * as the screen less its 8pt insets, with the sheet's padding.
 */
export function glassTipShape(lg: GlassLook): {
  centerWrap: ViewStyle;
  card: ViewStyle;
  backdrop: ViewStyle;
} {
  return {
    centerWrap: {
      justifyContent: 'flex-end',
      alignItems: 'stretch',
      padding: 0,
    },
    card: {
      ...GLASS_SHEET_CARD,
      ...GLASS_SHEET_PADDING,
      width: undefined,
      maxWidth: undefined,
      alignSelf: 'stretch',
    },
    backdrop: { backgroundColor: lg.g.scrim },
  };
}

/** The sheet's foot over the home indicator: its 22pt padding, plus what the inset adds past the 8pt margin. */
export function glassTipFoot(bottomInset: number): number {
  return GLASS_METRICS.sheet.paddingBottom + Math.max(0, bottomInset - GLASS_METRICS.sheet.inset);
}
