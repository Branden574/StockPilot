import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  READINESS_NEEDS_CONNECTION_COPY,
  RETURN_RELEASE_REASON_MAX,
  RETURNS_COPY,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import { capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

const TITLE_CAP = capTo(16, TYPE_CEILING.display);
const NOTE_FONT_CAP = capTo(15, TYPE_CEILING.input);

interface ReleaseSheetProps {
  online: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * "Release before return is received" from the replacement order's screen
 * (returns RX-2, brief 24): the two presets ("Customer is completing an
 * in-person exchange today.", "Swap at delivery: the driver collects the
 * returned item.") or a reason of up to 500 characters. Online only; a
 * request under way cannot be dismissed. The caller sends it
 * (releaseReturnReplacement) and closes the sheet on its answer.
 *
 * Structure: the exception sheets' (sibling backdrop behind a plain card,
 * accessibilityViewIsModal, onAccessibilityTap on the scrim, the title and the
 * button pinned, the body the one part that scrolls, sized by
 * exceptionSheetLayout, the keyboard handled by useSheetKeyboard). RX-2
 * simulator finding SIM-2: as a plain card with no height bound it ran off
 * the top of an iPhone at AX5, taking the title, Close and the first preset.
 * The content remounts per opening, so the reason starts empty each time.
 *
 * The look (redesign P5.7b): the per-mode palette; each preset a control
 * with the stronger border, the chosen one the ink edge on the recessed
 * fill; the reason box on the shared Field's recipe, its typed words in the
 * body face; refusals and the over-limit count in the mode's refusal ink.
 */
export function ReleaseReplacementSheet({
  visible,
  ...props
}: ReleaseSheetProps & { visible: boolean }) {
  const close = () => {
    if (props.submitting) return;
    props.onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <ReleaseSheetContent key={String(visible)} {...props} />
    </Modal>
  );
}

function ReleaseSheetContent({ online, submitting, error, onClose, onConfirm }: ReleaseSheetProps) {
  const { c, mode } = useTheme();
  const [reason, setReason] = React.useState('');
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({
    windowHeight: height,
    availableHeight,
    topInset: insets.top,
  });
  const [attachBody, kb] = useSheetKeyboard();
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
    onClose();
  };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={close}
        onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={close}
          onAccessibilityTap={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View
          onStartShouldSetResponder={kb.claimTapOutside}
          onResponderRelease={kb.onTapOutside}
          style={[styles.sheet, { backgroundColor: c.card, maxHeight: layout.sheetMaxHeight }]}
        >
          <View style={styles.header}>
            <Body
              size={16}
              color={c.ink}
              accessibilityRole="header"
              maxFontSizeMultiplier={TITLE_CAP}
              style={{ fontFamily: FONT.display, flex: 1 }}
            >
              {RETURNS_COPY.releaseEarly}
            </Body>
            <Pressable
              onPress={close}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: submitting }}
              style={{
                minWidth: MIN_TAP,
                minHeight: MIN_TAP,
                alignItems: 'flex-end',
                justifyContent: 'center',
              }}
            >
              <X size={18} color={c.ink3} />
            </Pressable>
          </View>

          <ScrollView
            ref={attachBody}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            scrollEventThrottle={16}
            onScroll={kb.onBodyScroll}
            onLayout={kb.onBodyLayout}
            onContentSizeChange={kb.onBodyContentSizeChange}
            contentContainerStyle={{ gap: 10 }}
            style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
          >
            <Body size={13.5} muted>
              {RETURNS_COPY.releaseEarlyConfirm}
            </Body>
            {[RETURNS_COPY.releasePresetInPerson, RETURNS_COPY.releasePresetDeliverySwap].map(
              (preset) => (
                <Pressable
                  key={preset}
                  disabled={submitting}
                  onPress={() => setReason(preset)}
                  accessibilityRole="button"
                  accessibilityLabel={preset}
                  accessibilityState={{ selected: reason === preset }}
                  style={[
                    styles.option,
                    {
                      borderColor: reason === preset ? c.ink : c.hair2,
                      backgroundColor: reason === preset ? c.sunk : 'transparent',
                      minHeight: MIN_TAP,
                    },
                  ]}
                >
                  <Body size={14} color={c.ink}>
                    {preset}
                  </Body>
                </Pressable>
              ),
            )}
            <View style={{ gap: 6 }} onLayout={kb.onNoteBlockLayout}>
              <FieldLabel>{RETURNS_COPY.releaseEarlyReasonLabel.toUpperCase()}</FieldLabel>
              <TextInput
                value={reason}
                onChangeText={setReason}
                onFocus={kb.onNoteFocus}
                onBlur={kb.onNoteBlur}
                onLayout={kb.onNoteLayout}
                editable={!submitting}
                multiline
                maxFontSizeMultiplier={NOTE_FONT_CAP}
                placeholder="Why"
                placeholderTextColor={c.ink3}
                accessibilityLabel={RETURNS_COPY.releaseEarlyReasonLabel}
                style={[
                  styles.input,
                  { borderColor: c.hair2, backgroundColor: c.card, color: c.ink },
                ]}
              />
              <Mono size={11} color={count > RETURN_RELEASE_REASON_MAX ? c.critText : c.ink3}>
                {`${count} / ${RETURN_RELEASE_REASON_MAX}`}
              </Mono>
            </View>
          </ScrollView>

          {disabledReason ? (
            <Body size={13} color={c.ink3}>
              {disabledReason}
            </Body>
          ) : null}
          {error ? (
            <Body size={13} color={c.critText} accessibilityRole="alert">
              {error}
            </Body>
          ) : null}
          <Button
            block
            wrap
            disabled={disabledReason !== null || submitting}
            accessibilityHint={disabledReason ?? undefined}
            onPress={() => onConfirm(text)}
          >
            {submitting ? 'Saving…' : RETURNS_COPY.releaseBeforeReturn}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 32,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  option: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  // A typed reason: the shared text box's recipe, in the body face.
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontFamily: FONT.displayRegular,
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
