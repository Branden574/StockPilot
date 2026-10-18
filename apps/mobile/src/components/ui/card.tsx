import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Thin 1px hairline divider used inside cards and lists. */
export function Hair({
  inset = 0,
  style,
}: {
  inset?: number;
  style?: ViewStyle;
}) {
  const { c } = useTheme();
  return (
    <View
      style={[
        {
          height: StyleSheet.hairlineWidth || 1,
          backgroundColor: c.hair,
          marginLeft: inset,
        },
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
