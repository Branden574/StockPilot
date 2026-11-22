import * as React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
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
 *
 * Under the brand bar the screen's content scrolls when it is taller than the
 * room it has (the accessibility text sizes, AX3 to AX5, on an iPhone SE or
 * with the number pad up), so every button stays reachable and no text is
 * capped (the Dynamic Type policy: body copy is never capped). When it fits,
 * nothing moves: the content container grows to the full height, so a screen
 * laid out with flex (the lock's centre and footer, a sheet at the foot) keeps
 * its places, and it does not bounce. The scroll sits in a keyboard-avoiding
 * view (padding on iOS; Android resizes the window itself), so the code
 * screen's Verify and its way out scroll clear of the number pad, and a tap
 * on a button while the pad is up presses it.
 *
 * `scroll={false}` is for a screen that brings its own ScrollView and
 * keyboard-avoiding view (sign-in): two of each would nest and pad twice.
 */
export function AuthShell({
  children,
  contentStyle,
  scroll = true,
}: {
  children: React.ReactNode;
  contentStyle?: ViewStyle;
  scroll?: boolean;
}) {
  const { c } = useTheme();
  // Liquid Glass: the scene behind the brand bar and the screen's card (the
  // Auth-SignIn-Mobile frame); the bar and the content keep their places.
  const lg = useGlass();
  const insets = useSafeAreaInsets();

  const content = (
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
  );

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

      {scroll ? (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            style={styles.fill}
            contentContainerStyle={styles.scrollContent}
            alwaysBounceVertical={false}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {content}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
  },
});
