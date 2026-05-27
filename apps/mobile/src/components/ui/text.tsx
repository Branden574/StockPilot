import * as React from 'react';
import { StyleSheet, Text, View, type TextProps, type ViewStyle } from 'react-native';

import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Eyebrow — JetBrains Mono, 11pt, uppercase, 0.18em tracking, prefixed
 * with an em-dash. This is the brand signature line that sits above
 * every section title and on auth/empty states.
 */
export function Eyebrow({
  children,
  style,
  prefix = '— ',
  color,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  prefix?: string;
  color?: string;
}) {
  const { c } = useTheme();
  return (
    <View style={[styles.eyebrowWrap, style]}>
      <Text
        style={[
          styles.eyebrow,
          { color: color ?? c.ink4 },
        ]}
        numberOfLines={1}
      >
        {prefix}
        {children}
      </Text>
    </View>
  );
}

/**
 * Display heading — Inter Tight 500, tracking -0.028em. Children can
 * embed <Em> for serif-italic emphasis spans (the brand signature).
 */
export function Display({
  children,
  size = 32,
  style,
  color,
}: {
  children: React.ReactNode;
  size?: number;
  style?: TextProps['style'];
  color?: string;
}) {
  const { c } = useTheme();
  return (
    <Text
      style={[
        {
          fontFamily: FONT.display,
          fontSize: size,
          lineHeight: size * 1.05,
          letterSpacing: -size * 0.028,
          color: color ?? c.ink,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * Em — italic emphasis span. Renders inline inside <Display> using
 * Instrument Serif Italic (weight 400) at the parent's size. RN
 * concatenates nested Text elements seamlessly so this acts like
 * an HTML <em>.
 */
export function Em({ children, size }: { children: React.ReactNode; size?: number }) {
  return (
    <Text
      style={{
        fontFamily: FONT.serifItalic,
        fontWeight: '400',
        ...(size ? { fontSize: size, lineHeight: size * 1.05 } : null),
        letterSpacing: -0.4,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Body — Inter Tight 400, 14.5pt, 1.5 line height, ink-3 muted.
 */
export function Body({
  children,
  size = 14.5,
  muted = false,
  style,
  color,
  numberOfLines,
}: {
  children: React.ReactNode;
  size?: number;
  muted?: boolean;
  style?: TextProps['style'];
  color?: string;
  numberOfLines?: number;
}) {
  const { c } = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: FONT.displayRegular,
          fontSize: size,
          lineHeight: size * 1.5,
          color: color ?? (muted ? c.ink3 : c.ink),
          letterSpacing: -size * 0.012,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * Mono — JetBrains Mono for SKUs, barcodes, numeric codes, ETAs.
 */
export function Mono({
  children,
  size = 12,
  style,
  color,
  tracking = 0.04,
  upper = false,
}: {
  children: React.ReactNode;
  size?: number;
  style?: TextProps['style'];
  color?: string;
  tracking?: number;
  upper?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Text
      style={[
        {
          fontFamily: FONT.mono,
          fontSize: size,
          color: color ?? c.ink,
          letterSpacing: size * tracking,
          ...(upper ? { textTransform: 'uppercase' as const } : null),
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  eyebrowWrap: {
    alignSelf: 'flex-start',
  },
  eyebrow: {
    fontFamily: FONT.mono,
    fontSize: 11,
    letterSpacing: 11 * 0.18,
    textTransform: 'uppercase',
    lineHeight: 11 * 1.2,
  },
});
