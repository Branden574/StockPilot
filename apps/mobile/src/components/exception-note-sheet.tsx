import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
  CONFIRM_COUNT_CLOSE_LABEL,
  CONFIRM_COUNT_INSTEAD_LABEL,
  CONFIRM_COUNT_LABEL,
  CONFIRM_COUNT_NOTE_PLACEHOLDER,
  confirmCountDialogCopy,
  EXCEPTION_ACKNOWLEDGE_HELP,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import type { ExceptionSheetConfirm } from '@/lib/exception-confirm-view';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import {
  actOnException,
  clientEventIdFor,
  confirmExceptionCount,
  describeActError,
  describeConfirmCountError,
  EXCEPTION_NOTE_MAX,
  exceptionSheetSubmit,
  type ExceptionSheetMode,
  type MobileExceptionOccurrence,
} from '@/lib/exceptions-api';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/** The sheet's title is a heading in a bottom sheet: it grows with Dynamic
 *  Type up to the display ceiling, never so far that it pushes the numbers
 *  and the buttons off a small phone. */
const TITLE_CAP = capTo(16, TYPE_CEILING.display);

/** The words for a refused confirm when the screen sent no context. */
const FALLBACK_ERROR_CONTEXT: ExceptionSheetConfirm['errorContext'] = {
  recount: 'not_permitted',
  recountNumber: null,
  counterLabel: null,
};

/**
 * The Acknowledge, Add note and Confirm this count sheets for one exception.
 * One component, three modes, so the Acknowledge sheet can become the
 * confirm sheet in place.
 *
 *   - Acknowledge and Add note send the same request (POST
 *     /api/v1/exceptions/[id]/act) and differ only in whether the note is
 *     required. Neither resolves anything. On a count difference the
 *     Acknowledge help is its own (core countVarianceAcknowledgeHelp): the
 *     counted numbers, that acknowledging does not clear it, and what does.
 *   - Confirm this count (count differences; owner decision 2026-09-29)
 *     closes the exception by confirming the counted number, without a
 *     second count. It exists only while the server sends a countConfirm
 *     block that says this reader may confirm; the phone ships it before the
 *     server offers it. "Confirm this count instead" in the Acknowledge sheet
 *     switches the mode in place and KEEPS the typed note (the mode is state
 *     here; the content remounts only per opening).
 *   - The submit button follows exceptionSheetSubmit, which takes the LIVE
 *     `online` state from the screen: turning on airplane mode with the sheet
 *     open disables it, with the reason shown, instead of letting the request
 *     fail. A confirm is online only and never queued.
 *   - Acknowledge and Add note's clientEventId belongs to the payload
 *     (clientEventIdFor): a resend of the same action and note reuses it; an
 *     edited note gets a new one. A confirm carries no id: the server judges a
 *     replay from what it stored, so a resend after a lost answer is the same
 *     request and comes back as a success.
 *
 * VoiceOver and 44 pt, to the approve-partial sheet's standard: the sheet is
 * modal and escapable, its title is a header, Close and the backdrop are
 * buttons (Close 44 pt), the confirm's numbers are one element, and a refusal
 * is shown in place and announced. A request under way cannot be dismissed
 * (Close, the backdrop, the VoiceOver escape and Android's back button), so
 * its answer is never lost. Button labels stop growing at the control
 * ceiling (the Button primitive), the title at the display ceiling; the
 * sentences are content and grow with Dynamic Type, scrolling inside the
 * body. The sheet is never taller than the space above the keyboard
 * (exceptionSheetLayout), so the title, Close and the buttons stay on screen
 * on a small phone at the largest text size, with the keyboard up.
 */
export function ExceptionNoteSheet({
  visible,
  mode,
  occurrence,
  acknowledgeHelp = null,
  confirm = null,
  online,
  onClose,
  onDone,
}: {
  visible: boolean;
  /** The mode the sheet opens in. */
  mode: ExceptionSheetMode;
  occurrence: MobileExceptionOccurrence;
  /** A count difference's own Acknowledge help; the shared help otherwise. */
  acknowledgeHelp?: string | null;
  /** A count difference's confirm (lib/exception-confirm-view.ts); null for
   *  any other exception. */
  confirm?: ExceptionSheetConfirm | null;
  online: boolean;
  onClose: () => void;
  onDone: (updated: MobileExceptionOccurrence, done: { mode: ExceptionSheetMode; replay: boolean }) => void;
}) {
  // Whether a request is under way, for Android's back button (the Modal's
  // onRequestClose), which sits outside the content that owns the state.
  const busyRef = React.useRef(false);
  function requestCloseIfIdle() {
    if (busyRef.current) return;
    onClose();
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestCloseIfIdle}>
      {/* Remounted per opening (key), so every opening starts blank with no
          earlier attempt to resend. Switching to Confirm inside an opening
          does not remount it. */}
      <SheetContent
        key={`${String(visible)}:${mode}`}
        busyRef={busyRef}
        initialMode={mode}
        occurrence={occurrence}
        acknowledgeHelp={acknowledgeHelp}
        confirm={confirm}
        online={online}
        onClose={onClose}
        onDone={onDone}
      />
    </Modal>
  );
}

function SheetContent({
  busyRef,
  initialMode,
  occurrence,
  acknowledgeHelp,
  confirm,
  online,
  onClose,
  onDone,
}: {
  busyRef: React.MutableRefObject<boolean>;
  initialMode: ExceptionSheetMode;
  occurrence: MobileExceptionOccurrence;
  acknowledgeHelp: string | null;
  confirm: ExceptionSheetConfirm | null;
  online: boolean;
  onClose: () => void;
  onDone: (updated: MobileExceptionOccurrence, done: { mode: ExceptionSheetMode; replay: boolean }) => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [mode, setMode] = React.useState<ExceptionSheetMode>(initialMode);
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The height the keyboard-avoiding wrapper leaves, measured; null until
  // the first layout pass.
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({
    windowHeight: height,
    availableHeight,
    topInset: insets.top,
  });
  // The last act attempt that did not succeed. Its clientEventId is reused
  // ONLY for a resend of the same action and note (clientEventIdFor); an
  // edited note is a new request, so it is never dropped as a "replay" of the
  // lost first one. Read only in the submit handler, never during render.
  const lastAttempt = React.useRef<{ action: 'acknowledge' | 'note'; note: string | null; id: string } | null>(null);

  const block = confirm?.block ?? null;
  const dialog = block ? confirmCountDialogCopy({ reference: occurrence.reference, confirm: block }) : null;

  const submitState = exceptionSheetSubmit({
    mode,
    note,
    submitting,
    online,
    canAct: occurrence.canAct,
    resolved: occurrence.resolvedAt !== null,
    canConfirm: block?.canConfirm === true,
    confirmUnavailable: confirm?.unavailable ?? null,
  });

  // Every opening starts idle (a success closes the sheet without clearing
  // the flag).
  React.useEffect(() => {
    busyRef.current = false;
  }, [busyRef]);

  function setBusy(value: boolean) {
    busyRef.current = value;
    setSubmitting(value);
  }

  // A refusal is announced as it appears (iOS gives the alert role no
  // trait), keyed on its words.
  React.useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  function requestClose() {
    if (submitting) return;
    onClose();
  }

  function switchToConfirm() {
    setMode('confirm_count');
    setError(null);
  }

  async function submit() {
    if (!submitState.enabled) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    const payloadNote = note.trim() || null;
    if (mode === 'confirm_count') {
      if (!block) {
        setBusy(false);
        return;
      }
      try {
        const res = await confirmExceptionCount(occurrence.id, {
          cycleCountId: block.cycleCountId,
          countedQuantity: block.counted,
          note: payloadNote,
        });
        onDone(res.occurrence, { mode, replay: res.replay });
      } catch (e) {
        setError(describeConfirmCountError(e, confirm?.errorContext ?? FALLBACK_ERROR_CONTEXT));
        setBusy(false);
      }
      return;
    }
    const clientEventId = clientEventIdFor(lastAttempt.current, mode, payloadNote);
    lastAttempt.current = { action: mode, note: payloadNote, id: clientEventId };
    try {
      const updated = await actOnException(occurrence.id, {
        action: mode,
        note: payloadNote,
        clientEventId,
      });
      onDone(updated, { mode, replay: false });
    } catch (e) {
      // A conflict means this id already stands for another request: never
      // send it again.
      const reason = (e as { details?: { reason?: unknown } } | null)?.details?.reason;
      if (reason === 'client_event_id_conflict') lastAttempt.current = null;
      setError(describeActError(e));
      setBusy(false);
    }
  }

  const title =
    mode === 'acknowledge'
      ? 'Acknowledge this exception'
      : mode === 'note'
        ? 'Add a note'
        : (dialog?.sheetTitle ?? CONFIRM_COUNT_LABEL);
  const cta = mode === 'acknowledge' ? 'Acknowledge' : 'Add note';
  const count = Array.from(note.trim()).length;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      {/* Backdrop is a SIBLING behind the sheet, not its parent, so the body
          scrolls and VoiceOver reaches each control (see
          sheet-backdrop-guard.test.ts). */}
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={requestClose}
        onLayout={(e) => setAvailableHeight(e.nativeEvent.layout.height)}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={requestClose}
          onAccessibilityTap={requestClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View style={[styles.sheet, { backgroundColor: c.card, maxHeight: layout.sheetMaxHeight }]}>
          <View style={styles.header}>
            <Body
              size={16}
              color={c.ink}
              accessibilityRole="header"
              maxFontSizeMultiplier={TITLE_CAP}
              style={{ fontFamily: FONT.display, flex: 1 }}
            >
              {title}
            </Body>
            <Pressable
              onPress={requestClose}
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
              <X size={18} color={c.ink4} />
            </Pressable>
          </View>

          {/* The one part that scrolls, and the one that gives way: it
              shrinks before the title, Close or the buttons leave the screen. */}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 12 }}
            style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
          >
            {occurrence.reference ? (
              <Mono size={12} color={c.ink4}>
                {occurrence.reference}
              </Mono>
            ) : null}
            {mode === 'acknowledge' ? (
              <Body size={14} muted>
                {acknowledgeHelp ?? EXCEPTION_ACKNOWLEDGE_HELP}
              </Body>
            ) : null}
            {mode === 'acknowledge' && block?.canConfirm ? (
              <Button block variant="outline" onPress={switchToConfirm} disabled={submitting}>
                {CONFIRM_COUNT_INSTEAD_LABEL}
              </Button>
            ) : null}
            {mode === 'confirm_count' && dialog ? (
              <>
                {/* One VoiceOver element: the numbers read together, never
                    as loose lines. */}
                <View
                  accessible
                  accessibilityLabel={dialog.numbersLabel}
                  style={{ gap: 4, paddingVertical: 4 }}
                >
                  {dialog.numbers.map((line) => (
                    <Body key={line} size={14.5} color={c.ink}>
                      {line}
                    </Body>
                  ))}
                  {dialog.who ? (
                    <Body size={13.5} muted>
                      {dialog.who}
                    </Body>
                  ) : null}
                </View>
                <Body size={14} color={c.ink}>
                  {dialog.consequence}
                </Body>
              </>
            ) : null}
            <View style={{ gap: 6 }}>
              <FieldLabel>{mode === 'note' ? 'NOTE' : 'NOTE (OPTIONAL)'}</FieldLabel>
              <TextInput
                value={note}
                onChangeText={(t) => {
                  setNote(t);
                  setError(null);
                }}
                multiline
                editable={!submitting}
                placeholder={
                  mode === 'acknowledge'
                    ? 'What you are checking, if anything'
                    : mode === 'note'
                      ? 'Write a note'
                      : (dialog?.notePlaceholder ?? CONFIRM_COUNT_NOTE_PLACEHOLDER)
                }
                placeholderTextColor={c.ink4}
                accessibilityLabel={mode === 'note' ? 'Note' : 'Note, optional'}
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

          {mode === 'confirm_count' && dialog ? (
            <View style={{ gap: 8 }}>
              <Button
                block
                disabled={!submitState.enabled}
                accessibilityHint={submitState.reason ?? undefined}
                onPress={() => void submit()}
              >
                {submitting ? dialog.pendingLabel : dialog.confirmLabel}
              </Button>
              <Button block variant="outline" disabled={submitting} onPress={requestClose}>
                {dialog.cancelLabel}
              </Button>
            </View>
          ) : mode === 'confirm_count' ? (
            // The server stopped offering it (a re-read while the sheet was
            // open): the reason above says why; nothing to confirm.
            <Button block variant="outline" onPress={requestClose}>
              {CONFIRM_COUNT_CLOSE_LABEL}
            </Button>
          ) : (
            <Button block disabled={!submitState.enabled} onPress={() => void submit()}>
              {submitting ? 'Saving...' : cta}
            </Button>
          )}
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
