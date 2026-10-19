import * as React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BUTTON_RADIUS, buttonTone } from '@/components/ui/tones';
import { api } from '@/lib/api';
import { FONT, RADIUS, SHADOW, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

// Owner-approved release-reason categories. "Other" requires free text.
const REASON_CATEGORIES = [
  'Shift ending',
  'Unable to locate inventory',
  'Equipment unavailable',
  'Scanner or device problem',
  'Safety issue',
  'Wrong assignment',
  'Workload conflict',
  'Need manager assistance',
  'Other',
] as const;

type Category = (typeof REASON_CATEGORIES)[number];

/** The iOS minimum tap target, in points. */
const MIN_TAP = 44;

/**
 * Hand an assigned count back, with a reason (redesign package P5.9a moved it
 * off the light-only legacy `theme` alias onto the device's palette).
 *
 * The look: the app's bottom sheet on the card colour, the reasons as 44pt
 * choices (the stronger border on the card, the chosen one filled with ink),
 * the note box recessed, Cancel the outline button and Release count the ink
 * button that commits the hand-back (tones.ts `buttonTone`), both wrapping
 * their words rather than cutting them. Every word, reason, rule ("Other"
 * needs a note) and request is unchanged.
 *
 * VoiceOver, as the app's other sheets: the backdrop is a sibling behind the
 * card, a button named Close that closes on a double tap; the sheet is modal
 * and the escape scrub closes it; each reason says whether it is chosen.
 */
export function CycleCountReleaseSheet({
  visible,
  cycleCountId,
  onClose,
  onReleased,
}: {
  visible: boolean;
  cycleCountId: string;
  onClose: () => void;
  onReleased: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* key: remount the content per open/close transition so every session
          starts from a blank category/notes/error — reset-by-remount instead of
          a reset-on-open effect. */}
      <ReleaseSheetContent
        key={String(visible)}
        cycleCountId={cycleCountId}
        onClose={onClose}
        onReleased={onReleased}
      />
    </Modal>
  );
}

function ReleaseSheetContent({
  cycleCountId,
  onClose,
  onReleased,
}: {
  cycleCountId: string;
  onClose: () => void;
  onReleased: () => void;
}) {
  const { c, mode } = useTheme();
  const [category, setCategory] = React.useState<Category | null>(null);
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const needsNotes = category === 'Other';
  const canSubmit = !!category && (!needsNotes || notes.trim().length > 0) && !submitting;
  const notePrompt = needsNotes ? 'Add a note (required)' : 'Add a note (optional)';
  const cancelTone = buttonTone('outline', c);
  const releaseTone = buttonTone('primary', c);

  async function submit() {
    if (!category) return;
    // Compose a non-blank reason for the server (release route requires min 1).
    const reason =
      category === 'Other'
        ? notes.trim()
        : notes.trim()
          ? `${category} — ${notes.trim()}`
          : category;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/v1/cycle-counts/${cycleCountId}/release`, {
        method: 'POST',
        body: { reason },
      });
      onReleased();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^API \d+:\s*/, '')
          : 'Could not release the count. Try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      {/*
       * Backdrop is a SIBLING behind the sheet, not its parent. A Pressable
       * ancestor claims the touch on press-down and beats the ScrollView's pan
       * recogniser, so the list below would not scroll until something else
       * took the responder first (focusing a text field). Do not re-nest this
       * card inside the scrim — taps outside still close because the scrim
       * fills the screen behind it. See add-order-items-sheet.tsx for the
       * measured detail.
       */}
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View style={[styles.sheet, { backgroundColor: c.card }, SHADOW.sheet]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: c.hair2 }]} />
          </View>

          <Text accessibilityRole="header" style={[styles.title, { color: c.ink }]}>
            Release this cycle count?
          </Text>
          <Text style={[styles.body, { color: c.ink3 }]}>
            You will no longer be able to edit or submit this count unless a manager assigns it back
            to you. Your counts so far are kept. Your reason is recorded.
          </Text>

          <Text style={[styles.label, { color: c.ink }]}>Reason</Text>
          <ScrollView
            style={{ maxHeight: 220 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.reasons}>
              {REASON_CATEGORIES.map((cat) => {
                const selected = category === cat;
                return (
                  <Pressable
                    key={cat}
                    onPress={() => setCategory(cat)}
                    // One of nine choices: VoiceOver says which one is chosen.
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [
                      styles.reason,
                      {
                        borderColor: selected ? c.ink : c.hair2,
                        backgroundColor: selected ? c.ink : c.card,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.reasonLabel,
                        {
                          color: selected ? c.paper : c.ink,
                          fontFamily: selected ? FONT.displaySemi : FONT.display,
                        },
                      ]}
                    >
                      {cat}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder={notePrompt}
              placeholderTextColor={c.ink3}
              // Named once it holds words (an empty box reads its placeholder,
              // and a name as well would say it twice).
              accessibilityLabel={notes.length > 0 ? notePrompt : undefined}
              multiline
              style={[
                styles.notes,
                { borderColor: c.hair2, backgroundColor: c.sunk, color: c.ink },
              ]}
            />
          </ScrollView>

          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: c.critText }]}>
              {error}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityState={{ disabled: submitting }}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: cancelTone.bg,
                  borderColor: cancelTone.border,
                  opacity: submitting ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.actionLabel, { color: cancelTone.fg }]}>Cancel</Text>
            </Pressable>
            {/* Release commits the hand-back: the ink button. Its words stay
                beside the spinner while the request is under way. */}
            <Pressable
              onPress={submit}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy: submitting }}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: releaseTone.bg,
                  borderColor: releaseTone.border,
                  opacity: !canSubmit ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {submitting ? <ActivityIndicator color={releaseTone.fg} /> : null}
              <Text style={[styles.actionLabel, { color: releaseTone.fg }]}>Release count</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingBottom: 36,
    paddingHorizontal: 22,
    maxHeight: '88%',
  },
  grabberRow: { alignItems: 'center', marginBottom: 16 },
  grabber: { width: 36, height: 5, borderRadius: 100 },
  title: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 20 },
  body: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 6, lineHeight: 18 },
  label: {
    fontFamily: FONT.displaySemi,
    fontWeight: '600',
    fontSize: 13,
    marginTop: 18,
    marginBottom: 8,
  },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // A choice is a 44pt target (it was 40pt); minHeight, so a reason that wraps
  // at a larger text size grows the chip instead of clipping.
  reason: {
    minHeight: MIN_TAP,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    justifyContent: 'center',
  },
  reasonLabel: { fontSize: 13 },
  notes: {
    marginTop: 14,
    minHeight: 64,
    borderWidth: 1,
    borderRadius: RADIUS.card,
    padding: 12,
    fontFamily: FONT.displayRegular,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  error: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 12 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: 18 },
  // The shared Button's md recipe (52pt, radius 14), drawn here so a long
  // label wraps inside its half of the row instead of being cut short.
  action: {
    flex: 1,
    minHeight: 52,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: BUTTON_RADIUS.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionLabel: {
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 15,
    textAlign: 'center',
    flexShrink: 1,
  },
});
