import * as React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { FONT, RADIUS, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { pillTone, type PillStatus } from './tones';

type Status = PillStatus;

/**
 * Pill — small status indicator with optional dot. Mono-font, uppercase
 * tracking. Use status='ok' for success/synced, 'warn' for pending/low,
 * 'crit' for out-of-stock/failed. The colours per mode are tones.ts
 * `pillTone` (the reference's tinted washes, each measured at AA); the box
 * and the type are unchanged, so dynamic-type-layout.ts `pillWidth` still
 * describes it exactly.
 */
export function Pill({
  children,
  status = 'default',
  dot = true,
  style,
  tone,
}: {
  children: React.ReactNode;
  status?: Status;
  dot?: boolean;
  style?: ViewStyle;
  /**
   * Explicit colours, overriding `status`, for a palette the four-status union
   * cannot express. No screen passes it today: the serial-number pills it was
   * added for now take `status` (redesign P5.6 mapped each serial status to a
   * pillTone, measured at AA). Kept so a future palette has a way in without
   * a hand-rolled copy of this component, which would miss every box and
   * Dynamic Type fix made here.
   */
  tone?: { fg: string; bg: string; border: string };
}) {
  const { c } = useTheme();

  // Caller supplied the palette outright — `status` is not consulted.
  const { fg, bg, border } = tone ?? pillTone(status, c);

  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: bg,
          borderColor: border,
        },
        style,
      ]}
    >
      {dot ? (
        <View style={[styles.dot, { backgroundColor: fg }]} />
      ) : null}
      <Text
        style={[styles.label, { color: fg }]}
        // Chrome cap: a 10.5pt label uncapped paints 21pt of glyph through a
        // 22pt border. Paired with the minHeight box below — the cap keeps
        // the pill from ballooning, the minHeight keeps the label inside it.
        maxFontSizeMultiplier={LABEL_CAP}
      >
        {children}
      </Text>
    </View>
  );
}

/** 10.5pt label against the 20pt chrome ceiling. */
const LABEL_CAP = capTo(10.5, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  base: {
    // minHeight, not height: Pill is the stock-status badge on every Items and
    // Books row, so at larger text sizes the box has to grow with its label
    // rather than clip it.
    minHeight: 22,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 0.4,
    fontWeight: '500',
    // Only bites when a CALLER shrinks the pill (the box defaults to
    // flexShrink: 0, so there is no shrink pressure anywhere else): then the
    // label wraps inside the narrowed box instead of overflowing it.
    flexShrink: 1,
    minWidth: 0,
  },
});
