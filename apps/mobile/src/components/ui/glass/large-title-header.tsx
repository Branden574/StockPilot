import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { TYPE_CEILING, capTo } from '../../../lib/theme';
import { useTheme } from '../../../lib/use-theme';

import { GLASS_METRICS } from './metrics';

/**
 * The iOS large title (.ios-large: 34/41 700, -0.4) with an optional
 * sub-line, in the system face. A header for VoiceOver. Capped at the
 * display ceiling like every other title (TYPE_CEILING.display), so it grows
 * with Larger Text up to 48pt and then wraps.
 */
export function LargeTitleHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
}) {
  const { c, type, font } = useTheme();
  const large = type?.largeTitle ?? { fontSize: 34, lineHeight: 41, fontWeight: '700' as const };
  const sub = type?.sub ?? { fontSize: 13, lineHeight: 18 };
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={capTo(large.fontSize, TYPE_CEILING.display)}
          style={[font.displaySemi, large, { color: c.ink }]}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={[font.displayRegular, sub, { color: c.ink3 }]}>{subtitle}</Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    marginHorizontal: GLASS_METRICS.largeTitle.marginHorizontal,
  },
  text: { flex: 1, minWidth: 0 },
});
