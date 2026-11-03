import * as React from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Body } from '@/components/ui/text';
import { FALLBACK_NOTICE } from '@/lib/appearance/labels';
import { useAppearance } from '@/lib/appearance/provider';
import { FONT, RADIUS, SHADOW } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The one-time crash fallback's notice (plan 5.6). Liquid Glass hit a render
 * error last time, so this launch opened in the classic look; the person's
 * choice is still Liquid Glass, untouched. They decide:
 *   Turn Liquid Glass back on  shows it again now (nothing is stored: the
 *                              choice already is Liquid Glass);
 *   Use classic                makes their previous classic look the choice,
 *                              saved like any choice.
 * Drawn in the classic look it opened in, over the top of whatever screen is
 * showing; it renders nothing at any other time.
 */
export function AppearanceFallbackNotice() {
  const { fallbackActive, endFallback } = useAppearance();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();

  React.useEffect(() => {
    if (fallbackActive) AccessibilityInfo.announceForAccessibility(FALLBACK_NOTICE.body);
  }, [fallbackActive]);

  if (!fallbackActive) return null;
  return (
    <View pointerEvents="box-none" style={[styles.anchor, { top: insets.top + 8 }]}>
      <View
        accessibilityRole="alert"
        style={[styles.card, SHADOW.sheet, { backgroundColor: c.card, borderColor: c.hair2 }]}
      >
        <Body size={15} color={c.ink} style={{ fontFamily: FONT.displaySemi }}>
          {FALLBACK_NOTICE.title}
        </Body>
        <Body size={14} color={c.ink2} style={{ marginTop: 4 }}>
          {FALLBACK_NOTICE.body}
        </Body>
        <View style={styles.actions}>
          <Button variant="primary" size="sm" wrap onPress={() => endFallback('glass')}>
            {FALLBACK_NOTICE.turnBackOn}
          </Button>
          <Button variant="outline" size="sm" wrap onPress={() => endFallback('classic')}>
            {FALLBACK_NOTICE.useClassic}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', left: 12, right: 12 },
  card: {
    borderRadius: RADIUS.cardHero,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
});
