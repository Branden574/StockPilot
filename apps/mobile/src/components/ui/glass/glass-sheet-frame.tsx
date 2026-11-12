import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../../lib/use-theme';

import { GlassSurface } from './glass-surface';
import { GLASS_METRICS } from './metrics';

/**
 * The frame of a glass sheet (layer 3; the artifact's .ios-sheet): the
 * scheme's scrim (it tints, never blurs) with the sheet floating 8pt from the
 * edges, radius 36, a grabber, and one glass surface behind the content.
 *
 * Put it inside the screen's own Modal (components/ui/modal.tsx keeps the
 * phone update pop-up waiting while it shows). The scrim is a SIBLING of the
 * sheet, never its parent, so VoiceOver reads the sheet's own controls one by
 * one and the sheet scrolls (the sheet-backdrop guard's rule).
 */
export function GlassSheetFrame({
  children,
  onDismiss,
  dismissLabel = 'Close',
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  const { g, c, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const m = GLASS_METRICS.sheet;
  // Classic never draws this frame; its own sheets keep their scrims.
  const scrim = g?.scrim ?? (mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)');
  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dismissLabel}
        onPress={onDismiss}
        style={[StyleSheet.absoluteFill, { backgroundColor: scrim }]}
      />
      <GlassSurface
        variant="overlay"
        radius={m.radius}
        style={{
          marginHorizontal: m.inset,
          marginBottom: Math.max(m.inset, insets.bottom),
          paddingTop: m.paddingTop,
          paddingHorizontal: m.paddingHorizontal,
          paddingBottom: m.paddingBottom,
          gap: m.gap,
        }}
      >
        <View
          style={[
            styles.grabber,
            {
              width: m.grabberWidth,
              height: m.grabberHeight,
              backgroundColor: g?.line3 ?? c.hair2,
            },
          ]}
        />
        {children}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  grabber: { alignSelf: 'center', borderRadius: 3, marginTop: 2, marginBottom: 4 },
});
