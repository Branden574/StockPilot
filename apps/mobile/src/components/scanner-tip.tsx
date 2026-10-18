import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useAnimatedValue,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { FONT, SHADOW, palette, space, type Palette } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Demo pill geometry — fixed pixel sizes so the native-driver translateX is
 * exact (the thumb must land dead-center under each label without measuring).
 */
const PILL_W = 180;
const PILL_H = 36;
const PILL_PAD = 4;
const PILL_BORDER = 1;
const THUMB_W = (PILL_W - 2 * PILL_BORDER - 2 * PILL_PAD) / 2; // 85
const THUMB_H = PILL_H - 2 * PILL_BORDER - 2 * PILL_PAD; // 26

/**
 * One-time animated tip shown before the very first document scan: the
 * native scanner auto-captures instantly, and the Auto→Manual shutter
 * toggle (the Ⓐ "Shutter" button in the bottom controls on current iOS) is easy to miss. Centerpiece is a looping demo
 * of that toggle — a thumb sliding from "Auto" to "Manual" with a label
 * emphasis crossfade (~2.2s cycle with holds at each end).
 *
 * All animation is the built-in Animated API with useNativeDriver (opacity
 * + transform only) — OTA-safe for existing runtime-1.1.0 binaries, no new
 * native modules. Reduce-motion (AccessibilityInfo) skips the loop and the
 * entrance spring: static pill showing both labels, plain fades only.
 *
 * Look (redesign P3.8): the card, the demo pill and the button follow the
 * device's mode (it was drawn from the light-only legacy theme, so it stayed
 * light in dark mode). Its one button is the shared ink button.
 */
export function ScannerTip({
  visible,
  onContinue,
  onRequestClose,
}: {
  visible: boolean;
  /** Primary button — dismiss and continue straight into the scanner. */
  onContinue: () => void;
  /** Hardware back (Android) — dismiss without opening the scanner. */
  onRequestClose: () => void;
}) {
  const { mode } = useTheme();
  const styles = TIP_STYLES[mode];
  // Clear of the status bar and the home indicator when the card is taller
  // than the screen, and the same at both ends, so it is centred when it fits.
  const insets = useSafeAreaInsets();
  const edge = Math.max(space.xl, Math.max(insets.top, insets.bottom) + space.sm);
  const [reduceMotion, setReduceMotion] = React.useState(false);
  /** Backdrop fade: 0 → 1 (timing). */
  const backdrop = useAnimatedValue(0);
  /** Card entrance: 0 → 1 drives opacity + translateY (spring). */
  const card = useAnimatedValue(0);
  /** Toggle demo: 0 = Auto, 1 = Manual (looped timing). */
  const demo = useAnimatedValue(0);

  // One-shot reduce-motion probe (same pattern as cold-launch-splash.tsx).
  React.useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (active) setReduceMotion(on);
    });
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    if (!visible) return;
    backdrop.setValue(0);
    card.setValue(0);
    demo.setValue(0);

    Animated.timing(backdrop, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    // Entrance: spring slide-up normally; a plain fade under reduce-motion.
    (reduceMotion
      ? Animated.timing(card, {
          toValue: 1,
          duration: 220,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        })
      : Animated.spring(card, {
          toValue: 1,
          damping: 16,
          stiffness: 200,
          mass: 0.8,
          useNativeDriver: true,
        })
    ).start();

    if (reduceMotion) return;

    // Gentle Auto→Manual loop, ~2.2s per cycle: hold on Auto, ease across,
    // hold on Manual, ease back. Stopped on dismiss/unmount via cleanup.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(650),
        Animated.timing(demo, {
          toValue: 1,
          duration: 480,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.delay(800),
        Animated.timing(demo, {
          toValue: 0,
          duration: 300,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, reduceMotion, backdrop, card, demo]);

  const thumbX = demo.interpolate({ inputRange: [0, 1], outputRange: [0, THUMB_W] });
  const autoEmphasis = demo.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onRequestClose}
    >
      <Animated.View style={[styles.backdrop, { opacity: backdrop }]} />
      {/* The card's button is the only way out on iOS, and at the largest
          text sizes the card is taller than the screen: centred in a plain
          view, the button sat below the bottom edge and the tip could not be
          left. In a scroll view the card is still centred while it fits, and
          scrolls to its button when it does not. */}
      <ScrollView
        contentContainerStyle={[styles.centerWrap, { paddingVertical: edge }]}
        alwaysBounceVertical={false}
      >
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.card,
            {
              opacity: card.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1],
                extrapolate: 'clamp', // spring overshoot must not push opacity past 1
              }),
              transform: [
                {
                  translateY: reduceMotion
                    ? 0
                    : card.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }),
                },
              ],
            },
          ]}
        >
          <Text style={styles.title}>Scans snap automatically</Text>
          <Text style={styles.body}>
            When the scanner sees a page it captures instantly. Want more control?
          </Text>

          <View style={styles.demoWrap}>
            <View
              style={styles.pill}
              accessible
              accessibilityLabel="Demo of the scanner's capture toggle switching from Auto to Manual"
            >
              <Animated.View
                style={[
                  styles.thumb,
                  // Reduce-motion: static pill, thumb parked under "Auto".
                  !reduceMotion && { transform: [{ translateX: thumbX }] },
                ]}
              />
              <View style={styles.labelRow} pointerEvents="none">
                <View style={styles.labelCell}>
                  <Text style={[styles.labelBase, reduceMotion && styles.labelStatic]}>Auto</Text>
                  {!reduceMotion && (
                    <Animated.Text style={[styles.labelEmphasis, { opacity: autoEmphasis }]}>
                      Auto
                    </Animated.Text>
                  )}
                </View>
                <View style={styles.labelCell}>
                  <Text style={[styles.labelBase, reduceMotion && styles.labelStatic]}>Manual</Text>
                  {!reduceMotion && (
                    <Animated.Text style={[styles.labelEmphasis, { opacity: demo }]}>
                      Manual
                    </Animated.Text>
                  )}
                </View>
              </View>
            </View>
          </View>

          <Text style={styles.caption}>
            Tap the <Text style={styles.captionStrong}>Shutter</Text> button (the Ⓐ icon at the
            bottom) to switch to Manual — then you press the big button yourself.
          </Text>
          <Text style={styles.secondary}>
            You can also retake any page or drag its corners before saving.
          </Text>

          <Button onPress={onContinue} style={styles.cta}>
            Got it — start scanning
          </Button>
        </Animated.View>
      </ScrollView>
    </Modal>
  );
}

/** The tip's styles in one mode. */
function makeStyles(c: Palette, scrim: string) {
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFill,
      backgroundColor: scrim,
    },
    centerWrap: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: space.xl,
    },
    card: {
      width: '100%',
      maxWidth: 340,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair,
      borderRadius: 16,
      padding: space.lg,
      ...SHADOW.card,
    },
    title: { color: c.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 17 },
    body: {
      color: c.ink3,
      fontFamily: FONT.displayRegular,
      fontSize: 13.5,
      lineHeight: 19,
      marginTop: 6,
    },
    demoWrap: { alignItems: 'center', marginVertical: space.lg },
    pill: {
      width: PILL_W,
      height: PILL_H,
      borderRadius: PILL_H / 2,
      backgroundColor: c.sunk,
      borderWidth: PILL_BORDER,
      borderColor: c.hair2,
    },
    thumb: {
      position: 'absolute',
      top: PILL_PAD,
      left: PILL_PAD,
      width: THUMB_W,
      height: THUMB_H,
      borderRadius: THUMB_H / 2,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair2,
      shadowColor: '#0e0f0d',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 3,
      elevation: 1,
    },
    labelRow: {
      position: 'absolute',
      top: PILL_PAD,
      bottom: PILL_PAD,
      left: PILL_PAD,
      right: PILL_PAD,
      flexDirection: 'row',
    },
    labelCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    labelBase: {
      color: c.ink3,
      fontFamily: FONT.display,
      fontWeight: '500',
      fontSize: 12,
      letterSpacing: 0.2,
    },
    labelStatic: { color: c.ink },
    labelEmphasis: {
      position: 'absolute',
      left: 0,
      right: 0,
      textAlign: 'center',
      lineHeight: THUMB_H, // vertical centering inside the cell
      color: c.ink,
      fontFamily: FONT.displaySemi,
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.2,
    },
    caption: {
      color: c.ink,
      fontFamily: FONT.displayRegular,
      fontSize: 13,
      lineHeight: 18,
      textAlign: 'center',
    },
    captionStrong: { fontFamily: FONT.displaySemi, fontWeight: '600' },
    secondary: {
      color: c.ink3,
      fontFamily: FONT.displayRegular,
      fontSize: 12.5,
      lineHeight: 17,
      textAlign: 'center',
      marginTop: 6,
    },
    cta: { marginTop: space.lg },
  });
}

/**
 * Both modes' styles, made once. The scrim is ink-tinted in light (as the
 * biometric opt-in sheet's) and black in dark, the app's sheet scrims.
 */
const TIP_STYLES = {
  light: makeStyles(palette('light'), 'rgba(14,15,13,0.38)'),
  dark: makeStyles(palette('dark'), 'rgba(0,0,0,0.6)'),
};
