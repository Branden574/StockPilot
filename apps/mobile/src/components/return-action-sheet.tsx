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
  Switch,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  choiceFromKey,
  choiceKey,
  damagedHint,
  isChoiceOffered,
  qtyReturningLabel,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURN_REASON_MAX,
  RETURNS_COPY,
  restockOptionRows,
  type RestockChoice,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import {
  cancelReturn,
  denyReturn,
  describeReturnError,
  planReturnDispositions,
  runReturnSteps,
  type MobileReturnWorkbench,
  type MobileReturnWorkbenchLine,
} from '@/lib/returns-api';
import {
  allChoicesOffered,
  approvalDecision,
  changedDecisions,
  choiceFor,
  choiceProblems,
  denyHelp,
  initialChoices,
  openLines,
  processButtonLabel,
  processingHint,
  stepOutcomeMessage,
  whatHappensLines,
} from '@/lib/returns-view';
import { ACCENT, capTo, FONT, TYPE_CEILING } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

const TITLE_CAP = capTo(16, TYPE_CEILING.display);
const NOTE_FONT_CAP = capTo(15, TYPE_CEILING.input);

export type ReturnSheetMode = 'approve' | 'process' | 'destination' | 'deny' | 'cancel';

export interface ReturnSheetDone {
  message: string;
  workbench: MobileReturnWorkbench | null;
}

/**
 * The RMA workbench's sheets on the phone (returns RX-1): Approve (the
 * destination per line and "The item is here", off unless the RMA was created
 * at the counter), Process return (the destination re-checked, the button
 * named after the rack), Change destination, Deny (a reason, required) and
 * Cancel return (a reason, optional). One component, five modes.
 *
 * ONLINE ONLY: the submit button follows the LIVE `online` prop; turning on
 * airplane mode with the sheet open disables it with "Needs a connection."
 * Nothing is queued. A request under way cannot be dismissed (Close, the
 * backdrop, the VoiceOver escape and Android's back button), so its answer is
 * never lost; a lost answer is recovered by sending the same body again (the
 * steps route replays it).
 *
 * The destination rows come from core's restock-view (the server's
 * provenance answer); a rack that failed revalidation is shown disabled with
 * its reason, Staging is always one tap away, and Scrap hides the
 * destination group (brief 10). The rows are radio buttons with their
 * state, so VoiceOver reads "Return to original rack: 31-C, radio button,
 * selected"; a disabled row carries its reason in its label (a hint is not
 * read when hints are off). A planned rack that is gone opens with NO
 * destination chosen and a sentence naming the line and why; the button
 * stays disabled until a valid choice is made (plan 3.5.4, returns review).
 * When a process step is refused because the rack is gone, the answer's
 * workbench replaces the sheet's choices the same way and the refusal is
 * shown in place and announced; the person chooses and confirms again.
 *
 * Structure: the exception sheets' (sibling backdrop behind a plain card,
 * accessibilityViewIsModal, onAccessibilityTap on the scrim, the body the one
 * part that scrolls, sized by exceptionSheetLayout, the keyboard handled by
 * useSheetKeyboard).
 */
export function ReturnActionSheet({
  visible,
  mode,
  workbench,
  online,
  onClose,
  onDone,
}: {
  visible: boolean;
  mode: ReturnSheetMode;
  workbench: MobileReturnWorkbench;
  online: boolean;
  onClose: () => void;
  onDone: (done: ReturnSheetDone) => void;
}) {
  const busyRef = React.useRef(false);
  function requestCloseIfIdle() {
    if (busyRef.current) return;
    onClose();
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestCloseIfIdle}>
      <SheetContent
        key={`${String(visible)}:${mode}`}
        busyRef={busyRef}
        mode={mode}
        initialWorkbench={workbench}
        online={online}
        onClose={onClose}
        onDone={onDone}
      />
    </Modal>
  );
}

function SheetContent({
  busyRef,
  mode,
  initialWorkbench,
  online,
  onClose,
  onDone,
}: {
  busyRef: React.MutableRefObject<boolean>;
  mode: ReturnSheetMode;
  initialWorkbench: MobileReturnWorkbench;
  online: boolean;
  onClose: () => void;
  onDone: (done: ReturnSheetDone) => void;
}) {
  const { c, mode: themeMode } = useTheme();
  const [wb, setWb] = React.useState(initialWorkbench);
  const [choices, setChoices] = React.useState<Record<string, RestockChoice>>(() => initialChoices(initialWorkbench));
  const [itemIsHere, setItemIsHere] = React.useState(initialWorkbench.createdOnCounter);
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({ windowHeight: height, availableHeight, topInset: insets.top });
  const [attachBody, kb] = useSheetKeyboard();

  React.useEffect(() => {
    busyRef.current = false;
  }, [busyRef]);
  React.useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  function setBusy(v: boolean) {
    busyRef.current = v;
    setSubmitting(v);
  }
  function requestClose() {
    if (submitting) return;
    onClose();
  }

  const lines = openLines(wb);
  const needsDestinations = mode === 'approve' || mode === 'process' || mode === 'destination';
  const reasonText = reason.trim();
  const reasonCount = Array.from(reasonText).length;
  const reasonValid =
    mode === 'deny' ? reasonCount >= 1 && reasonCount <= RETURN_REASON_MAX : mode === 'cancel' ? reasonCount <= RETURN_REASON_MAX : true;
  const choicesValid = !needsDestinations || allChoicesOffered(wb, choices);
  // One sentence per line that needs a destination, naming it.
  const problems = needsDestinations ? choiceProblems(wb, choices) : [];
  const disabledReason = !online
    ? READINESS_NEEDS_CONNECTION_COPY
    : !choicesValid
      ? (problems.join(' ') || RETURNS_COPY.chooseDestination)
      : !reasonValid
        ? mode === 'deny'
          ? RETURNS_COPY.reasonRequired
          : `At most ${RETURN_REASON_MAX} characters.`
        : null;
  const canSubmit = disabledReason === null && !submitting;

  const title =
    mode === 'approve'
      ? RETURNS_COPY.approveReturn
      : mode === 'process'
        ? RETURNS_COPY.processReturn
        : mode === 'destination'
          ? RETURNS_COPY.changeDestination
          : mode === 'deny'
            ? 'Deny this return?'
            : 'Cancel this return?';
  const cta =
    mode === 'approve'
      ? itemIsHere
        ? RETURNS_COPY.approveAndReceive
        : RETURNS_COPY.approveReturn
      : mode === 'process'
        ? processButtonLabel(wb, choices)
        : mode === 'destination'
          ? 'Save destination'
          : mode === 'deny'
            ? RETURNS_COPY.deny
            : RETURNS_COPY.cancelReturn;

  async function submit() {
    if (!canSubmit) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    const id = wb.return.id;
    try {
      if (mode === 'approve' || mode === 'process') {
        const changed = changedDecisions(wb, choices);
        const res = await runReturnSteps(id, {
          steps: [mode === 'approve' ? 'approve' : 'process'],
          expectedRevision: wb.revision,
          expectedPlanSeq: wb.planSeq,
          ...(mode === 'approve'
            ? { approve: approvalDecision(wb, choices), receiveNow: itemIsHere }
            : { process: changed.length > 0 ? { lines: changed } : null }),
        });
        const step = res.ran[0];
        if (step && step.outcome === 'refused') {
          // The rack went away (or someone else moved first): redraw from the
          // answer and keep the sheet open for another choice.
          setWb(res.workbench);
          setChoices(initialChoices(res.workbench));
          setError(stepOutcomeMessage(step, res.workbench, itemIsHere));
          setBusy(false);
          return;
        }
        onDone({
          message: step ? stepOutcomeMessage(step, res.workbench, itemIsHere) : 'Saved.',
          workbench: res.workbench,
        });
        return;
      }
      if (mode === 'destination') {
        const changed = changedDecisions(wb, choices);
        if (changed.length > 0) await planReturnDispositions(id, changed);
        onDone({ message: changed.length > 0 ? 'Destination saved.' : 'Nothing changed.', workbench: null });
        return;
      }
      if (mode === 'deny') {
        const res = await denyReturn(id, reasonText);
        onDone({ message: res.changed ? 'Return denied.' : 'Already denied.', workbench: null });
        return;
      }
      const res = await cancelReturn(id, { expectedRevision: wb.revision, reason: reasonText || null });
      onDone({ message: res.changed ? 'Return cancelled.' : 'Already cancelled.', workbench: null });
    } catch (e) {
      setError(describeReturnError(e));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
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
          style={[StyleSheet.absoluteFill, { backgroundColor: themeMode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' }]}
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
              {title}
            </Body>
            <Pressable
              onPress={requestClose}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: submitting }}
              style={{ minWidth: MIN_TAP, minHeight: MIN_TAP, alignItems: 'flex-end', justifyContent: 'center' }}
            >
              <X size={18} color={c.ink4} />
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
            contentContainerStyle={{ gap: 14 }}
            style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
          >
            {wb.return.returnNumber ? (
              <Mono size={12} color={c.ink4}>
                {wb.return.returnNumber}
              </Mono>
            ) : null}

            {needsDestinations
              ? lines.map((l) => (
                  <LineDestination
                    key={l.id}
                    line={l}
                    choice={choiceFor(l, choices)}
                    disabled={submitting}
                    reasonCode={wb.return.reasonCode}
                    showHint={mode === 'process'}
                    onChange={(next) => {
                      setChoices((prev) => ({ ...prev, [l.id]: next }));
                      setError(null);
                    }}
                  />
                ))
              : null}

            {mode === 'approve' ? (
              <>
                <View style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Body size={14.5} color={c.ink}>
                      {RETURNS_COPY.itemIsHere}
                    </Body>
                    <Body size={12.5} muted>
                      {RETURNS_COPY.itemIsHereHelp}
                    </Body>
                  </View>
                  <Switch
                    value={itemIsHere}
                    onValueChange={setItemIsHere}
                    disabled={submitting}
                    accessibilityLabel={RETURNS_COPY.itemIsHere}
                    accessibilityHint={RETURNS_COPY.itemIsHereHelp}
                  />
                </View>
                <View
                  style={{ gap: 4 }}
                  accessible
                  accessibilityLabel={whatHappensLines(wb, choices)
                    .map((t) => t.text)
                    .join(' ')}
                >
                  <FieldLabel>WHAT HAPPENS WHEN YOU APPROVE</FieldLabel>
                  {whatHappensLines(wb, choices).map((t) => (
                    <Body key={t.key} size={13.5} muted>
                      {t.text}
                    </Body>
                  ))}
                </View>
              </>
            ) : null}

            {mode === 'deny' || mode === 'cancel' ? (
              <View style={{ gap: 6 }} onLayout={kb.onNoteBlockLayout}>
                <FieldLabel>{mode === 'deny' ? RETURNS_COPY.denyReasonLabel.toUpperCase() : RETURNS_COPY.cancelReasonLabel.toUpperCase()}</FieldLabel>
                {mode === 'deny' ? (
                  <Body size={13} muted>
                    {denyHelp(wb)}
                  </Body>
                ) : null}
                <TextInput
                  value={reason}
                  onChangeText={(t) => {
                    setReason(t);
                    setError(null);
                  }}
                  onFocus={kb.onNoteFocus}
                  onBlur={kb.onNoteBlur}
                  onLayout={kb.onNoteLayout}
                  maxFontSizeMultiplier={NOTE_FONT_CAP}
                  multiline
                  editable={!submitting}
                  placeholder={mode === 'deny' ? 'Why the return is denied' : 'Why the return is cancelled (optional)'}
                  placeholderTextColor={c.ink4}
                  accessibilityLabel={mode === 'deny' ? 'Reason for denying' : 'Reason, optional'}
                  style={[styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }]}
                />
                <Mono size={11} color={reasonCount > RETURN_REASON_MAX ? ACCENT.crit : c.ink4}>
                  {`${reasonCount.toLocaleString('en-US')} / ${RETURN_REASON_MAX.toLocaleString('en-US')}`}
                </Mono>
              </View>
            ) : null}
          </ScrollView>

          {disabledReason ? (
            <Body size={13} color={c.ink3} accessibilityRole="text">
              {disabledReason}
            </Body>
          ) : null}
          {error ? (
            <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
              {error}
            </Body>
          ) : null}

          <Button
            block
            variant={mode === 'deny' || mode === 'cancel' ? 'destructive' : 'primary'}
            disabled={!canSubmit}
            accessibilityHint={disabledReason ?? undefined}
            onPress={() => void submit()}
          >
            {submitting ? 'Saving…' : cta}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** One returned line's disposition and destination, as radio groups. */
function LineDestination({
  line,
  choice,
  disabled,
  reasonCode,
  showHint,
  onChange,
}: {
  line: MobileReturnWorkbenchLine;
  choice: RestockChoice;
  disabled: boolean;
  reasonCode: string | null;
  showHint: boolean;
  onChange: (next: RestockChoice) => void;
}) {
  const { c } = useTheme();
  const name = line.item.name ?? 'Item';
  const rows = line.restock ? restockOptionRows(line.restock) : [];
  const selectedKey = choiceKey(choice);
  const hint = damagedHint(reasonCode);
  // Back from scrap: the original rack only when it is offered to this viewer.
  const restockKey = (): string =>
    line.restock?.preselect === 'original' && isChoiceOffered(line.restock, { disposition: 'restock', target: 'original', locationId: null })
      ? 'original'
      : 'staging';

  return (
    <View style={[styles.lineCard, { borderColor: c.hair }]}>
      <Body size={14.5} color={c.ink} style={{ fontFamily: FONT.display }}>
        {name}
        {line.item.variant ? ` · ${line.item.variant}` : ''}
      </Body>
      <Body size={12.5} muted>
        {qtyReturningLabel(line.quantity)}
      </Body>

      <FieldLabel>{RETURNS_COPY.returnDisposition}</FieldLabel>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${RETURNS_COPY.returnDisposition} for ${name}`} style={styles.radioRow}>
        {(['restock', 'scrap'] as const).map((d) => {
          const checked = choice.disposition === d;
          return (
            <Pressable
              key={d}
              disabled={disabled}
              onPress={() => onChange(choiceFromKey(d, d === 'restock' ? (selectedKey ?? restockKey()) : null))}
              accessibilityRole="radio"
              accessibilityLabel={d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
              accessibilityState={{ checked, disabled }}
              style={[styles.chip, { borderColor: checked ? c.ink : c.hair, backgroundColor: checked ? c.paper2 : 'transparent' }]}
            >
              <Body size={14} color={c.ink}>
                {d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
              </Body>
            </Pressable>
          );
        })}
      </View>
      {hint ? (
        <Body size={12.5} muted>
          {hint}
        </Body>
      ) : null}

      {choice.disposition === 'restock' ? (
        <>
          <FieldLabel>{RETURNS_COPY.returnedItemDestination}</FieldLabel>
          <View accessibilityRole="radiogroup" accessibilityLabel={`${RETURNS_COPY.returnedItemDestination} for ${name}`} style={{ gap: 8 }}>
            {rows.map((row) => {
              const checked = selectedKey === row.key;
              const off = disabled || !row.enabled;
              const why = !row.enabled && row.disabledReason && row.disabledReason !== row.label ? row.disabledReason : null;
              return (
                <Pressable
                  key={row.key}
                  disabled={off}
                  onPress={() => onChange(choiceFromKey('restock', row.key))}
                  accessibilityRole="radio"
                  // The reason a row cannot be chosen is part of its label, so
                  // VoiceOver reads it with hints off (returns review).
                  accessibilityLabel={why ? `${row.label}. ${why}` : row.label}
                  accessibilityHint={row.enabled ? (row.help ?? undefined) : undefined}
                  accessibilityState={{ checked, disabled: off }}
                  style={[
                    styles.option,
                    { borderColor: checked ? c.ink : c.hair, backgroundColor: checked ? c.paper2 : 'transparent', opacity: row.enabled ? 1 : 0.6, minHeight: MIN_TAP },
                  ]}
                >
                  <Body size={14} color={c.ink}>
                    {row.label}
                  </Body>
                  {row.help && row.enabled ? (
                    <Body size={12.5} muted>
                      {row.help}
                    </Body>
                  ) : null}
                  {!row.enabled && row.disabledReason && row.disabledReason !== row.label ? (
                    <Body size={12.5} muted>
                      {row.disabledReason}
                    </Body>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {showHint ? (
        <Body size={12.5} muted>
          {processingHint(line, choice)}
        </Body>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 32, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { minHeight: 96, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lineCard: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  radioRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, minHeight: MIN_TAP, justifyContent: 'center' },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', gap: 2 },
});
