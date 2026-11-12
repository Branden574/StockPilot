import { X } from 'lucide-react-native';
import * as React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';

import { AppearanceNoticeCard } from '@/components/appearance-fallback-notice';
import { Button } from '@/components/ui/button';
import { IconChip } from '@/components/ui/row';
import { INTRO_NOTICE } from '@/lib/appearance/labels';
import { useAppearance } from '@/lib/appearance/provider';

/**
 * The one-time "new look" card at the top of Home (revision R13, item 39):
 * Liquid Glass is the default, so a person who never chose a Design is told
 * once, on the screen they see first, that the classic design is one tap
 * away. Shown only under the 'default' rollout, only while Liquid Glass is
 * drawn and the Design is not the person's own choice, never during the
 * crash fallback, and never again once answered or closed on this phone
 * (stockpilot.appearance.intro.v1). The controller decides; this draws.
 *
 *   Use classic design  Classic becomes their Design (the Theme stays), saved
 *                       to their account like any choice;
 *   Keep Liquid Glass   Liquid Glass becomes their own choice, saved;
 *   Close               marks it seen on this phone and chooses nothing.
 *
 * It renders nothing in classic, so classic Home is unchanged.
 */
export function AppearanceIntroNotice() {
  const { introVisible, chooseStyle, keepGlass, dismissIntro } = useAppearance();

  React.useEffect(() => {
    if (introVisible) {
      AccessibilityInfo.announceForAccessibility(`${INTRO_NOTICE.title}. ${INTRO_NOTICE.body}`);
    }
  }, [introVisible]);

  if (!introVisible) return null;
  return (
    <AppearanceNoticeCard
      title={INTRO_NOTICE.title}
      body={INTRO_NOTICE.body}
      style={styles.card}
      accessory={
        <IconChip icon={X} onPress={dismissIntro} accessibilityLabel={INTRO_NOTICE.close} minTap />
      }
    >
      <Button variant="outline" size="sm" wrap onPress={() => chooseStyle('classic')}>
        {INTRO_NOTICE.useClassic}
      </Button>
      <Button variant="primary" size="sm" wrap onPress={keepGlass}>
        {INTRO_NOTICE.keepGlass}
      </Button>
    </AppearanceNoticeCard>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 20, marginTop: 8, marginBottom: 4 },
});
