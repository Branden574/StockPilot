import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * Faint mint radial wash — pure decorative glow behind hero areas
 * (auth header, Home Quick-Adjust card, Receive AI scan card). Uses
 * SVG radial gradient because expo-linear-gradient is linear only.
 *
 * Intentionally very subtle (16% mint at center, transparent at 65%).
 * Brand DNA: mint is the only accent and even here it should feel
 * like a hint, not a wash you "notice."
 */
export function MintWash({
  width,
  height,
  intensity = 0.16,
  style,
}: {
  width: number;
  height: number;
  intensity?: number;
  style?: ViewStyle;
}) {
  return (
    <View pointerEvents="none" style={[{ width, height }, style]}>
      <Svg width={width} height={height}>
        <Defs>
          <RadialGradient
            id="mint"
            cx="50%"
            cy="50%"
            rx="50%"
            ry="50%"
            fx="50%"
            fy="50%"
          >
            <Stop offset="0%" stopColor="hsl(165, 38%, 56%)" stopOpacity={intensity} />
            <Stop offset="65%" stopColor="hsl(165, 38%, 56%)" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={width} height={height} fill="url(#mint)" />
      </Svg>
    </View>
  );
}
