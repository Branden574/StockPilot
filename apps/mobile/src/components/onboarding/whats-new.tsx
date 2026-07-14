import { useRouter, type Href } from 'expo-router';
import { Gift, X } from 'lucide-react-native';
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
import { useAuth } from '@/lib/auth-context';
import {
  getUnseenAnnouncements,
  recordAnnouncementsSeen,
  type AnnouncementItem,
} from '@/lib/announcements';
import { FONT } from '@/lib/theme';
import {
  isAnyTourVisible,
  setWhatsNewOpen,
  subscribeTourVisibility,
} from '@/lib/tour-targets';
import { useTheme } from '@/lib/use-theme';
import { rewriteWebPath } from '@/lib/web-path-rewrite';

/**
 * Mobile What's New (owner PRD §5) — web parity for the announcement inbox.
 * Mounted ONCE globally in RootGate (a sibling of the root Stack), so unlike
 * the per-screen MobileTour there is no multi-mount race and no focus gate.
 *
 * The registry, role-filtering, and seen/stamp semantics all live server-side
 * (GET/POST /api/v1/me/announcements, sharing pure logic with the web action) —
 * this component is presentation only. It shows the unseen items as a bottom
 * sheet with a dot carousel; EVERY close path (X, backdrop, Done, CTA) stamps
 * the WHOLE registry seen (all:true), exactly like web. One interruption at a
 * time: it defers while any tour Modal (offer or running) is on screen.
 */

// Show at most once per launch PER USER. Keyed to the user id (not a bare
// boolean) so a biometric unlock / RootGate re-render for the SAME user doesn't
// re-fetch or re-show, but a different user signing in on the same device (a
// shared warehouse tablet) still gets their own announcements. Committed only
// once we actually have items to show — so a network blip (which fail-quiets to
// []) or an empty result doesn't burn the guard and can retry on the next mount.
let shownForUserId: string | null = null;

export function WhatsNew() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const [items, setItems] = React.useState<AnnouncementItem[]>([]);
  const [index, setIndex] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const [reduced, setReduced] = React.useState(false);
  const fade = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!uid || shownForUserId === uid) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReduced(v);
    });

    void getUnseenAnnouncements().then((unseen) => {
      if (cancelled || unseen.length === 0) return;
      shownForUserId = uid; // commit the guard only now that there is something to show
      setItems(unseen);
      const tryOpen = () => {
        if (cancelled || isAnyTourVisible()) return; // a tour owns the screen
        unsub?.();
        unsub = undefined;
        setOpen(true);
      };
      // A beat, so we never race the shell's own first paint (web waits too).
      timer = setTimeout(() => {
        if (cancelled) return;
        // One interruption at a time: if a tour offer/run is up, wait until it
        // clears; otherwise speak up now.
        if (isAnyTourVisible()) unsub = subscribeTourVisibility(tryOpen);
        else setOpen(true);
      }, 1200);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsub?.();
    };
  }, [uid]);

  // Broadcast open state so a tour Modal yields the interruption slot while
  // What's New is up (mutual lock — the tour gates its Modal on !whatsNewOpen).
  React.useEffect(() => {
    setWhatsNewOpen(open);
    return () => setWhatsNewOpen(false);
  }, [open]);

  const close = React.useCallback(
    (outcome: 'seen' | 'dismissed') => {
      setOpen(false);
      // Close = "I'm caught up": stamp the WHOLE registry (all:true), like web.
      void recordAnnouncementsSeen(
        items.map((i) => i.id),
        outcome,
        true,
      );
    },
    [items],
  );

  React.useEffect(() => {
    if (!open) return;
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: reduced ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [open, index, fade, reduced]);

  if (!open || items.length === 0) return null;
  const item = items[index]!;
  const cta = item.cta;
  const isLast = index === items.length - 1;
  // Only offer the CTA when it resolves to a real native screen — a web-only
  // target (e.g. Help) rewrites to '/' and would be a dead button on mobile.
  const showCta = !!cta && rewriteWebPath(cta.href) !== '/';

  const handleCta = (href: string) => {
    const native = rewriteWebPath(href);
    close('seen'); // web parity: following a CTA counts as seen
    if (native !== '/') router.push(native as Href);
  };

  return (
    <Modal
      visible={open}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={() => close('dismissed')}
    >
      <View style={styles.fill}>
        {/* Backdrop is a flat SIBLING of the card (never a wrapper) so VoiceOver
            doesn't read the whole sheet as one button. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss what's new"
          style={StyleSheet.absoluteFill}
          onPress={() => close('dismissed')}
        />
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]}
        />
        <Animated.View
          pointerEvents="box-none"
          style={[styles.cardSlot, { opacity: fade }]}
        >
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: c.card,
                borderColor: c.hair,
                paddingBottom: 16 + insets.bottom,
              },
            ]}
          >
            <View style={styles.head}>
              <View style={styles.eyebrow}>
                <Gift size={14} color={c.ink} />
                <Body size={12} color={c.ink3}>
                  What&apos;s new · {item.date}
                </Body>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss what's new"
                onPress={() => close('dismissed')}
                hitSlop={10}
              >
                <X size={15} color={c.ink4} />
              </Pressable>
            </View>

            <Body size={15} color={c.ink} style={[styles.title, { fontFamily: FONT.displaySemi }]}>
              {item.title}
            </Body>
            <Body size={13} color={c.ink3} style={styles.body}>
              {item.body}
            </Body>

            <View style={styles.actions}>
              {items.length > 1 ? (
                <View style={styles.dots}>
                  {items.map((_, i) => (
                    <View
                      key={i}
                      style={[
                        styles.dot,
                        { backgroundColor: i === index ? c.ink : c.hair, width: i === index ? 14 : 5 },
                      ]}
                    />
                  ))}
                </View>
              ) : (
                <View style={styles.spacer} />
              )}
              {showCta && cta ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => handleCta(cta.href)}
                  style={[styles.cta, { borderColor: c.hair }]}
                >
                  <Body size={12.5} color={c.ink3}>
                    {cta.label}
                  </Body>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => (isLast ? close('seen') : setIndex(index + 1))}
                style={[styles.btn, { backgroundColor: c.ink }]}
              >
                <Body size={12.5} color={c.card} style={{ fontFamily: FONT.displaySemi }}>
                  {isLast ? 'Done' : 'Next'}
                </Body>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cardSlot: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eyebrow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { marginTop: 10 },
  body: { marginTop: 6, lineHeight: 19 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  spacer: { flex: 1 },
  dots: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { height: 5, borderRadius: 999 },
  cta: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  btn: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
});
