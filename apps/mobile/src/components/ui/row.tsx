import * as React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';

import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Generic list row (settings, inventory, drawer). Hairline divider is
 * rendered by the parent (so you can `inset` it past the leading slot).
 */
export function Row({
  leading,
  title,
  subtitle,
  trailing,
  chevron = false,
  onPress,
  style,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const { c } = useTheme();
  const inner = (
    <View style={[styles.row, style]}>
      {leading}
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.ink }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: c.ink4 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? (
        <ChevronRight size={16} color={c.ink4} strokeWidth={1.5} />
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

/**
 * IconChip — 38pt round/squircle button-like icon container used in
 * top-bar slots (notifications, refresh, profile, filters, etc.).
 */
export function IconChip({
  icon: Icon,
  shape = 'square',
  onPress,
  badge,
}: {
  icon: LucideIcon;
  shape?: 'square' | 'circle';
  onPress?: () => void;
  /** Optional unread count. Renders a red pill top-right when > 0. */
  badge?: number;
}) {
  const { c } = useTheme();
  const showBadge = typeof badge === 'number' && badge > 0;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: c.card,
          borderColor: c.hair,
          borderRadius: shape === 'circle' ? 19 : 10,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Icon size={18} color={c.ink} strokeWidth={1.5} />
      {showBadge ? (
        <View style={[styles.badge, { borderColor: c.paper }]}>
          <Text style={styles.badgeText} numberOfLines={1}>
            {badge > 99 ? '99+' : String(badge)}
          </Text>
        </View>
      ) : null}
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
  body: {
    flex: 1,
    minWidth: 0,
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
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 1.5,
    backgroundColor: '#e5484d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    fontFamily: FONT.mono,
  },
});
