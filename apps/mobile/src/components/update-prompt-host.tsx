import * as React from 'react';
import { Image, Keyboard, StyleSheet, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { useColdLaunchGate } from '@/lib/cold-launch-gate';
import { LAUNCH_SCREEN_GROUND, RESTARTING_LABEL } from '@/lib/ota-update-prompt';
import { LAUNCH_ICON } from '@/lib/restart-screen';
import {
  UPDATE_PROMPT_LOCK_ID,
  useAnyTourVisibleExcept,
  useWhatsNewOpen,
} from '@/lib/tour-targets';
import { updatePrompt } from '@/lib/use-ota-updates';

/** True while the software keyboard is on screen. */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = React.useState(() => Keyboard.isVisible());
  React.useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return visible;
}

/**
 * The phone update pop-up's view of the screen (B44), mounted by RootGate
 * beside What's New, only in the signed-in shell. It tells the controller
 * (use-ota-updates.ts, rules in ota-update-prompt.ts) who is signed in, which
 * route is on top, and whether the launch animation, the keyboard, What's New
 * or another interruption (a tour, a notification's notice) is up; the pop-up
 * waits for all of them. The pop-up itself is a native alert the controller
 * shows, above every sheet.
 *
 * While Restart now restarts the app it draws the launch screen over
 * everything (the icon on the launch screen's colour), so the person never
 * works on into a restart; expo-updates' reload screen then shows the same
 * picture, and the new version's own launch animation follows, once.
 */
export function UpdatePromptHost({ segments }: { segments: string[] }) {
  const { user } = useAuth();
  const { splashActive } = useColdLaunchGate();
  const whatsNewOpen = useWhatsNewOpen();
  const slotTaken = useAnyTourVisibleExcept(UPDATE_PROMPT_LOCK_ID);
  const keyboardVisible = useKeyboardVisible();
  const userId = user?.id ?? null;
  const routeKey = segments.join('/');

  React.useEffect(() => {
    updatePrompt.setScreen({
      mounted: true,
      userId,
      routeKey,
      splashActive,
      keyboardVisible,
      whatsNewOpen,
      slotTaken,
    });
  }, [userId, routeKey, splashActive, keyboardVisible, whatsNewOpen, slotTaken]);

  React.useEffect(() => () => updatePrompt.setScreen({ mounted: false }), []);

  const phase = React.useSyncExternalStore(updatePrompt.subscribe, updatePrompt.getPhase);
  if (phase !== 'restarting') return null;

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.overlay]}
      // Takes every touch, so nothing underneath can be started mid-restart.
      onStartShouldSetResponder={() => true}
      accessible
      accessibilityViewIsModal
      accessibilityLabel={RESTARTING_LABEL}
    >
      <Image
        source={LAUNCH_ICON}
        resizeMode="contain"
        style={styles.icon}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: LAUNCH_SCREEN_GROUND,
    zIndex: 1000,
    elevation: 1000,
  },
  icon: { width: '100%', height: '100%' },
});
