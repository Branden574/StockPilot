import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { glassCardStyle, glassHairStyle } from './glass/primitive-styles';
import { useGlass } from './glass/use-glass';

/**
 * Card surface — 1px hairline border, flat: the reference draws cards with a
 * hairline and no shadow (only floating layers, sheets and toasts, cast
 * one). The brand uses border deepening on press, never elevation lift.
 */
export function Card({
  children,
  hero = false,
  padding = 0,
  style,
}: {
  children: React.ReactNode;
  hero?: boolean;
  padding?: number;
  style?: ViewStyle | ViewStyle[];
}) {
  const { c } = useTheme();
  const lg = useGlass();
  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: c.card,
          borderColor: c.hair,
          borderRadius: hero ? RADIUS.cardHero : RADIUS.card,
          padding,
        },
        // Liquid Glass: the grouped content surface (card fill over the
        // scene, radius 24, .5pt edge; opaque under Reduce Transparency).
        lg && glassCardStyle(lg),
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Thin 1px hairline divider used inside cards and lists. */
export function Hair({ inset = 0, style }: { inset?: number; style?: ViewStyle }) {
  const { c } = useTheme();
  const lg = useGlass();
  return (
    <View
      style={[
        {
          height: StyleSheet.hairlineWidth || 1,
          backgroundColor: c.hair,
          marginLeft: inset,
        },
        // Liquid Glass: the grouped list's .5pt --line-2 separator.
        lg && glassHairStyle(lg),
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1,
  },
});
