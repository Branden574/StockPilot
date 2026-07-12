import { Sparkles, X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Body } from '@/components/ui/text';
import {
  getTourState,
  recordTourOutcome,
  type MobileTourDefinition,
} from '@/lib/onboarding';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Mobile tour (owner PRD §11): one idea at a time in a bottom sheet, short
 * copy, Back/Next buttons (VoiceOver-navigable), progress dots, fade-only
 * when Reduce Motion is on. The sheet renders in a transparent Modal so it
 * works no matter where the pill is mounted; tapping the dimmed area exits.
 * Offered once per version on first visit — state is the SAME
 * user_onboarding row the web uses, so finishing a tour on either platform
 * silences the offer on both. The "Tour" pill stays for replays.
 */
export function MobileTour({ tour }: { tour: MobileTourDefinition }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = React.useState<'idle' | 'offer' | 'running'>('idle');
  const [step, setStep] = React.useState(0);
  const [reduced, setReduced] = React.useState(false);
  const fade = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReduced(v);
    });
    void getTourState().then((state) => {
      if (cancelled) return;
      const done = state.completed[tour.id];
      const waved = state.dismissed[tour.id];
      const seen =
        (done && (done.v ?? 0) >= tour.version) ||
        (waved && (waved.v ?? 0) >= tour.version);
      if (!seen) setPhase((p) => (p === 'idle' ? 'offer' : p));
    });
    return () => {
      cancelled = true;
    };
  }, [tour.id, tour.version]);

  React.useEffect(() => {
    if (phase === 'idle') return;
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: reduced ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [phase, step, fade, reduced]);

  const finish = (outcome: 'completed' | 'dismissed') => {
    setPhase('idle');
    setStep(0);
    void recordTourOutcome(tour.id, tour.version, outcome);
  };

  const current = tour.steps[step];
  const isLast = step === tour.steps.length - 1;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Start the ${tour.name} tour`}
        onPress={() => {
          setStep(0);
          setPhase('running');
        }}
        style={({ pressed }) => [
          styles.pill,
          { borderColor: c.hair, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <Sparkles size={11} color={c.ink3} />
        <Body size={11} color={c.ink3}>
          Tour
        </Body>
      </Pressable>

      <Modal
        visible={phase !== 'idle'}
        transparent
        animationType="none"
        onRequestClose={() => finish('dismissed')}
      >
        {/* Tap outside the sheet = polite exit. */}
        <Pressable
          accessibilityLabel="Exit tour"
          style={styles.backdrop}
          onPress={() => finish('dismissed')}
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: c.card,
              borderColor: c.hair,
              paddingBottom: 16 + insets.bottom,
              opacity: fade,
            },
          ]}
        >
          {phase === 'offer' ? (
            <>
              <View style={styles.head}>
                <Sparkles size={14} color={c.ink} />
                <Body size={14} style={{ fontFamily: FONT.displaySemi }}>
                  New here? Take a quick tour.
                </Body>
              </View>
              <Body size={12.5} color={c.ink3} style={styles.body}>
                {tour.steps.length} short steps — learn this screen in under a minute.
              </Body>
              <View style={styles.actions}>
                <View style={styles.spacer} />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => finish('dismissed')}
                  style={styles.btnGhost}
                >
                  <Body size={12.5} color={c.ink3}>
                    No thanks
                  </Body>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setStep(0);
                    setPhase('running');
                  }}
                  style={[styles.btn, { backgroundColor: c.ink }]}
                >
                  <Body size={12.5} color={c.card} style={{ fontFamily: FONT.displaySemi }}>
                    Start tour
                  </Body>
                </Pressable>
              </View>
            </>
          ) : current ? (
            <>
              <View style={styles.head}>
                <Body size={14} style={[styles.title, { fontFamily: FONT.displaySemi }]}>
                  {current.title}
                </Body>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Exit tour"
                  onPress={() => finish('dismissed')}
                  hitSlop={10}
                >
                  <X size={15} color={c.ink4} />
                </Pressable>
              </View>
              <Body size={13} color={c.ink3} style={styles.body}>
                {current.body}
              </Body>
              <View style={styles.actions}>
                <View style={styles.dots}>
                  {tour.steps.map((_, i) => (
                    <View
                      key={i}
                      style={[
                        styles.dot,
                        {
                          backgroundColor: i === step ? c.ink : c.hair,
                          width: i === step ? 14 : 5,
                        },
                      ]}
                    />
                  ))}
                </View>
                {step > 0 && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setStep(step - 1)}
                    style={styles.btnGhost}
                  >
                    <Body size={12.5} color={c.ink3}>
                      Back
                    </Body>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => (isLast ? finish('completed') : setStep(step + 1))}
                  style={[styles.btn, { backgroundColor: c.ink }]}
                >
                  <Body size={12.5} color={c.card} style={{ fontFamily: FONT.displaySemi }}>
                    {isLast ? 'Done' : 'Next'}
                  </Body>
                </Pressable>
              </View>
            </>
          ) : null}
        </Animated.View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flex: 1, paddingRight: 8 },
  body: { marginTop: 6, lineHeight: 19 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  spacer: { flex: 1 },
  dots: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { height: 5, borderRadius: 999 },
  btn: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  btnGhost: { paddingHorizontal: 10, paddingVertical: 7 },
});
