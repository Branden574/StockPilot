import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { READINESS_NEEDS_CONNECTION_COPY } from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Body, Mono } from '@/components/ui/text';
import { describePartialCommitError, type PartialSheetView } from '@/lib/order-partial';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * APPROVE PARTIAL / RESUME FULFILLMENT, WITH A PREVIEW (F2-3): the phone twin
 * of the web order page's approve-partial dialog, opened from the order
 * screen's existing Approve partial and Resume fulfillment buttons.
 *
 * It shows what would be held now, per item (duplicate lines combined, never
 * split per line), what ships when it arrives, and when stock was checked.
 * Confirm runs the screen's `onConfirm`: the existing transition, unchanged,
 * then readiness read again (lib/order-partial.ts runPartialFulfilment); the
 * screen closes the sheet and says what was actually held. A refusal stays
 * here, said in place (role alert, and announced: iOS gives the 'alert' role
 * no trait), never only in a toast (pattern #20). While the confirm runs the
 * sheet cannot be dismissed, so its answer is never lost.
 *
 * An unavailable preview says why and offers only Close: nothing is
 * committed blind. Every word comes from `view` (core's, through
 * lib/order-partial.ts partialSheetView).
 *
 * Built in the sibling-backdrop shape (sheet-backdrop-guard.test.ts): a scrim
 * Pressable BEHIND the card, the card a plain View, so VoiceOver reaches each
 * item, the summary and both buttons on their own. Buttons are at least 44pt;
 * their labels stop growing at the control ceiling; the sentences are content
 * and grow with Dynamic Type (the item list scrolls).
 */
export function ApprovePartialSheet({
  visible,
  view,
  offline,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  /** The sheet's words (lib/order-partial.ts partialSheetView). */
  view: PartialSheetView;
  /** No connection: Confirm is disabled, with the reason. */
  offline: boolean;
  onClose: () => void;
  /** Commits and says the result; rejects with the refusal, shown here. */
  onConfirm: () => Promise<void>;
}) {
  const { c, mode } = useTheme();
  const { height } = useWindowDimensions();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Fixed pixel height off the window: percentage sizing collapsed layouts
  // under Fabric (edit-order-line-sheet.tsx), so no sheet uses it.
  const bodyMaxHeight = Math.round(height * 0.45);
  const canConfirm = view.confirmLabel !== null && !offline && !busy;

  function requestClose() {
    if (busy) return;
    onClose();
  }

  async function confirm() {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      const message = describePartialCommitError(e);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      {/*
       * Backdrop is a SIBLING behind the sheet, not its parent: a Pressable
       * ancestor folds the whole card into one VoiceOver element and claims
       * the touch before the item list can scroll. Taps outside still close,
       * because the scrim fills the screen behind the card.
       */}
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={requestClose}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={requestClose}
          onAccessibilityTap={requestClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            padding: 18,
            paddingBottom: 30,
            gap: 12,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Body
              size={16}
              color={c.ink}
              accessibilityRole="header"
              style={{ flex: 1, fontFamily: FONT.display }}
            >
              {view.title}
            </Body>
            <Pressable
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: busy }}
              style={{
                minWidth: MIN_TAP,
                minHeight: MIN_TAP,
                alignItems: 'flex-end',
                justifyContent: 'center',
              }}
            >
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: bodyMaxHeight }} contentContainerStyle={{ gap: 10 }}>
            {view.summary ? (
              <Body size={14.5} color={c.ink}>
                {view.summary}
              </Body>
            ) : null}
            {view.items.map((item) => (
              // One VoiceOver element per item: "Maus I (2 lines), holds 6 of
              // 10, 4 to ship when they arrive" (core's words).
              <View
                key={item.itemId}
                accessible
                accessibilityLabel={item.accessibilityLabel}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 12,
                  paddingVertical: 8,
                  borderTopWidth: 1,
                  borderTopColor: c.hair,
                }}
              >
                <Body size={14} color={c.ink} style={{ flex: 1 }}>
                  {item.label}
                </Body>
                <Mono size={12} color={c.ink2} style={{ flexShrink: 1, textAlign: 'right' }}>
                  {item.detail}
                </Mono>
              </View>
            ))}
            {view.note ? (
              <Body size={12.5} color={c.ink3}>
                {view.note}
              </Body>
            ) : null}
            {/* When the stock was checked (the web dialog's order: summary,
                items, note, then this). */}
            {view.checkedAt ? (
              <Body size={12} muted>
                {view.checkedAt}
              </Body>
            ) : null}
            {view.unavailable ? (
              <Body size={13.5} color={ACCENT.warn}>
                {view.unavailable}
              </Body>
            ) : null}
          </ScrollView>

          {error ? (
            <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
              {error}
            </Body>
          ) : null}
          {offline && view.confirmLabel !== null ? (
            <Body size={12.5} muted>
              {READINESS_NEEDS_CONNECTION_COPY}
            </Body>
          ) : null}

          {view.confirmLabel !== null ? (
            <Pressable
              onPress={() => void confirm()}
              disabled={!canConfirm}
              accessibilityRole="button"
              accessibilityLabel={view.confirmLabel}
              accessibilityState={{ disabled: !canConfirm, busy }}
              accessibilityHint={offline ? READINESS_NEEDS_CONNECTION_COPY : undefined}
              style={[
                styles.action,
                { backgroundColor: c.ink, opacity: canConfirm || busy ? 1 : 0.5 },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={c.paper} />
              ) : (
                <Mono size={13} color={c.paper} maxFontSizeMultiplier={ACTION_CAP}>
                  {view.confirmLabel}
                </Mono>
              )}
            </Pressable>
          ) : null}
          <Pressable
            onPress={requestClose}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={view.cancelLabel}
            accessibilityState={{ disabled: busy }}
            style={[styles.action, { borderWidth: 1, borderColor: c.hair, opacity: busy ? 0.5 : 1 }]}
          >
            <Mono size={13} color={c.ink} maxFontSizeMultiplier={ACTION_CAP}>
              {view.cancelLabel}
            </Mono>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** Button labels are chrome: they stop growing at the control ceiling (the
 *  Button primitive's), and the button grows with them (minHeight). */
const ACTION_CAP = capTo(13, TYPE_CEILING.control);

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: MIN_TAP,
    borderRadius: 10,
  },
});
