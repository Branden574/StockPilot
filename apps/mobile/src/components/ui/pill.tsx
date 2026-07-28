import * as React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { ACCENT, FONT, RADIUS, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

type Status = 'default' | 'ok' | 'warn' | 'crit';

/**
 * Pill — small status indicator with optional dot. Mono-font, uppercase
 * tracking. Use status='ok' for success/synced, 'warn' for pending/low,
 * 'crit' for out-of-stock/failed.
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
   * Explicit colours, overriding `status`. For palettes the four-status union
   * cannot express — today the six serial-number statuses, which used to be a
   * hand-rolled copy of this component on item/[id].tsx and therefore missed
   * every box and Dynamic Type fix made here.
   */
  tone?: { fg: string; bg: string; border: string };
}) {
  const { c, mode } = useTheme();

  let fg = c.ink3;
  let bg = c.card;
  let border = c.hair;

  if (tone) {
    // Caller supplied the palette outright — `status` is not consulted.
    fg = tone.fg;
    bg = tone.bg;
    border = tone.border;
  } else if (status === 'ok') {
    fg = mode === 'dark' ? ACCENT.mintInkDark : ACCENT.mintInk;
    bg = ACCENT.mintSoft;
    border = 'hsla(165, 38%, 56%, 0.4)';
  } else if (status === 'warn') {
    fg = ACCENT.warn;
    bg = 'rgba(245,176,66,0.10)';
    border = 'rgba(185,122,29,0.3)';
  } else if (status === 'crit') {
    fg = ACCENT.crit;
    bg = 'rgba(176,58,58,0.08)';
    border = 'rgba(176,58,58,0.3)';
  }

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
