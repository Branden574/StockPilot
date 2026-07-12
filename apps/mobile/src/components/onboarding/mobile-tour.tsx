import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Sparkles, X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Body } from '@/components/ui/text';
import {
  getTourState,
  recordTourOutcome,
  type MobileTourDefinition,
} from '@/lib/onboarding';
import { measureTarget, setActiveTour, type TargetRect } from '@/lib/tour-targets';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Mobile tour v2 (owner PRD §11): one idea at a time with a real element
 * SPOTLIGHT — steps that name a registered target (lib/tour-targets) get a
 * punched-out highlight (four dim rects + ring; RN has no CSS box-shadow
 * trick) and the card flips to the TOP when the target sits in the lower
 * half so it never covers what it describes. Unregistered/unmeasurable
 * targets degrade to a plain sheet — tours must survive any org state.
 *
 * `?tour=<id>` in the route (deep link, Help center parity with web)
 * auto-starts the tour. While running, setActiveTour broadcasts so screens
 * can adapt — e.g. Inventory renders a labeled SAMPLE row when the org has
 * no items yet, so "tap an item" has something real to point at.
 *
 * State is the SAME user_onboarding row the web uses. Fade-only under
 * Reduce Motion; all controls are VoiceOver-labeled buttons.
 */
export function MobileTour({ tour }: { tour: MobileTourDefinition }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const params = useLocalSearchParams<{ tour?: string }>();
  // Tab navigators keep every screen MOUNTED — without this gate all
  // screens' offers open their Modals at once and the topmost (wrong)
  // one wins. Only the focused screen may present.
  const [isFocused, setIsFocused] = React.useState(false);
  useFocusEffect(
    React.useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );
  const [phase, setPhase] = React.useState<'idle' | 'offer' | 'running'>('idle');
  const [step, setStep] = React.useState(0);
  const [rect, setRect] = React.useState<TargetRect | null>(null);
  const [reduced, setReduced] = React.useState(false);
  const fade = React.useRef(new Animated.Value(0)).current;
  const autoStarted = React.useRef(false);

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

  // Deep-link start (?tour=<id>) — an explicit link outranks offer-once.
  React.useEffect(() => {
    if (params.tour === tour.id && !autoStarted.current) {
      autoStarted.current = true;
      Keyboard.dismiss();
      setStep(0);
      setPhase('running');
    } else if (params.tour !== tour.id) {
      autoStarted.current = false; // a fresh link may start it again
    }
  }, [params.tour, tour.id]);

  // Broadcast running state so screens can adapt (sample rows on empty orgs).
  React.useEffect(() => {
    if (phase === 'running' && isFocused) {
      setActiveTour(tour.id);
      return () => setActiveTour(null);
    }
    return undefined;
  }, [phase, tour.id, isFocused]);

  // Measure the current step's target. A beat's delay lets tour-reactive UI
  // (e.g. the sample row) mount before we measure it.
  React.useEffect(() => {
    if (phase !== 'running') {
      setRect(null);
      return;
    }
    const targetId = tour.steps[step]?.targetId;
    setRect(null); // never let the previous step's highlight linger
    if (!targetId) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void measureTarget(targetId).then((r) => {
        if (cancelled) return;
        // Off-screen (scrolled away but still mounted) measures "successfully"
        // with an out-of-window y — treat as unmeasurable or the clamp would
        // spotlight whatever sits at the screen edge.
        const visible = r && r.y + r.height > 0 && r.y < winH && r.x + r.width > 0 && r.x < winW;
        setRect(visible ? r : null);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phase, step, tour.steps, winW, winH]);

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
    setRect(null);
    void recordTourOutcome(tour.id, tour.version, outcome);
  };

  // Backdrop tap: close WITHOUT stamping — an accidental tap outside the
  // card must not mark the tour dismissed-forever. It re-offers next visit.
  const softExit = () => {
    setPhase('idle');
    setStep(0);
    setRect(null);
  };

  const current = tour.steps[step];
  const isLast = step === tour.steps.length - 1;

  // Spotlight hole (target rect + breathing room), clamped to the window.
  const PAD = 6;
  const hole = rect
    ? {
        x: Math.max(0, rect.x - PAD),
        y: Math.max(0, rect.y - PAD),
        w: Math.min(winW, rect.width + PAD * 2),
        h: rect.height + PAD * 2,
      }
    : null;
  // Card flips to the top when the target sits in the lower half —
  // never cover the thing being described.
  const cardOnTop = hole ? hole.y + hole.h / 2 > winH * 0.5 : false;

  const dim = 'rgba(0,0,0,0.45)';

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Start the ${tour.name} tour`}
        onPress={() => {
          Keyboard.dismiss();
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
        visible={isFocused && phase !== 'idle'}
        transparent
        statusBarTranslucent
        animationType="none"
        onRequestClose={() => finish('dismissed')}
      >
        <View style={styles.fill}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Exit tour"
            style={StyleSheet.absoluteFill}
            onPress={softExit}
          />
          {/* Dimmer: full wash, or four rects around the spotlight hole. */}
          {phase === 'running' && hole ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <View style={[styles.dim, { backgroundColor: dim, left: 0, top: 0, width: winW, height: hole.y }]} />
              <View style={[styles.dim, { backgroundColor: dim, left: 0, top: hole.y, width: hole.x, height: hole.h }]} />
              <View style={[styles.dim, { backgroundColor: dim, left: hole.x + hole.w, top: hole.y, width: Math.max(0, winW - hole.x - hole.w), height: hole.h }]} />
              <View style={[styles.dim, { backgroundColor: dim, left: 0, top: hole.y + hole.h, width: winW, height: Math.max(0, winH - hole.y - hole.h) }]} />
              <Animated.View
                style={[
                  styles.ring,
                  {
                    left: hole.x,
                    top: hole.y,
                    width: hole.w,
                    height: hole.h,
                    borderColor: 'rgba(255,255,255,0.95)',
                    opacity: fade,
                  },
                ]}
              />
            </View>
          ) : (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.25)' }]} />
          )}

          {/* Step / offer card. Inner Pressable swallows taps so touching the
              card text doesn't exit through the backdrop Pressable. */}
          <Animated.View
            pointerEvents="box-none"
            style={[
              styles.cardSlot,
              cardOnTop
                ? { top: insets.top + 10, left: 12, right: 12 }
                : { bottom: 0, left: 0, right: 0 },
              { opacity: fade },
            ]}
          >
            <View
              accessibilityViewIsModal
              style={[
                cardOnTop ? styles.cardFloating : styles.sheet,
                {
                  backgroundColor: c.card,
                  borderColor: c.hair,
                  paddingBottom: cardOnTop ? 16 : 16 + insets.bottom,
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
                        Keyboard.dismiss();
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
            </View>
          </Animated.View>
        </View>
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
  fill: { flex: 1 },
  dim: { position: 'absolute' },
  ring: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 14,
  },
  cardSlot: { position: 'absolute' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  cardFloating: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
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
