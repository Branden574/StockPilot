import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { GlassSurface, type GlassVariant } from './glass-surface';

/**
 * A glass material drawn BEHIND a control's own content, as its first child
 * (absolutely filling it, touches passing through to the control). The
 * control keeps its element, its children and their places, so a screen can
 * add the material in Liquid Glass with `{lg ? <GlassBackdrop .../> : null}`
 * and nothing it already holds (a pressable, a typed field, a list) moves or
 * remounts when the look changes.
 *
 * The parent must not fade below opacity 1 while this is inside it (a
 * GlassView must never sit under a fading ancestor, Expo SDK 57 docs):
 * pressed states scale instead.
 */
export function GlassBackdrop({
  variant,
  radius,
  solid = false,
}: {
  variant: GlassVariant;
  radius: number;
  solid?: boolean;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <GlassSurface
        variant={variant}
        radius={radius}
        solid={solid}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
