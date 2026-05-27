import * as React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * StockPilot brand mark — squircle with the carved S curve and a small
 * filled-circle pip in the top-right. Replicates the web S-curve logo
 * at icon family stroke width (1.6) so it sits alongside Lucide icons
 * without looking foreign.
 */
export function BrandMark({
  size = 28,
  color,
  stroke = 1.6,
}: {
  size?: number;
  color?: string;
  stroke?: number;
}) {
  const { c } = useTheme();
  const fg = color ?? c.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Rect
        x={3}
        y={3}
        width={26}
        height={26}
        rx={6}
        stroke={fg}
        strokeWidth={stroke}
        fill="none"
      />
      <Path
        d="M11 23.5 Q24 23.5 24 19.5 Q24 15.5 18 15.5 Q11 15.5 11 11.5 Q11 7.5 24 7.5"
        stroke={fg}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={24} cy={7.5} r={1.4} fill={fg} />
    </Svg>
  );
}

/** Wordmark — "Stock" bold + "Pilot" lightened. */
export function Wordmark({
  size = 16,
  color,
}: {
  size?: number;
  color?: string;
}) {
  const { c } = useTheme();
  const fg = color ?? c.ink;
  return (
    <View style={styles.wordmark}>
      <Text style={[styles.stock, { color: fg, fontSize: size }]}>
        Stock
      </Text>
      <Text style={[styles.pilot, { color: fg, fontSize: size, opacity: 0.55 }]}>
        Pilot
      </Text>
    </View>
  );
}

/** Mark + wordmark row used in auth headers and drawer headers. */
export function BrandLockup({
  size = 28,
  color,
  style,
}: {
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.lockup, style]}>
      <BrandMark size={size} color={color} />
      <Wordmark size={size * 0.6} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  wordmark: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  stock: {
    fontFamily: FONT.displaySemi,
    letterSpacing: -0.4,
  },
  pilot: {
    fontFamily: FONT.displayRegular,
    letterSpacing: -0.4,
  },
});
