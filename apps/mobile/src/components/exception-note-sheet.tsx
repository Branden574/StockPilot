import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { EXCEPTION_ACKNOWLEDGE_HELP } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import {
  actOnException,
  describeActError,
  EXCEPTION_NOTE_MAX,
  exceptionSheetSubmit,
  clientEventIdFor,
  type ExceptionSheetMode,
  type MobileExceptionOccurrence,
} from '@/lib/exceptions-api';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The Acknowledge and Add note sheets for one exception (F1-1). One component,
 * two modes, because they send the same request (POST
 * /api/v1/exceptions/[id]/act) and differ only in whether the note is
 * required.
 *
 *   - Nothing here resolves an exception. The system does that once a check
 *     no longer finds the condition; the Acknowledge help says so.
 *   - The submit button follows exceptionSheetSubmit, which takes the LIVE
 *     `online` state from the screen: turning on airplane mode with the sheet
 *     open disables it, with the reason shown, instead of letting the request
 *     fail.
 *   - The clientEventId belongs to the payload (clientEventIdFor): a resend
 *     of the same action and note reuses it, so a request whose answer was
 *     lost adds nothing when it is sent again; an edited note gets a new one,
 *     so the edit is never dropped as a replay of the lost request.
 */
export function ExceptionNoteSheet({
  visible,
  mode,
  occurrence,
  online,
  onClose,
  onDone,
}: {
  visible: boolean;
  mode: ExceptionSheetMode;
  occurrence: MobileExceptionOccurrence;
  online: boolean;
  onClose: () => void;
  onDone: (updated: MobileExceptionOccurrence) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Remounted per opening (key), so every opening starts blank with no
          earlier attempt to resend. */}
      <SheetContent
        key={`${String(visible)}:${mode}`}
        mode={mode}
        occurrence={occurrence}
        online={online}
        onClose={onClose}
        onDone={onDone}
      />
    </Modal>
  );
}

function SheetContent({
  mode,
  occurrence,
  online,
  onClose,
  onDone,
}: {
  mode: ExceptionSheetMode;
  occurrence: MobileExceptionOccurrence;
  online: boolean;
  onClose: () => void;
  onDone: (updated: MobileExceptionOccurrence) => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The last attempt that did not succeed. Its clientEventId is reused ONLY
  // for a resend of the same action and note (clientEventIdFor); an edited
  // note is a new request, so it is never dropped as a "replay" of the lost
  // first one. Read only in the submit handler, never during render.
  const lastAttempt = React.useRef<{ action: ExceptionSheetMode; note: string | null; id: string } | null>(null);

  const submitState = exceptionSheetSubmit({
    mode,
    note,
    submitting,
    online,
    canAct: occurrence.canAct,
    resolved: occurrence.resolvedAt !== null,
  });

  async function submit() {
    if (!submitState.enabled) return;
    setSubmitting(true);
    setError(null);
    const payloadNote = note.trim() || null;
    const clientEventId = clientEventIdFor(lastAttempt.current, mode, payloadNote);
    lastAttempt.current = { action: mode, note: payloadNote, id: clientEventId };
    try {
      const updated = await actOnException(occurrence.id, {
        action: mode,
        note: payloadNote,
        clientEventId,
      });
      onDone(updated);
    } catch (e) {
      // A conflict means this id already stands for another request: never
      // send it again.
      const reason = (e as { details?: { reason?: unknown } } | null)?.details?.reason;
      if (reason === 'client_event_id_conflict') lastAttempt.current = null;
      setError(describeActError(e));
      setSubmitting(false);
    }
  }

  const title = mode === 'acknowledge' ? 'Acknowledge this exception' : 'Add a note';
  const cta = mode === 'acknowledge' ? 'Acknowledge' : 'Add note';
  const count = Array.from(note.trim()).length;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      {/* Backdrop is a SIBLING behind the sheet, not its parent, so the body
          scrolls (see add-order-items-sheet.tsx). */}
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View style={[styles.sheet, { backgroundColor: c.card }]}>
          <View style={styles.header}>
            <Body size={16} color={c.ink} style={{ fontFamily: FONT.display, flex: 1 }}>
              {title}
            </Body>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }} style={{ maxHeight: 420 }}>
            {occurrence.reference ? (
              <Mono size={12} color={c.ink4}>
                {occurrence.reference}
              </Mono>
            ) : null}
            {mode === 'acknowledge' ? (
              <Body size={14} muted>
                {EXCEPTION_ACKNOWLEDGE_HELP}
              </Body>
            ) : null}
            <View style={{ gap: 6 }}>
              <FieldLabel>{mode === 'acknowledge' ? 'NOTE (OPTIONAL)' : 'NOTE'}</FieldLabel>
              <TextInput
                value={note}
                onChangeText={(t) => {
                  setNote(t);
                  setError(null);
                }}
                multiline
                editable={!submitting}
                placeholder={mode === 'acknowledge' ? 'What you are checking, if anything' : 'Write a note'}
                placeholderTextColor={c.ink4}
                accessibilityLabel={mode === 'acknowledge' ? 'Note, optional' : 'Note'}
                style={[
                  styles.input,
                  { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink },
                ]}
              />
              <Mono size={11} color={count > EXCEPTION_NOTE_MAX ? ACCENT.crit : c.ink4}>
                {`${count.toLocaleString('en-US')} / ${EXCEPTION_NOTE_MAX.toLocaleString('en-US')}`}
              </Mono>
            </View>
          </ScrollView>

          {/* Disabled-with-reason: a greyed-out button with no explanation
              reads as a broken app. */}
          {submitState.reason ? (
            <Body size={13} color={c.ink3} accessibilityRole="text">
              {submitState.reason}
            </Body>
          ) : null}
          {error ? (
            <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
              {error}
            </Body>
          ) : null}

          <Button block disabled={!submitState.enabled} onPress={() => void submit()}>
            {submitting ? 'Saving...' : cta}
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
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
