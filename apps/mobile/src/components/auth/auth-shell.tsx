import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { MintWash } from '@/components/ui/mint-wash';
import { useTheme } from '@/lib/use-theme';

/**
 * Shared chrome for every auth screen — top-anchored brand lockup,
 * faint mint radial wash bleeding from the top-left, 24pt edge gutters.
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
        pointerEvents="none"
        style={{ position: 'absolute', top: -100, left: -80 }}
      >
        <MintWash width={380} height={380} intensity={0.18} />
      </View>

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
    position: 'relative',
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
  },
});
