import * as React from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
 * title and body), the workspace check failed (try again), or the tap was for
 * another account on this phone. The words and buttons come from
 * notification-open.ts noticeContent, where they are tested.
 *
 * Built like the inbox's detail sheet (app/(drawer)/notifications.tsx): the
 * backdrop is a sibling behind a plain card, and closes. VoiceOver treats it
 * as a modal, can dismiss it with the escape gesture, and hears it announced.
 * Offline the switch is disabled with the drawer switcher's own line, the
 * same rule its sheet applies.
 */
export function NotificationIntentNotice({
  notice,
  busy,
  offline,
  onAction,
}: {
  notice: IntentNotice;
  /** A workspace switch is under way: the buttons wait for it. */
  busy: boolean;
  offline: boolean;
  onAction: (id: NoticeActionId) => void;
}) {
  const { c } = useTheme();
  const content = noticeContent(notice, { offline });
  const { announcement } = content;
  React.useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);
  const dismissAction = content.actions.find((a) => a.id === content.dismiss);
  const dismiss = () => {
    if (!busy) onAction(content.dismiss);
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={dismiss}>
      <View style={{ flex: 1 }} accessibilityViewIsModal onAccessibilityEscape={dismiss}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]}
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel={dismissAction?.label ?? 'Close'}
        />
        <View style={{ flex: 1, justifyContent: 'center', padding: 24 }} pointerEvents="box-none">
          <Card padding={18}>
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
              {notice.kind === 'switch' && offline ? (
                <Body size={12.5} muted style={{ marginTop: 8 }}>
                  {WORKSPACE_SWITCH_OFFLINE_COPY}
                </Body>
              ) : null}
            </ScrollView>
            <View style={{ marginTop: 16, gap: 8 }}>
              {content.actions.map((a) => (
                <Button
                  key={a.id}
                  variant={a.primary ? 'primary' : 'ghost'}
                  block
                  disabled={busy || a.disabled}
                  onPress={() => onAction(a.id)}
                >
                  {a.label}
                </Button>
              ))}
            </View>
          </Card>
        </View>
      </View>
    </Modal>
  );
}
