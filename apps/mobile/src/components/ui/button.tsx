import * as React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { ACCENT, FONT, RADIUS, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

type Variant = 'primary' | 'ghost' | 'destructive' | 'outline';
type Size = 'sm' | 'md';

/**
 * Primary CTA — solid ink-black on light, solid paper on dark. Press
 * scales to 0.98 per brand motion spec. Ghost is borderless (used for
 * "Not now", "Use password instead", etc.). Destructive is text-only
 * crit-red — never a full red bar (per design).
 */
export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  block = false,
  disabled = false,
  leading,
  trailing,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  disabled?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  style?: ViewStyle;
}) {
  const { c, mode } = useTheme();

  const bg =
    variant === 'primary'
      ? c.ink
      : variant === 'outline'
        ? c.card
        : 'transparent';
  const fg =
    variant === 'destructive'
      ? ACCENT.crit
      : variant === 'primary'
        ? c.paper
        : c.ink;
  const border =
    variant === 'outline'
      ? c.hair
      : variant === 'primary'
        ? c.ink
        : 'transparent';

  const minHeight = size === 'sm' ? 36 : 52;
  const padH = size === 'sm' ? 14 : 20;
  const fontSize = size === 'sm' ? 13 : 15.5;

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        {
          // minHeight, not height: the label is allowed to grow to the 22pt
          // control ceiling, and the pill grows with it instead of clipping.
          minHeight,
          paddingVertical: 6,
          paddingHorizontal: padH,
          backgroundColor: bg,
          borderColor: border,
          opacity: disabled ? 0.5 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
          ...(block ? { width: '100%' } : null),
        },
        style,
      ]}
    >
      {leading ? <View style={styles.slot}>{leading}</View> : null}
      <Text
        style={[
          styles.label,
          {
            color: fg,
            fontSize,
          },
        ]}
        numberOfLines={1}
        maxFontSizeMultiplier={capTo(fontSize, TYPE_CEILING.control)}
      >
        {children}
      </Text>
      {trailing ? <View style={styles.slot}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  slot: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontFamily: FONT.display,
    fontWeight: '500',
    letterSpacing: -0.15,
    // Paired with the cap: RN defaults text to flexShrink 0, so without this a
    // numberOfLines={1} label refuses to yield and shoves its sibling out of a
    // two-button footer row instead of ellipsizing inside its own pill.
    flexShrink: 1,
    minWidth: 0,
  },
});
