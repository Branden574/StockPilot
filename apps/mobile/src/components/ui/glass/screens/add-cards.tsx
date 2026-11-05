import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { GLASS_METRICS } from '../metrics';
import type { GlassLook } from '../use-glass';

/**
 * The Scan tab's Add item and Add book cards in Liquid Glass: the frame of
 * the board's unknown-barcode sheet (iOS-Scan.dc.html "No item has this
 * barcode": .ios-sheet.glass-strong [740], radius 36, the grabber, a 19/700
 * title over the code in mono) around the cards' own form, which keeps every
 * field, chip, note and button Classic has. The fields, chips and buttons are
 * the shared primitives, so they take their own glass look. Used only inside
 * the cards' `lg` branches.
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

export const glassAddCardStyles = cached((lg: GlassLook) => {
  const m = GLASS_METRICS.sheet;
  const text = (size: number, weight: TextStyle['fontWeight'], color: string): TextStyle => ({
    ...lg.font.displayRegular,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: 0,
    color,
  });
  return StyleSheet.create({
    card: {
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderColor: 'transparent',
      borderRadius: m.radius,
      paddingTop: m.paddingTop,
      paddingHorizontal: m.paddingHorizontal,
      paddingBottom: m.paddingBottom,
    },
    grabber: {
      alignSelf: 'center',
      width: m.grabberWidth,
      height: m.grabberHeight,
      borderRadius: 3,
      marginTop: 2,
      marginBottom: 12,
      backgroundColor: lg.ios.sep,
    },
    headerRow: { gap: 12 },
    // The product photo or book cover keeps its 72 x 96 frame, at the board's
    // tile corner (radius 14), on the white photo ground or --surface-3.
    cover: { borderRadius: 14, borderWidth: 0, borderColor: 'transparent' },
    coverPlaceholder: { backgroundColor: lg.g.surface3 },
    coverPlaceholderText: text(10, '400', lg.c.ink3),
    codeLabel: text(12, '600', lg.c.ink3),
    codeValue: { color: lg.c.ink, fontSize: 13, marginTop: 2 },
    warn: { ...text(13, '400', lg.c.warnText), lineHeight: 18, marginTop: 4 },
    title: { ...text(19, '700', lg.c.ink), lineHeight: 24, letterSpacing: -0.3 },
    body: { ...text(15, '400', lg.c.ink3), lineHeight: 20, marginTop: 4 },
    description: { ...text(15, '400', lg.c.ink3), lineHeight: 20 },
    actions: { gap: 8, marginTop: 18 },
    closeBtn: { marginTop: 14 },
  } satisfies Record<string, ViewStyle | TextStyle>);
});
