import { X } from 'lucide-react-native';
import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { READINESS_NEEDS_CONNECTION_COPY, RETURN_RELEASE_REASON_MAX, RETURNS_COPY } from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

const TITLE_CAP = capTo(16, TYPE_CEILING.display);
const NOTE_FONT_CAP = capTo(15, TYPE_CEILING.input);

/**
 * "Release before return is received" from the replacement order's screen
 * (returns RX-2, brief 24): the two presets ("Customer is completing an
 * in-person exchange today.", "Swap at delivery: the driver collects the
 * returned item.") or a reason of up to 500 characters. Online only; a
 * request under way cannot be dismissed. The caller sends it
 * (releaseReturnReplacement) and closes the sheet on its answer.
 */
export function ReleaseReplacementSheet({
  visible,
  online,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  online: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { c, mode } = useTheme();
  const [reason, setReason] = React.useState('');
  const text = reason.trim();
  const count = Array.from(text).length;
  const disabledReason = !online
    ? READINESS_NEEDS_CONNECTION_COPY
    : count === 0
      ? RETURNS_COPY.reasonRequired
      : count > RETURN_RELEASE_REASON_MAX
        ? `At most ${RETURN_RELEASE_REASON_MAX} characters.`
        : null;
  const close = () => {
    if (submitting) return;
    setReason('');
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View accessibilityViewIsModal onAccessibilityEscape={close} style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            onPress={close}
            onAccessibilityTap={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[StyleSheet.absoluteFill, { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' }]}
          />
          <View style={[styles.sheet, { backgroundColor: c.card }]}>
            <View style={styles.header}>
              <Body size={16} color={c.ink} accessibilityRole="header" maxFontSizeMultiplier={TITLE_CAP} style={{ fontFamily: FONT.display, flex: 1 }}>
                {RETURNS_COPY.releaseEarly}
              </Body>
              <Pressable
                onPress={close}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityState={{ disabled: submitting }}
                style={{ minWidth: MIN_TAP, minHeight: MIN_TAP, alignItems: 'flex-end', justifyContent: 'center' }}
              >
                <X size={18} color={c.ink4} />
              </Pressable>
            </View>
            <Body size={13.5} muted>
              {RETURNS_COPY.releaseEarlyConfirm}
            </Body>
            {[RETURNS_COPY.releasePresetInPerson, RETURNS_COPY.releasePresetDeliverySwap].map((preset) => (
              <Pressable
                key={preset}
                disabled={submitting}
                onPress={() => setReason(preset)}
                accessibilityRole="button"
                accessibilityLabel={preset}
                accessibilityState={{ selected: reason === preset }}
                style={[styles.option, { borderColor: reason === preset ? c.ink : c.hair, minHeight: MIN_TAP }]}
              >
                <Body size={14} color={c.ink}>
                  {preset}
                </Body>
              </Pressable>
            ))}
            <FieldLabel>{RETURNS_COPY.releaseEarlyReasonLabel.toUpperCase()}</FieldLabel>
            <TextInput
              value={reason}
              onChangeText={setReason}
              editable={!submitting}
              multiline
              maxFontSizeMultiplier={NOTE_FONT_CAP}
              placeholder="Why"
              placeholderTextColor={c.ink4}
              accessibilityLabel={RETURNS_COPY.releaseEarlyReasonLabel}
              style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
            />
            <Mono size={11} color={count > RETURN_RELEASE_REASON_MAX ? ACCENT.crit : c.ink4}>
              {`${count} / ${RETURN_RELEASE_REASON_MAX}`}
            </Mono>
            {disabledReason ? (
              <Body size={13} color={c.ink3}>
                {disabledReason}
              </Body>
            ) : null}
            {error ? (
              <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
                {error}
              </Body>
            ) : null}
            <Button block disabled={disabledReason !== null || submitting} accessibilityHint={disabledReason ?? undefined} onPress={() => onConfirm(text)}>
              {submitting ? 'Saving…' : RETURNS_COPY.releaseBeforeReturn}
            </Button>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 32, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
  input: { minHeight: 80, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, textAlignVertical: 'top' },
});
