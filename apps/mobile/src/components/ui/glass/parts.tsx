import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { TYPE_CEILING, capTo } from '../../../lib/theme';
import { useTheme } from '../../../lib/use-theme';

import { GlassBackdrop } from './glass-backdrop';
import { GLASS_METRICS } from './metrics';

/**
 * Small Liquid Glass parts the phone screens compose, each one an element of
 * the artifact's iOS boards (project/sp.css; line numbers in brackets). They
 * are drawn only inside a screen's `lg ?` branch, so Classic never renders
 * them; colours come from the theme (the glass palette and tokens).
 */

/** A section heading (.ios-h [706]): 20/25 700 -0.3, 4pt in from the group's edge. A header for VoiceOver. */
export function GlassHeading({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const { c, type, font } = useTheme();
  const h = type?.heading ?? { fontSize: 20, lineHeight: 25, fontWeight: '700' as const };
  return (
    <Text
      accessibilityRole="header"
      maxFontSizeMultiplier={capTo(h.fontSize, TYPE_CEILING.display)}
      style={[font.displaySemi, h, styles.heading, { color: c.ink }, style]}
    >
      {children}
    </Text>
  );
}

/**
 * A screen's sub-line under its title (.ios-sub [707], 13/18) in ink-2, the
 * artifact's legibility override for this line on glass (sp.css:1049).
 */
export function GlassSubline({
  children,
  style,
  numberOfLines,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const { c, type, font } = useTheme();
  const sub = type?.sub ?? { fontSize: 13, lineHeight: 18 };
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[font.displayRegular, sub, { color: c.ink2 }, style]}
    >
      {children}
    </Text>
  );
}

/** A coloured icon tile (.ios-tile [713]): 30pt, radius 8, a 17pt white glyph. */
export function GlassTile({
  icon: Icon,
  fill,
  size = 30,
}: {
  icon: LucideIcon;
  fill: string;
  size?: number;
}) {
  return (
    <View
      style={[styles.tile, { width: size, height: size, backgroundColor: fill }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon size={Math.round(size * 0.57)} color="#FFFFFF" strokeWidth={1.8} />
    </View>
  );
}

/**
 * A capsule of status words on floating glass (.ios-capsule.glass [705]):
 * 44pt tall, radius 22, 15/600 (the boards' sync capsule draws 14pt words).
 * Not a control: it reads as one piece of text.
 */
export function GlassStatusCapsule({
  label,
  accessibilityLabel,
  dot,
}: {
  label: string;
  accessibilityLabel: string;
  dot?: string;
}) {
  const { c, font } = useTheme();
  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={styles.capsule}>
      <GlassBackdrop variant="floating" radius={22} />
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={capTo(14, TYPE_CEILING.control)}
        style={[font.displaySemi, styles.capsuleText, { color: c.ink }]}
      >
        {label}
      </Text>
    </View>
  );
}

/** The accent link words of a section head ("See all 6": .sm .strong .t-accent [115-122]). */
export function GlassLinkText({ children }: { children: React.ReactNode }) {
  const { g, c, font } = useTheme();
  return (
    <Text
      maxFontSizeMultiplier={capTo(13, TYPE_CEILING.control)}
      style={[font.displaySemi, styles.link, { color: g?.accentText ?? c.accent }]}
    >
      {children}
    </Text>
  );
}

/**
 * The look of an iOS button (.ios-btn.primary [716-717]) drawn inside a card
 * that is itself the one control (a View, never a second button), so
 * VoiceOver still hears one button.
 */
export function GlassButtonLook({
  label,
  icon: Icon,
  tone = 'primary',
  style,
}: {
  label: string;
  icon?: LucideIcon;
  tone?: 'primary' | 'gray';
  style?: StyleProp<ViewStyle>;
}) {
  const { g, ios, c, font } = useTheme();
  const primary = tone === 'primary';
  const fill = primary ? (g?.accent ?? c.accent) : (ios?.fill ?? c.sunk);
  const ink = primary ? (g?.onAccent ?? c.accentInk) : c.ink;
  return (
    <View
      style={[styles.button, { backgroundColor: fill }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Icon ? <Icon size={20} color={ink} strokeWidth={1.8} /> : null}
      <Text
        numberOfLines={2}
        maxFontSizeMultiplier={capTo(17, TYPE_CEILING.control)}
        style={[font.displaySemi, styles.buttonText, { color: ink }]}
      >
        {label}
      </Text>
    </View>
  );
}

/** The 4pt-in large title row a screen header uses (.ios-large [702]) with its sub-line. */
export const GLASS_SCREEN = StyleSheet.create({
  /** .ios-scroll [698]: 16 side padding, 22 between sections. */
  scroll: { paddingHorizontal: 16, gap: 22 },
  /** .ios-nav [700]: 52 tall, 16 side padding, 10 gap. */
  nav: {
    minHeight: GLASS_METRICS.nav.height,
    paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
    flexDirection: 'row',
    alignItems: 'center',
    gap: GLASS_METRICS.nav.gap,
  },
  /** A section (.col.g8): its heading 8 above its group. */
  section: { gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /** The "See all" frame: 44pt, 4pt in (.sm link with min-height 44). */
  linkFrame: { minHeight: 44, minWidth: 44, paddingHorizontal: 4, justifyContent: 'center' },
});

const styles = StyleSheet.create({
  heading: { marginHorizontal: 4 },
  tile: { borderRadius: 8, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  capsule: {
    minHeight: 44,
    borderRadius: 22,
    paddingVertical: 6,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  capsuleText: { fontSize: 14, letterSpacing: 0 },
  link: { fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  button: {
    minHeight: GLASS_METRICS.button.minHeight,
    borderRadius: GLASS_METRICS.button.radius,
    paddingVertical: GLASS_METRICS.button.paddingVertical,
    paddingHorizontal: GLASS_METRICS.button.paddingHorizontal,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonText: { fontSize: 17, letterSpacing: 0, textAlign: 'center', flexShrink: 1 },
});
