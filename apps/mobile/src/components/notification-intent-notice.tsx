import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useAnimatedValue,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body } from '@/components/ui/text';
import { WORKSPACE_SWITCH_OFFLINE_COPY } from '@/components/workspace-switcher';
import { noticeContent, type IntentNotice, type NoticeActionId } from '@/lib/notification-open';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The sheet a tapped notification shows when it does not simply open its page
 * (Phase 3, iPhone push tap): the order or return is in another workspace
 * (switch, or not now), it is not available to this user (one sentence for
 * missing and not shared alike), the push has no page in the app (its own
 * title and body), the workspace check failed (try again) or is taking a
 * while (checking, with a spinner), or the tap was for another account on
 * this phone. The words and buttons come from notification-open.ts
 * noticeContent, where they are tested.
 *
 * Built like the inbox's detail sheet (app/(drawer)/notifications.tsx), in
 * the redesign's sheet rule (sheet-a11y-structure.test.ts): the backdrop is a
 * sibling behind a plain card, darkens per mode, and closes. VoiceOver treats
 * it as a modal, hears it announced, and dismisses it with the escape gesture
 * or a double-tap on the backdrop's "Close" (onAccessibilityTap: the card
 * covers the backdrop's centre, where VoiceOver would otherwise tap).
 * Offline the switch is disabled with the drawer switcher's own line, the
 * same rule its sheet applies. While the switch it started runs, the sheet
 * says "Switching to <Org>." with a spinner and nothing to press: a switch
 * cannot be stopped half-way.
 *
 * Presented as What's New and the tours are (review 4): with no UIKit
 * animation, its own content fading in. iOS refuses to present a sheet while
 * another is on screen or still fading out, and React Native 0.86 marks a
 * Modal presented before it asks and never asks again, so a notice that
 * faded out with UIKit left What's New, a tour or the next notice presented
 * into its fade-out and never seen. Closing is instant.
 */
export function NotificationIntentNotice({
  notice,
  busy,
  offline,
  onAction,
}: {
  notice: IntentNotice;
  /** A workspace switch is under way: the sheet says so (noticeContent). */
  busy: boolean;
  offline: boolean;
  onAction: (id: NoticeActionId) => void;
}) {
  const { c, mode } = useTheme();
  const content = noticeContent(notice, { offline, busy });
  const { announcement } = content;
  React.useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);
  const fade = useAnimatedValue(0);
  // Once, when the sheet first shows: its content fades in. The fade starts
  // at once, so the sheet can never stay invisible over the app; with Reduce
  // Motion on it is shown whole as soon as that is known.
  React.useEffect(() => {
    let cancelled = false;
    const appear = Animated.timing(fade, {
      toValue: 1,
      duration: NOTICE_FADE_MS,
      useNativeDriver: true,
    });
    appear.start();
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (reduced) => {
        if (cancelled || !reduced) return;
        appear.stop();
        fade.setValue(1);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      appear.stop();
    };
  }, [fade]);
  const dismissAction = content.actions.find((a) => a.id === content.dismiss);
  const dismiss = () => {
    if (content.dismiss) onAction(content.dismiss);
  };
  return (
    <Modal transparent animationType="none" onRequestClose={dismiss}>
      <Animated.View style={{ flex: 1, opacity: fade }}>
        <View style={{ flex: 1 }} accessibilityViewIsModal onAccessibilityEscape={dismiss}>
          <Pressable
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
            ]}
            onPress={dismiss}
            onAccessibilityTap={dismiss}
            disabled={content.dismiss === null}
            accessible={content.dismiss !== null}
            accessibilityRole="button"
            accessibilityLabel={dismissAction?.label ?? 'Close'}
          />
          <View style={{ flex: 1, justifyContent: 'center', padding: 24 }} pointerEvents="box-none">
            <Card padding={18}>
              {content.progress ? (
                <ActivityIndicator
                  color={c.ink}
                  style={{ alignSelf: 'flex-start', marginBottom: 12 }}
                />
              ) : null}
              {content.heading ? (
                <Body
                  size={16}
                  color={c.ink}
                  accessibilityRole="header"
                  style={{ fontFamily: FONT.display }}
                >
                  {content.heading}
                </Body>
              ) : null}
              <ScrollView style={{ maxHeight: 320, marginTop: content.heading ? 8 : 0 }}>
                {content.lines.map((line, i) => (
                  <Body
                    key={`${i}:${line}`}
                    size={14}
                    color={c.ink2}
                    style={i > 0 ? { marginTop: 8 } : undefined}
                  >
                    {line}
                  </Body>
                ))}
                {notice.kind === 'switch' && offline && !busy ? (
                  <Body size={12.5} muted style={{ marginTop: 8 }}>
                    {WORKSPACE_SWITCH_OFFLINE_COPY}
                  </Body>
                ) : null}
              </ScrollView>
              {content.actions.length > 0 ? (
                <View style={{ marginTop: 16, gap: 8 }}>
                  {content.actions.map((a) => (
                    <Button
                      key={a.id}
                      variant={a.primary ? 'primary' : 'ghost'}
                      block
                      disabled={a.disabled}
                      onPress={() => onAction(a.id)}
                    >
                      {a.label}
                    </Button>
                  ))}
                </View>
              ) : null}
            </Card>
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}

/** The sheet's fade-in, as What's New's and the tours' cards fade in. */
const NOTICE_FADE_MS = 180;
