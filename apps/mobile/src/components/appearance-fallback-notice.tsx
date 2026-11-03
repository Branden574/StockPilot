import * as React from 'react';
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
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
 * choice is untouched. They decide:
 *   Turn Liquid Glass back on  shows it again now (nothing is stored);
 *   Use classic design         makes Classic their Design (the Theme stays),
 *                              saved like any choice.
 * Drawn in the classic look it opened in, over the top of whatever screen is
 * showing; it renders nothing at any other time.
 */
export function AppearanceFallbackNotice() {
  const { fallbackActive, endFallback } = useAppearance();
  const insets = useSafeAreaInsets();

  React.useEffect(() => {
    if (fallbackActive) AccessibilityInfo.announceForAccessibility(FALLBACK_NOTICE.body);
  }, [fallbackActive]);

  if (!fallbackActive) return null;
  return (
    <View pointerEvents="box-none" style={[styles.anchor, { top: insets.top + 8 }]}>
      <AppearanceNoticeCard title={FALLBACK_NOTICE.title} body={FALLBACK_NOTICE.body} floating>
        <Button variant="primary" size="sm" wrap onPress={() => endFallback('glass')}>
          {FALLBACK_NOTICE.turnBackOn}
        </Button>
        <Button variant="outline" size="sm" wrap onPress={() => endFallback('classic')}>
          {FALLBACK_NOTICE.useClassic}
        </Button>
      </AppearanceNoticeCard>
    </View>
  );
}

/**
 * The appearance notices' card (the crash notice above, and the one-time
 * "new look" card on Home, appearance-intro-notice.tsx): a title, a line of
 * text and a row of actions, read as an alert. `floating` adds the sheet
 * shadow for the copy laid over a screen; `accessory` sits at the top right
 * (the intro card's Close).
 */
export function AppearanceNoticeCard({
  title,
  body,
  floating = false,
  accessory,
  style,
  children,
}: {
  title: string;
  body: string;
  floating?: boolean;
  accessory?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.card,
        floating ? SHADOW.sheet : null,
        { backgroundColor: c.card, borderColor: c.hair2 },
        style,
      ]}
    >
      <View style={styles.head}>
        <Body size={15} color={c.ink} style={[styles.title, { fontFamily: FONT.displaySemi }]}>
          {title}
        </Body>
        {accessory ?? null}
      </View>
      <Body size={14} color={c.ink2} style={{ marginTop: 4 }}>
        {body}
      </Body>
      <View style={styles.actions}>{children}</View>
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
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  title: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
});
