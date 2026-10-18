import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { useTheme } from '@/lib/use-theme';

/**
 * Shared chrome for every auth screen — top-anchored brand lockup on the
 * flat page colour of the device's mode, 24pt edge gutters. (The mint radial
 * wash it used to bleed from the top-left is gone: the redesign draws quiet,
 * flat surfaces with no gradients, and MintWash already painted nothing.)
 */
export function AuthShell({
  children,
  contentStyle,
}: {
  children: React.ReactNode;
  contentStyle?: ViewStyle;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View
        style={{
          paddingTop: Math.max(insets.top, 24) + 16,
          paddingHorizontal: 24,
          paddingBottom: 12,
        }}
      >
        <BrandLockup size={26} />
      </View>

      <View style={[styles.content, { paddingBottom: insets.bottom }, contentStyle]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
  },
});
