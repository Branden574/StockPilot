import * as React from 'react';
import { View, type ViewStyle } from 'react-native';

/**
 * Former mint radial glow behind hero areas (auth header, Home Quick-Adjust
 * card, Receive AI scan card, AI and Reports heroes).
 *
 * The redesign draws quiet, flat surfaces with no gradients (DESIGN-SPEC 1
 * and 4; brief section 4), so it now paints nothing. It still takes up its
 * box, untouchable, so every caller's layout stays exactly as it was until
 * each screen's owner removes it. `intensity` is accepted and ignored.
 */
export function MintWash({
  width,
  height,
  style,
}: {
  width: number;
  height: number;
  intensity?: number;
  style?: ViewStyle;
}) {
  return <View pointerEvents="none" style={[{ width, height }, style]} />;
}
