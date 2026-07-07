import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SHADOW, radius, space, theme } from '@/lib/theme';

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
 * toggle in its top corner is easy to miss. Centerpiece is a looping demo
 * of that toggle — a thumb sliding from "Auto" to "Manual" with a label
 * emphasis crossfade (~2.2s cycle with holds at each end).
 *
 * All animation is the built-in Animated API with useNativeDriver (opacity
 * + transform only) — OTA-safe for existing runtime-1.1.0 binaries, no new
 * native modules. Reduce-motion (AccessibilityInfo) skips the loop and the
 * entrance spring: static pill showing both labels, plain fades only.
 *
 * Styling follows po-attachments.tsx (static light `theme` tokens), since
 * this modal only ever appears from that card.
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
  const [reduceMotion, setReduceMotion] = React.useState(false);
  /** Backdrop fade: 0 → 1 (timing). */
  const backdrop = React.useRef(new Animated.Value(0)).current;
  /** Card entrance: 0 → 1 drives opacity + translateY (spring). */
  const card = React.useRef(new Animated.Value(0)).current;
  /** Toggle demo: 0 = Auto, 1 = Manual (looped timing). */
  const demo = React.useRef(new Animated.Value(0)).current;

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
      <View style={styles.centerWrap}>
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
            Tap <Text style={styles.captionStrong}>Auto</Text> in the scanner’s top corner to
            switch — then you press the shutter yourself.
          </Text>
          <Text style={styles.secondary}>
            You can also retake any page or drag its corners before saving.
          </Text>

          <Pressable
            accessibilityRole="button"
            onPress={onContinue}
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.ctaText}>Got it — start scanning</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(14,15,13,0.38)', // ink-tinted scrim, as biometric-optin-sheet
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.lg,
    padding: space.lg,
    ...SHADOW.card,
  },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  body: { color: theme.textMuted, fontSize: 13.5, lineHeight: 19, marginTop: 6 },
  demoWrap: { alignItems: 'center', marginVertical: space.lg },
  pill: {
    width: PILL_W,
    height: PILL_H,
    borderRadius: PILL_H / 2,
    backgroundColor: theme.bgElevated,
    borderWidth: PILL_BORDER,
    borderColor: theme.border,
  },
  thumb: {
    position: 'absolute',
    top: PILL_PAD,
    left: PILL_PAD,
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: THUMB_H / 2,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
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
  labelBase: { color: theme.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },
  labelStatic: { color: theme.text },
  labelEmphasis: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    lineHeight: THUMB_H, // vertical centering inside the cell
    color: theme.text,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  caption: { color: theme.text, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  captionStrong: { fontWeight: '700' },
  secondary: {
    color: theme.textMuted,
    fontSize: 12.5,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 6,
  },
  cta: {
    backgroundColor: theme.text,
    borderRadius: radius.sm,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: space.lg,
  },
  ctaText: { color: theme.bg, fontWeight: '700', fontSize: 14 },
});
