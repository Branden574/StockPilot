import { BlurView } from 'expo-blur';
import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassViewOrNull } from '../../../lib/appearance/glass-module';
import { useTheme } from '../../../lib/use-theme';

/**
 * One glass surface, drawn with the material this device supports
 * (appearance/material.ts, plan 5.2):
 *
 *   floating  layer 2: tab bar, Scan button, sticky action bars.
 *   overlay   layer 3: sheet and menu frames.
 *   content   layer 1: cards and grouped lists. NEVER a live blur: the frost
 *             is the card fill (--card-fill, card line) over the pre-blurred
 *             scene, so a list of these costs nothing extra to scroll.
 *
 *   material glass   floating/overlay: GlassView glassEffectStyle "regular"
 *                    (isInteractive for floating), colorScheme = the scheme.
 *   material blur    floating/overlay: BlurView tint "systemMaterial",
 *                    intensity 80, rendered after its content's siblings;
 *                    `solid` (the tab bar) takes the artifact's solid
 *                    fallback instead (.ios-solidbar: --ios-card, .5pt ring).
 *   material opaque  the opaque token: --chrome (floating, overlay), the
 *                    reduced card fill (content).
 *
 * Rules from the Expo SDK 57 docs, kept here once: never an opacity below 1
 * on a GlassView or its parents (fade with transform instead); never inside
 * FlatList rows (`content` exists for rows and never blurs).
 */
export type GlassVariant = 'floating' | 'overlay' | 'content';

export function GlassSurface({
  variant,
  radius,
  solid = false,
  style,
  children,
}: {
  variant: GlassVariant;
  radius: number;
  /** The tab bar: below iOS 26 (blur material) draw the solid fallback, not a BlurView. */
  solid?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const { c, g, ios, material, mode } = useTheme();
  const shape = { borderRadius: radius };

  if (!g || !ios) {
    // Classic never asks for glass; draw the classic card so a misuse is still readable.
    return <View style={[shape, { backgroundColor: c.card }, style]}>{children}</View>;
  }

  if (variant === 'content') {
    return (
      <View
        style={[
          shape,
          {
            backgroundColor: g.cardFill,
            borderColor: g.cardLine,
            borderWidth: StyleSheet.hairlineWidth,
          },
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  const GlassView = material === 'glass' ? GlassViewOrNull() : null;
  if (GlassView) {
    return (
      // eslint-disable-next-line react-hooks/static-components -- resolved once per JS runtime (glass-module.ts memo), so the same component type on every render
      <GlassView
        glassEffectStyle="regular"
        isInteractive={variant === 'floating'}
        colorScheme={mode}
        style={[shape, style]}
      >
        {children}
      </GlassView>
    );
  }

  // 'glass' without a GlassView (the module went missing after the material
  // was chosen) draws as 'blur', never as nothing.
  const drawn = material === 'glass' ? 'blur' : material;
  if (drawn === 'blur' && !solid) {
    return (
      <View
        style={[
          shape,
          styles.clip,
          { borderColor: g.glassRing, borderWidth: StyleSheet.hairlineWidth },
          style,
        ]}
      >
        <BlurView tint="systemMaterial" intensity={80} style={StyleSheet.absoluteFill} />
        {children}
      </View>
    );
  }

  // The solid fallback (tab bar below iOS 26) and the opaque material.
  const fill = drawn === 'opaque' ? g.chrome : ios.card;
  const ring = drawn === 'opaque' ? g.glassRing : ios.sep;
  return (
    <View
      style={[
        shape,
        { backgroundColor: fill, borderColor: ring, borderWidth: StyleSheet.hairlineWidth },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
