import * as React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';

import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { GlassBackdrop } from './glass/glass-backdrop';
import {
  GLASS_BADGE_TEXT,
  GLASS_CIRCLE,
  GLASS_ROW,
  glassBadge,
  glassRowSub,
  glassRowTitle,
} from './glass/primitive-styles';
import { useGlass } from './glass/use-glass';
import { COUNT_BADGE } from './tones';

/**
 * Generic list row (settings, inventory, drawer). Hairline divider is
 * rendered by the parent (so you can `inset` it past the leading slot).
 *
 * Dynamic Type: no cap here, deliberately. The box model is already right —
 * `minHeight: 56` on the row and `flex: 1, minWidth: 0` on the body mean the
 * row grows and the text column yields correctly at any text size. The only
 * defect was the hardcoded `numberOfLines={1}`, which threw the content away
 * instead of wrapping it, so the default is now 2.
 *
 * The `trailing` slot is the one part that does NOT yield: it holds badges
 * like the Home screen's Bundles Pill, which have no break opportunity and so
 * take their full intrinsic width out of the body's share. Measured on a 402pt
 * device, that leaves the Bundles subtitle ~150pt at AX3 — under the width
 * "Distribute" needs, so iOS breaks the glyph run ("Distribu / te kits…").
 * Past the shared `shouldStackRow` threshold the badge moves under the
 * subtitle and the body reclaims it. No cap: the subtitle is body copy.
 *
 * The subtitle is muted ink (ink3): it is information (a SKU, a count, a
 * date), and ink4 held it under AA. The chevron stays ink4, a decorative
 * arrow, as in the reference.
 */
export function Row({
  leading,
  title,
  subtitle,
  trailing,
  chevron = false,
  onPress,
  style,
  numberOfLines = 2,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
  /** Lines allowed for the title and subtitle. Defaults to 2. */
  numberOfLines?: number;
}) {
  const { c } = useTheme();
  const lg = useGlass();
  const { fontScale } = useWindowDimensions();
  const stacked = shouldStackRow(fontScale) && !!trailing;
  const inner = (
    <View style={[styles.row, stacked && styles.rowStacked, lg && GLASS_ROW, style]}>
      {leading}
      <View style={styles.body}>
        <Text
          style={[styles.title, { color: c.ink }, lg && glassRowTitle(lg)]}
          numberOfLines={numberOfLines}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={[styles.subtitle, { color: c.ink3 }, lg && glassRowSub(lg)]}
            numberOfLines={numberOfLines}
          >
            {subtitle}
          </Text>
        ) : null}
        {stacked ? <View style={styles.trailingStacked}>{trailing}</View> : null}
      </View>
      {stacked ? null : trailing}
      {chevron ? (
        <ChevronRight
          size={lg ? 14 : 16}
          color={lg ? lg.ios.l2 : c.ink4}
          strokeWidth={lg ? 1.8 : 1.5}
        />
      ) : null}
    </View>
  );

  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: c.hair }}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {inner}
    </Pressable>
  );
}

/** The iOS minimum tap target, in points. */
const MIN_TAP = 44;

/**
 * IconChip — 38pt round/squircle button-like icon container used in
 * top-bar slots (notifications, refresh, profile, filters, etc.). Its edge is
 * the stronger border (hair2): it is a control, not a card.
 */
export function IconChip({
  icon: Icon,
  shape = 'square',
  onPress,
  badge,
  accessibilityLabel,
  minTap = false,
}: {
  icon: LucideIcon;
  shape?: 'square' | 'circle';
  onPress?: () => void;
  /** Optional unread count. Renders a red pill top-right when > 0. */
  badge?: number;
  /**
   * What VoiceOver says for this icon-only button ("New rental", "Back").
   * Without one the chip has no words to read (the icon is not text); with
   * one it is also announced as a button.
   */
  accessibilityLabel?: string;
  /**
   * A 44pt tap target around the same 38pt chip: the button becomes a
   * transparent 44 x 44 frame with the chip centred in it. A real frame, not
   * hitSlop, so the target VoiceOver outlines is the one a finger can hit.
   * The frame is 3pt wider than the chip on every side, so a caller that
   * wants the chip where a plain one sits takes 3pt off its own padding.
   */
  minTap?: boolean;
}) {
  const { c } = useTheme();
  const lg = useGlass();
  const showBadge = typeof badge === 'number' && badge > 0;
  // Liquid Glass: the 44pt round glass button of the iOS boards (.ios-circ),
  // its material behind the icon; the count is the boards' .ios-badge.
  const chipStyle = lg
    ? GLASS_CIRCLE
    : [
        styles.chip,
        {
          backgroundColor: c.card,
          borderColor: c.hair2,
          borderRadius: shape === 'circle' ? 19 : 10,
        },
      ];
  const face = (
    <>
      {lg ? (
        <GlassBackdrop variant="floating" radius={GLASS_CIRCLE.borderRadius as number} />
      ) : null}
      <Icon size={lg ? 20 : 18} color={c.ink} strokeWidth={lg ? 1.8 : 1.5} />
      {showBadge ? (
        <View style={lg ? glassBadge(lg) : [styles.badge, { borderColor: c.paper }]}>
          {/*
            The one place in the shared primitives that opts out of Dynamic
            Type entirely, same reasoning as the tab bar
            (app/(drawer)/(tabs)/_layout.tsx:133-142): this is a count inside a
            fixed 18pt circle, absolutely positioned at top:-6/right:-6, so any
            growth overflows onto the NEIGHBOURING header chips rather than
            into its own frame. Capping cannot fix that geometry. The count is
            also duplicated on the destination screen, so pinning it here costs
            the user no information.
          */}
          <Text
            style={lg ? GLASS_BADGE_TEXT : styles.badgeText}
            numberOfLines={1}
            allowFontScaling={false}
          >
            {badge > 99 ? '99+' : String(badge)}
          </Text>
        </View>
      ) : null}
    </>
  );
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={accessibilityLabel ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        minTap ? styles.chipTapFrame : chipStyle,
        // A glass material never sits under a fading parent: glass scales.
        lg ? { transform: [{ scale: pressed ? 0.94 : 1 }] } : { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      {minTap ? <View style={chipStyle}>{face}</View> : face}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 56,
  },
  // Once the trailing badge sits inside the body the row is tall, and centring
  // pins a 40pt thumb and the chevron to the middle of a three-line block.
  // Top-align them so they read against the title, as they do at every other
  // text size.
  rowStacked: { alignItems: 'flex-start' },
  body: {
    flex: 1,
    minWidth: 0,
  },
  // `flexWrap` so a badge wider than the reclaimed column drops rather than
  // squeezes; `flex-start` keeps it badge-width, not column-width.
  trailingStacked: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
  },
  title: {
    fontFamily: FONT.display,
    fontSize: 16,
    letterSpacing: -0.19,
    lineHeight: 19,
  },
  subtitle: {
    marginTop: 3,
    fontFamily: FONT.mono,
    fontSize: 11.5,
    letterSpacing: 0.23,
  },
  chip: {
    width: 38,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipTapFrame: {
    width: MIN_TAP,
    height: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 1.5,
    // White digits at AA in both modes (tones.ts COUNT_BADGE).
    backgroundColor: COUNT_BADGE.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: COUNT_BADGE.fg,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    fontFamily: FONT.mono,
  },
});
