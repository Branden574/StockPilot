import { useRouter, type Href } from 'expo-router';
import { Gift, X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  useAnimatedValue,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Modal } from '@/components/ui/modal';
import { Body } from '@/components/ui/text';
import { BUTTON_RADIUS, buttonTone } from '@/components/ui/tones';
import { useAuth } from '@/lib/auth-context';
import {
  getUnseenAnnouncements,
  recordAnnouncementsSeen,
  type AnnouncementItem,
} from '@/lib/announcements';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
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
 *
 * Drawn on the per-mode palette: the card over the app's sheet scrim, Next /
 * Done as the shared ink button and the CTA as the outline one, each a 44pt
 * target at radius 10 (they were 33pt pills), the X in the muted ink and the
 * carousel's resting dots in ink4 (the hairline dots were 1.3:1 on the card).
 */

// Show at most once per launch PER USER. Keyed to the user id (not a bare
// boolean) so a biometric unlock / RootGate re-render for the SAME user doesn't
// re-fetch or re-show, but a different user signing in on the same device (a
// shared warehouse tablet) still gets their own announcements. Committed only
// once we actually have items to show — so a network blip (which fail-quiets to
// []) or an empty result doesn't burn the guard and can retry on the next mount.
let shownForUserId: string | null = null;

export function WhatsNew() {
  const { c, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH, fontScale } = useWindowDimensions();
  // The CTA pill and Done/Next are chrome and capped, but even capped they
  // outgrow one line together — and the dots have to keep a line they own
  // rather than sharing one the buttons have already claimed.
  const actionsStacked = shouldStackRow(fontScale);
  const router = useRouter();
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const [items, setItems] = React.useState<AnnouncementItem[]>([]);
  const [index, setIndex] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const [reduced, setReduced] = React.useState(false);
  const fade = useAnimatedValue(0);

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

  const primary = buttonTone('primary', c);
  const outline = buttonTone('outline', c);

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
        {/* The app's sheet scrim, darker in dark mode as every sheet's is. */}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
        />
        <Animated.View
          pointerEvents="box-none"
          style={[styles.cardSlot, { opacity: fade }]}
        >
          {/* The escape scrub dismisses, as the X and Android's back do. */}
          <View
            accessibilityViewIsModal
            onAccessibilityEscape={() => close('dismissed')}
            style={[
              styles.sheet,
              {
                backgroundColor: c.card,
                borderColor: c.hair,
                paddingBottom: 16 + insets.bottom,
                // Announcement copy is uncapped Body, so a long item is taller
                // than the window at accessibility sizes. The sheet grows from
                // bottom: 0 UPWARD, which would push the head — and its X —
                // off the top of the screen. Bound it and scroll the copy.
                maxHeight: Math.max(200, winH - insets.top - insets.bottom - 24),
              },
            ]}
          >
            <View style={styles.head}>
              <View style={styles.eyebrow}>
                <Gift size={14} color={c.ink} />
                {/* The eyebrow BOX already yields (`flex: 1, minWidth: 0`), but
                    an RN Text defaults to `flexShrink: 0`, so the label kept
                    its full intrinsic width and ran out under the X. Shrinking
                    the Text is what makes the box's yield reach the glyphs. */}
                <Body size={12} color={c.ink3} style={styles.eyebrowLabel}>
                  What&apos;s new · {item.date}
                </Body>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss what's new"
                onPress={() => close('dismissed')}
                style={styles.closeFrame}
              >
                <X size={15} color={c.ink3} />
              </Pressable>
            </View>

            <ScrollView style={styles.scroll} bounces={false} showsVerticalScrollIndicator={false}>
              <Body size={15} color={c.ink} style={[styles.title, { fontFamily: FONT.displaySemi }]}>
                {item.title}
              </Body>
              <Body size={13} color={c.ink3} style={styles.body}>
                {item.body}
              </Body>
            </ScrollView>

            <View style={[styles.actions, actionsStacked && styles.actionsStackedStyle]}>
              {items.length > 1 ? (
                <View style={styles.dots}>
                  {items.map((_, i) => (
                    <View
                      key={i}
                      style={[
                        styles.dot,
                        {
                          backgroundColor: i === index ? c.ink : c.ink4,
                          width: i === index ? 14 : 5,
                        },
                      ]}
                    />
                  ))}
                </View>
              ) : actionsStacked ? null : (
                <View style={styles.spacer} />
              )}
              {showCta && cta ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => handleCta(cta.href)}
                  style={[
                    styles.action,
                    { backgroundColor: outline.bg, borderColor: outline.border },
                  ]}
                >
                  <Body
                    size={ACTION_SIZE}
                    color={outline.fg}
                    style={styles.actionLabel}
                    maxFontSizeMultiplier={ACTION_CAP}
                  >
                    {cta.label}
                  </Body>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => (isLast ? close('seen') : setIndex(index + 1))}
                style={[
                  styles.action,
                  { backgroundColor: primary.bg, borderColor: primary.border },
                ]}
              >
                <Body
                  size={ACTION_SIZE}
                  color={primary.fg}
                  style={styles.actionLabel}
                  maxFontSizeMultiplier={ACTION_CAP}
                >
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

/** Done / Next / the CTA are chrome, and the only deliberate way out: the
 *  shared small button's 13pt label, capped at the control ceiling. */
const ACTION_SIZE = 13;
const ACTION_CAP = capTo(ACTION_SIZE, TYPE_CEILING.control);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cardSlot: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  // Head and actions are PINNED either side of the scroll region, so the X and
  // Done/Next stay reachable however long the announcement is.
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  // The X's 44pt frame (a real target and VoiceOver outline, not hitSlop
  // around a 15pt glyph). The negative margin, (44 - 15) / 2, hands the
  // frame's extra size back, so the head lays out around a 15pt X as before.
  closeFrame: {
    minWidth: 44,
    minHeight: 44,
    margin: -14.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  eyebrowLabel: { flexShrink: 1, minWidth: 0 },
  scroll: { flexShrink: 1 },
  title: { marginTop: 10 },
  // lineHeight stays PINNED at 19, deliberately — see the twin in
  // mobile-tour.tsx. React Native scales a fixed lineHeight by the same
  // effective font multiplier it applies to fontSize, so this never overlapped
  // at accessibility sizes; removing it only changed the leading at DEFAULT
  // size (Body derives 19.5 for this 13pt copy).
  body: { marginTop: 6, lineHeight: 19 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
    flexShrink: 0,
  },
  // Stacked, the dots take the first line and each button the next, so nothing
  // is painted over anything else. `stretch` would make the pills full-width
  // blocks with left-hugging labels, so hold them at their natural width.
  //
  // `flexWrap: 'nowrap'` is load-bearing: `actions` sets `wrap` for the ROW
  // case, and once the direction is column that same `wrap` flows the children
  // down and then into a SECOND COLUMN against the sheet's bounded height —
  // which put Next back alongside the dots, the exact overlap this fixes.
  actionsStackedStyle: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    flexWrap: 'nowrap',
    gap: 10,
  },
  spacer: { flex: 1 },
  // `flexGrow`/`flexBasis: 'auto'`, NOT `flex: 1`. RN's `flex: 1` shorthand
  // sets `flexBasis: 0`, so this box measured as zero-width during line
  // breaking while its fixed-width dot children rendered anyway — which is why
  // the dots painted UNDER the CTA pill instead of pushing it right. An `auto`
  // basis measures the dots, so they claim their own width and still grow to
  // push the buttons to the far edge.
  dots: {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: { height: 5, borderRadius: 999 },
  // The shared button's look (tones.ts buttonTone, radius 10) at the iOS
  // minimum target: minHeight, not a fixed height, so a capped label that
  // still grows past one line is never clipped.
  action: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: BUTTON_RADIUS.sm,
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontFamily: FONT.display },
});
