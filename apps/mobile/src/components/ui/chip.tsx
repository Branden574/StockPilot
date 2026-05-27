import * as React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * FilterChip — pill-shaped filter button used in lists (inventory,
 * POs, cycle counts). Active state inverts to ink-on-paper. Mono font
 * with wide tracking, uppercase.
 */
export function FilterChip({
  children,
  active = false,
  onPress,
}: {
  children: React.ReactNode;
  active?: boolean;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          borderColor: active ? c.ink : c.hair,
          backgroundColor: active ? c.ink : c.card,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: active ? c.paper : c.ink2,
          },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 1.47,
    fontWeight: '500',
  },
});
