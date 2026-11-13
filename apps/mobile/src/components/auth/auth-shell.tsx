import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { SceneBackground } from '@/components/ui/glass/scene-background';
import { GLASS_AUTH } from '@/components/ui/glass/screens/auth';
import { useGlass } from '@/components/ui/glass/use-glass';
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
  // Liquid Glass: the scene behind the brand bar and the screen's card (the
  // Auth-SignIn-Mobile frame); the bar and the content keep their places.
  const lg = useGlass();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: lg ? 'transparent' : c.paper }]}>
      {lg ? <SceneBackground /> : null}
      <View
        style={{
          paddingTop: Math.max(insets.top, 24) + 16,
          paddingHorizontal: 24,
          paddingBottom: 12,
        }}
      >
        <BrandLockup size={26} />
      </View>

      <View
        style={[
          styles.content,
          lg && GLASS_AUTH.content,
          { paddingBottom: insets.bottom },
          contentStyle,
        ]}
      >
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
