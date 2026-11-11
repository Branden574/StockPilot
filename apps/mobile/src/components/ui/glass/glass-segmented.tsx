import * as React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { TYPE_CEILING, capTo } from '../../../lib/theme';
import { useTheme } from '../../../lib/use-theme';

import { GLASS_METRICS } from './metrics';

/**
 * The iOS segmented control on glass (.ios-seg: a 3pt-padded track, radius
 * 20, in --ios-fill; 32pt segments, radius 17, 14pt 600; the chosen one on
 * --ios-card). Each segment is a 44pt tall target: the drawn 32pt segment
 * centred in a 44pt frame whose extra 12pt sits outside the layout (negative
 * vertical margins), so the track keeps its drawn 38pt and no neighbour's
 * target overlaps. Announced as a tab with its selected state.
 */
export function GlassSegmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  const { c, ios, type, font } = useTheme();
  const m = GLASS_METRICS.segmented;
  const label = type?.segmented ?? { fontSize: 14, fontWeight: '600' as const };
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.track,
        {
          padding: m.padding,
          borderRadius: m.radius,
          gap: m.gap,
          backgroundColor: ios?.fill ?? c.sunk,
        },
      ]}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            // iOS React Native gives the role "tab" no trait, so a segment
            // would not be read as a button there (A11Y-1, as the tab bar).
            accessibilityRole={Platform.OS === 'ios' ? 'button' : 'tab'}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={styles.target}
          >
            <View
              style={[
                styles.segment,
                {
                  minHeight: m.segmentHeight,
                  borderRadius: m.segmentRadius,
                  backgroundColor: on ? (ios?.card ?? c.card) : 'transparent',
                },
              ]}
            >
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={capTo(label.fontSize, TYPE_CEILING.control)}
                style={[font.displaySemi, label, { color: c.ink }]}
              >
                {o.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row' },
  target: { flex: 1, minHeight: 44, marginVertical: -6, justifyContent: 'center' },
  segment: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
});
