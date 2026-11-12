import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from './glass-surface';
import { GLASS_METRICS } from './metrics';

/**
 * A floating glass action bar (layer 2; the artifact's .item-actions): a
 * 64pt capsule 16pt from the sides and 22pt above the bottom, holding a row of
 * buttons. `bottomOffset` lifts it over a tab bar when the screen has one.
 * Its children keep their own 44pt targets; the bar adds no touch handling.
 */
export function GlassBar({
  children,
  bottomOffset = 0,
  style,
}: {
  children: React.ReactNode;
  bottomOffset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const m = GLASS_METRICS.actionBar;
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.anchor,
        { left: m.left, right: m.right, bottom: Math.max(m.bottom, insets.bottom) + bottomOffset },
      ]}
    >
      <GlassSurface variant="floating" radius={m.radius} style={[styles.bar, style]}>
        {children}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute' },
  bar: {
    minHeight: GLASS_METRICS.actionBar.height,
    flexDirection: 'row',
    alignItems: 'center',
    gap: GLASS_METRICS.actionBar.gap,
    paddingHorizontal: GLASS_METRICS.actionBar.paddingHorizontal,
  },
});
