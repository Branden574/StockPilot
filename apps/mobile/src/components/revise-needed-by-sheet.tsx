import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  NEEDED_BY_FIELD_LABEL,
  NEEDED_BY_REASON_HINT,
  NEEDED_BY_REASON_LABEL,
  NEEDED_BY_REASON_MAX,
  NEEDED_BY_REVISE_TITLE,
  NEEDED_BY_SAVE_LABEL,
  READINESS_NEEDS_CONNECTION_COPY,
  type NeededByRevisionOutcome,
} from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { Body, Eyebrow, FieldLabel, Mono } from '@/components/ui/text';
import { exceptionSheetLayout } from '@/lib/exception-sheet-layout';
import {
  NEEDED_BY_CANCEL_LABEL,
  NEEDED_BY_CLOSE_LABEL,
  NEEDED_BY_DAY_EYEBROW,
  NEEDED_BY_OTHER_A11Y,
  NEEDED_BY_OTHER_HINT,
  NEEDED_BY_OTHER_PLACEHOLDER,
  NEEDED_BY_OTHER_TIME_LABEL,
  NEEDED_BY_TIME_EYEBROW,
  initialNeededByDraft,
  neededByDayRowScroll,
  neededByDraftView,
  neededBySpokenUpdate,
  readOrderNeededBy,
  selectNeededByDay,
  submitNeededByRevision,
  type NeededByDraft,
} from '@/lib/order-needed-by';
import { reviseOrderNeededBy } from '@/lib/orders-api';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useSheetKeyboard } from '@/lib/use-sheet-keyboard';
import { useTheme } from '@/lib/use-theme';

/**
 * CHANGE AN ORDER'S NEEDED-BY DATE (F2-4): the phone twin of the web order
 * page's Change dialog, opened from "Change" beside the order's needed-by
 * (approvers with write access to the order's warehouse).
 *
 * JS only, no native date picker (OTA-safe): day chips for the next 21 days
 * and 30-minute slots from 6:00 AM to 7:00 PM, both in the ORGANIZATION's
 * zone, plus "Other time" for a time off the grid or a date past the chips.
 * It sends a zone-less wall clock ("YYYY-MM-DDTHH:mm") with the needed-by it
 * started from, exactly as read, and a reason; the server converts it in the
 * org's zone and moves the Schedule entry with it. The zone note, the preview
 * and every sentence after a save or a refusal are core's, the web dialog's
 * own words; every decision is lib/order-needed-by.ts (tested there).
 *
 * Save needs a connection (offline it is disabled, and says so). A refusal is
 * said here, in place (role alert, and announced: iOS gives the 'alert' role
 * no trait), with the typed reason and the chosen time kept (pattern #20).
 * When someone saved another date first, the sheet shows that date and starts
 * from it. It sends no email, and nothing here opens one.
 *
 * Mounted per open, so every session starts from the order as it is. While a
 * save runs it cannot be dismissed, so its answer is never lost. Built in the
 * sibling-backdrop shape (sheet-backdrop-guard.test.ts) inside a
 * KeyboardAvoidingView (the reason field sits low): every chip, field and
 * button is its own VoiceOver element, at least 44 pt, with its label capped
 * at the control ceiling; the sentences are content and grow with Dynamic
 * Type (the body scrolls).
 */
export function ReviseNeededBySheet({
  visible,
  orderId,
  organizationId,
  orderLabel,
  timeZone,
  startNeededBy,
  orderStatus,
  offline,
  onClose,
  onSaved,
  onRefresh,
}: {
  visible: boolean;
  orderId: string;
  organizationId: string;
  /** "SO-000016", under the title. */
  orderLabel: string | null;
  /** The org's zone, checked when the sheet opened (neededBySheetOpening). */
  timeZone: string;
  /** The order's needed-by EXACTLY as read (the stale check's value), or null. */
  startNeededBy: string | null;
  /** The order's status as the screen shows it now (what saving does depends on it). */
  orderStatus: string | null;
  /** No connection: Save is disabled, with the reason. */
  offline: boolean;
  onClose: () => void;
  /** The server changed (or kept) the date: the screen closes this and says it. */
  onSaved: (outcome: NeededByRevisionOutcome, title: string, message: string) => void;
  /** Read the order again behind the sheet (after a refusal that may mean it moved). */
  onRefresh: () => void;
}) {
  const { c, mode } = useTheme();
  const { height } = useWindowDimensions();
  const [draft, setDraft] = React.useState<NeededByDraft>(() =>
    initialNeededByDraft(startNeededBy, Date.now(), timeZone),
  );
  // The needed-by this sheet is replacing: the stale check's value, and what
  // "Current" shows. Moves only when the server says someone changed it (or
  // after an unanswered save), never under the person silently.
  const [expected, setExpected] = React.useState<string | null>(startNeededBy);
  const [busy, setBusy] = React.useState(false);
  // A second tap before the re-render that disables Save must not send a
  // second save (it would be refused as stale by the first one's own date).
  const saving = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [closed, setClosed] = React.useState(false);
  // Focus the entry only when the person chose Other time, never on open.
  const [focusOther, setFocusOther] = React.useState(false);
  // THE SHEET'S SIZE (iPhone 17 walk, 2026-09-30: with the keyboard up at the
  // default text size, and at AX5 with it down, a fixed 50% body pushed the
  // title, Close, the current date and the day row off the top of the
  // screen). Sized like the exception sheets: never taller than the space the
  // keyboard-avoiding wrapper leaves (measured), below the status bar; the
  // body is the part that gives way (flexShrink) and scrolls; the reason, the
  // low field, is scrolled back into view above the keyboard; a drag on the
  // body or a tap on the card outside a control puts the keyboard away. Fixed
  // pixel sizes, never percentages (they collapsed layouts under Fabric).
  const insets = useSafeAreaInsets();
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const layout = exceptionSheetLayout({
    windowHeight: height,
    availableHeight,
    topInset: insets.top,
  });
  const [attachBody, kb] = useSheetKeyboard();

  // The clock the chips and the preview are read against: set when the sheet
  // opens, on every change the person makes, and every 30 seconds while it is
  // open, so a slot that has just passed drops off without a tap. Save checks
  // against the clock at the tap itself.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const viewContext = {
    zone: timeZone,
    current: expected,
    status: orderStatus,
    offline,
    busy,
    closed,
  };
  const view = neededByDraftView(draft, { ...viewContext, now });
  // The day row holds 21 chips and a phone shows about five: the selected day
  // is scrolled into it on open and whenever the selection moves.
  const [attachDayRow, dayRow] = useDayRowReveal(view.selectedDayKey);

  // VoiceOver hears the preview in the org's zone, or why there is none, when
  // the chosen time changes: a chip, Other time as it is typed (debounced), or
  // a slot passing on the clock. The web dialog's preview is a live region;
  // iOS gives a Text no live region, so it is announced. The sheet's opening
  // state is not (VoiceOver reads the sheet as it opens).
  const spoken = neededBySpokenUpdate(view);
  const lastSpoken = React.useRef(spoken);
  React.useEffect(() => {
    if (spoken === null || spoken === lastSpoken.current) return;
    const timer = setTimeout(() => {
      lastSpoken.current = spoken;
      AccessibilityInfo.announceForAccessibility(spoken);
    }, SPOKEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [spoken]);

  function update(patch: Partial<NeededByDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
    setNow(readClock());
  }

  function pickDay(dayKey: string) {
    const at = readClock();
    setDraft((d) => selectNeededByDay(d, dayKey, at, timeZone));
    setError(null);
    setNow(at);
  }

  function requestClose() {
    if (busy) return;
    onClose();
  }

  async function save() {
    if (saving.current) return;
    // Against the clock at the tap: a slot that passed since the last tick is
    // said here (the view re-reads the clock), never sent.
    const atTap = neededByDraftView(draft, { ...viewContext, now: readClock() });
    if (!atTap.canSave || atTap.wall === null || atTap.reason === null) {
      setNow(readClock());
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    const result = await submitNeededByRevision(
      {
        revise: reviseOrderNeededBy,
        readCurrent: () => readOrderNeededBy(supabase, organizationId, orderId),
      },
      { orderId, wall: atTap.wall, expected, reason: atTap.reason, zone: timeZone },
    );
    saving.current = false;
    setBusy(false);
    if (result.kind === 'saved') {
      onSaved(result.outcome, result.title, result.message);
      return;
    }
    setError(result.message);
    AccessibilityInfo.announceForAccessibility(result.message);
    if (result.current !== undefined) setExpected(result.current.neededBy);
    if (result.closed) setClosed(true);
    if (result.current !== undefined || result.closed) onRefresh();
  }

  const chip = (
    key: string,
    selected: boolean,
    onPress: () => void,
    accessibilityLabel: string,
    lines: string[],
    onLayout?: (e: LayoutChangeEvent) => void,
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled: busy }}
      style={[
        styles.chip,
        {
          borderColor: selected ? c.ink : c.hair,
          backgroundColor: selected ? c.ink : 'transparent',
          opacity: busy ? 0.5 : 1,
        },
      ]}
      onLayout={onLayout}
    >
      {lines.map((line, i) => (
        <Mono
          key={i}
          size={i === 0 ? 12.5 : 11}
          color={selected ? c.paper : i === 0 ? c.ink : c.ink3}
          maxFontSizeMultiplier={CHIP_CAP}
        >
          {line}
        </Mono>
      ))}
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      {/*
       * React Native does not move Modal content for the keyboard, and this
       * sheet is bottom-anchored with the reason field low in it: without this
       * the field and both buttons sit under the keyboard. The same wrapper
       * edit-order-line-sheet uses.
       */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {/*
         * Backdrop is a SIBLING behind the sheet, not its parent: a Pressable
         * ancestor folds the whole card into one VoiceOver element and claims
         * the touch before the body can scroll. Taps outside still close,
         * because the scrim fills the screen behind the card.
         */}
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
              { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
            ]}
          />
          <View
            onStartShouldSetResponder={kb.claimTapOutside}
            onResponderRelease={kb.onTapOutside}
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              paddingBottom: 30,
              gap: 12,
              maxHeight: layout.sheetMaxHeight,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Body
                  size={16}
                  color={c.ink}
                  accessibilityRole="header"
                  maxFontSizeMultiplier={TITLE_CAP}
                  style={{ fontFamily: FONT.display }}
                >
                  {NEEDED_BY_REVISE_TITLE}
                </Body>
                {orderLabel ? (
                  <Mono size={11} color={c.ink4}>
                    {orderLabel}
                  </Mono>
                ) : null}
              </View>
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

            {/* keyboardShouldPersistTaps="handled": otherwise the first tap
                after typing only dismisses the keyboard, and a chip or Save
                needs a second tap. The one part that scrolls, and the one that
                gives way (flexShrink) before the title, Close or the buttons
                leave the screen. */}
            <ScrollView
              ref={attachBody}
              style={{ maxHeight: layout.bodyMaxHeight, flexShrink: 1 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={16}
              onScroll={kb.onBodyScroll}
              onLayout={kb.onBodyLayout}
              onContentSizeChange={kb.onBodyContentSizeChange}
              contentContainerStyle={{ gap: 12 }}
            >
              <Body size={14} color={c.ink}>
                {view.current}
              </Body>

              <View style={{ gap: 4 }}>
                <FieldLabel>{NEEDED_BY_FIELD_LABEL}</FieldLabel>
                <Body size={12.5} color={c.ink3}>
                  {view.zoneNote}
                </Body>
              </View>

              <View style={{ gap: 8 }}>
                <Eyebrow>{NEEDED_BY_DAY_EYEBROW}</Eyebrow>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  ref={attachDayRow}
                  onLayout={dayRow.rowLaid}
                  onScroll={dayRow.scrolled}
                  scrollEventThrottle={16}
                  contentContainerStyle={{ gap: 8, paddingRight: 8 }}
                >
                  {view.days.map((d) =>
                    chip(
                      d.key,
                      view.selectedDayKey === d.key,
                      () => pickDay(d.key),
                      d.accessibilityLabel,
                      [d.label, d.dateLabel],
                      (e) => dayRow.chipLaid(d.key, e),
                    ),
                  )}
                </ScrollView>
              </View>

              <View style={{ gap: 8 }}>
                <Eyebrow>{NEEDED_BY_TIME_EYEBROW}</Eyebrow>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {view.slots.map((s) =>
                    chip(
                      s.time,
                      !draft.other && draft.slot === s.time,
                      () => update({ slot: s.time, other: false }),
                      s.label,
                      [s.label],
                    ),
                  )}
                  {chip(
                    'other',
                    draft.other,
                    () => {
                      update({ other: true });
                      setFocusOther(true);
                    },
                    NEEDED_BY_OTHER_TIME_LABEL,
                    [NEEDED_BY_OTHER_TIME_LABEL],
                  )}
                </View>
                {view.noSlotsNote ? (
                  <Body size={12.5} color={c.ink3}>
                    {view.noSlotsNote}
                  </Body>
                ) : null}
                {draft.other ? (
                  <View style={{ gap: 6 }}>
                    <TextInput
                      value={draft.otherText}
                      onChangeText={(t) => update({ otherText: t })}
                      placeholder={NEEDED_BY_OTHER_PLACEHOLDER}
                      placeholderTextColor={c.ink4}
                      autoFocus={focusOther}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="done"
                      editable={!busy}
                      accessibilityLabel={NEEDED_BY_OTHER_A11Y}
                      accessibilityHint={NEEDED_BY_OTHER_HINT}
                      maxFontSizeMultiplier={INPUT_CAP}
                      style={[
                        styles.input,
                        { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink },
                      ]}
                    />
                  </View>
                ) : null}
              </View>

              {/* The preview in the org's zone (core's words), or why there is
                  none yet. */}
              {view.preview ? (
                <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
                  {view.preview}
                </Body>
              ) : view.timeProblem ? (
                <Body
                  size={12.5}
                  color={
                    (draft.slot && !draft.other) || (draft.other && draft.otherText.trim() !== '')
                      ? ACCENT.warn
                      : c.ink3
                  }
                >
                  {view.timeProblem}
                </Body>
              ) : null}

              <View style={{ gap: 6 }} onLayout={kb.onNoteBlockLayout}>
                <FieldLabel>{NEEDED_BY_REASON_LABEL}</FieldLabel>
                <TextInput
                  value={draft.reason}
                  onChangeText={(t) => update({ reason: t })}
                  onFocus={kb.onNoteFocus}
                  onBlur={kb.onNoteBlur}
                  onLayout={kb.onNoteLayout}
                  multiline
                  maxLength={NEEDED_BY_REASON_MAX}
                  editable={!busy}
                  accessibilityLabel={NEEDED_BY_REASON_LABEL}
                  accessibilityHint={NEEDED_BY_REASON_HINT}
                  maxFontSizeMultiplier={INPUT_CAP}
                  style={[
                    styles.input,
                    styles.reason,
                    { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink },
                  ]}
                />
                <Body size={12} color={c.ink3}>
                  {NEEDED_BY_REASON_HINT}
                </Body>
                {view.reasonProblem ? (
                  <Body size={12.5} color={ACCENT.warn}>
                    {view.reasonProblem}
                  </Body>
                ) : null}
              </View>

              {/* What saving does to the Schedule entry, said before saving
                  (core's words; the confirmation says what actually happened). */}
              <Body size={12.5} color={c.ink3}>
                {view.effect}
              </Body>
            </ScrollView>

            {error ? (
              <Body size={13} color={ACCENT.crit} accessibilityRole="alert">
                {error}
              </Body>
            ) : null}
            {offline && !closed ? (
              <Body size={12.5} muted>
                {READINESS_NEEDS_CONNECTION_COPY}
              </Body>
            ) : null}

            {closed ? null : (
              <Pressable
                onPress={() => void save()}
                disabled={!view.canSave}
                accessibilityRole="button"
                accessibilityLabel={NEEDED_BY_SAVE_LABEL}
                accessibilityState={{ disabled: !view.canSave, busy }}
                accessibilityHint={view.saveBlockedBy ?? undefined}
                style={[
                  styles.action,
                  { backgroundColor: c.ink, opacity: view.canSave || busy ? 1 : 0.5 },
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={c.paper} />
                ) : (
                  <Mono size={13} color={c.paper} maxFontSizeMultiplier={ACTION_CAP}>
                    {NEEDED_BY_SAVE_LABEL}
                  </Mono>
                )}
              </Pressable>
            )}
            <Pressable
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={closed ? NEEDED_BY_CLOSE_LABEL : NEEDED_BY_CANCEL_LABEL}
              accessibilityState={{ disabled: busy }}
              style={[styles.action, { borderWidth: 1, borderColor: c.hair, opacity: busy ? 0.5 : 1 }]}
            >
              <Mono size={13} color={c.ink} maxFontSizeMultiplier={ACTION_CAP}>
                {closed ? NEEDED_BY_CLOSE_LABEL : NEEDED_BY_CANCEL_LABEL}
              </Mono>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Where the day row's chips sit (x and width in its content), its scroll
 *  offset and its visible width, as measured. */
type DayRowGeometry = { chips: Map<string, { x: number; w: number }>; offset: number; width: number };

/**
 * THE SELECTED DAY, SCROLLED INTO THE DAY ROW (iPhone 17 walk, 2026-09-30: an
 * order needed a week out opened with its day chip off the right edge while
 * its time chip showed selected below it). The row reports its width and its
 * scroll offset, each day chip where it sits; once the selected chip and the
 * row are measured (the sheet opening), and whenever the selected day moves,
 * the row is scrolled so that chip shows whole (neededByDayRowScroll). Like
 * lib/use-sheet-keyboard.ts, the row and its geometry live in a closure made
 * once per opening, read in handlers and effects only, never while rendering.
 */
function useDayRowReveal(selectedDayKey: string | null) {
  const [reveal] = React.useState(() => {
    let row: ScrollView | null = null;
    let selected: string | null = null;
    const geometry: DayRowGeometry = { chips: new Map(), offset: 0, width: 0 };
    return {
      attach: (node: ScrollView | null) => {
        row = node;
      },
      select: (key: string | null) => {
        selected = key;
        revealDay(row, geometry, key);
      },
      handlers: {
        chipLaid: (key: string, e: LayoutChangeEvent) => {
          geometry.chips.set(key, { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width });
          if (key === selected) revealDay(row, geometry, key);
        },
        rowLaid: (e: LayoutChangeEvent) => {
          geometry.width = e.nativeEvent.layout.width;
          revealDay(row, geometry, selected);
        },
        scrolled: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          geometry.offset = e.nativeEvent.contentOffset.x;
        },
      },
    };
  });
  React.useEffect(() => {
    reveal.select(selectedDayKey);
  }, [reveal, selectedDayKey]);
  return [reveal.attach, reveal.handlers] as const;
}

/**
 * Scrolls the day row so the chip for `key` shows whole (neededByDayRowScroll),
 * once it and the row are measured; nothing when it already shows.
 */
function revealDay(row: ScrollView | null, geometry: DayRowGeometry, key: string | null) {
  if (!row || !key) return;
  const chip = geometry.chips.get(key);
  if (!chip) return;
  const x = neededByDayRowScroll({
    chipX: chip.x,
    chipWidth: chip.w,
    offset: geometry.offset,
    viewport: geometry.width,
  });
  if (x === null) return;
  geometry.offset = x;
  row.scrollTo({ x, animated: false });
}

/** The wall clock, read in event handlers and the tick only (never while
 *  rendering: the view is computed from the `now` held in state). */
function readClock(): number {
  return Date.now();
}

/** How long the time must stay put before VoiceOver is told it (typing in
 *  Other time changes it on every key). */
const SPOKEN_DEBOUNCE_MS = 600;

/** The title stops at the display ceiling, like every sheet's title, so at
 *  AX5 it does not take the screen the chips and fields need. */
const TITLE_CAP = capTo(16, TYPE_CEILING.display);
/** Button and chip labels are chrome: they stop growing at the control
 *  ceiling, and the control grows with them (minHeight). */
const ACTION_CAP = capTo(13, TYPE_CEILING.control);
const CHIP_CAP = capTo(12.5, TYPE_CEILING.control);
/** Typed text stops at the input ceiling (a bordered box). */
const INPUT_CAP = capTo(15, TYPE_CEILING.input);

const styles = StyleSheet.create({
  chip: {
    minHeight: MIN_TAP,
    minWidth: MIN_TAP,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT.mono,
    fontSize: 15,
  },
  reason: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
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
