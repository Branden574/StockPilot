import * as React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { MIN_TAP } from '@/components/item-verification-card';
import { Body, Eyebrow, Mono } from '@/components/ui/text';
import {
  NEEDED_BY_DAY_EYEBROW,
  NEEDED_BY_OTHER_A11Y,
  NEEDED_BY_OTHER_HINT,
  NEEDED_BY_OTHER_PLACEHOLDER,
  NEEDED_BY_OTHER_TIME_LABEL,
  NEEDED_BY_TIME_EYEBROW,
  neededByDayRowScroll,
  type NeededByDraft,
  type NeededByDraftView,
} from '@/lib/order-needed-by';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * THE NEEDED-BY PICKER, shared by the order screen's "Change needed-by date"
 * sheet (F2-4, revise-needed-by-sheet.tsx) and the phone storefront's
 * checkout (phone ordering PO-4). Extracted from the F2-4 sheet with no
 * behaviour change: the same day chips, slots, "Other time" entry and
 * preview, driven by the same tested module (lib/order-needed-by.ts).
 *
 * JS only, no native date picker (OTA-safe): day chips for the next 21 days
 * and 30-minute slots from 6:00 AM to 7:00 PM, both in the ORGANIZATION's
 * zone, plus "Other time" for a time off the grid or a date past the chips.
 * The owner of the draft decides what a pick does (the sheet clears its
 * refusal and re-reads the clock); this only shows the view and reports the
 * taps. The storefront adds "Clear" (its needed-by is optional).
 *
 * Every chip is its own VoiceOver button, at least 44 pt, its label capped at
 * the control ceiling and its selected state announced; the Other time field
 * stops growing at the input ceiling; the sentences (preview, problems) are
 * content and grow with Dynamic Type.
 */
export function NeededByPicker({
  view,
  draft,
  busy,
  focusOther,
  onPickDay,
  onPickSlot,
  onPickOther,
  onOtherText,
  clear,
}: {
  view: Pick<NeededByDraftView, 'days' | 'selectedDayKey' | 'slots' | 'noSlotsNote' | 'preview' | 'timeProblem'>;
  draft: Pick<NeededByDraft, 'slot' | 'other' | 'otherText'>;
  busy: boolean;
  /** Focus the Other time entry (only once the person chose it, never on open). */
  focusOther: boolean;
  onPickDay: (dayKey: string) => void;
  onPickSlot: (time: string) => void;
  onPickOther: () => void;
  onOtherText: (text: string) => void;
  /** A "Clear" chip after Other time (the storefront's needed-by is optional). */
  clear?: { label: string; onPress: () => void };
}) {
  const { c } = useTheme();
  // The day row holds 21 chips and a phone shows about five: the selected day
  // is scrolled into it on open and whenever the selection moves.
  const [attachDayRow, dayRow] = useDayRowReveal(view.selectedDayKey);

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
    <>
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
              () => onPickDay(d.key),
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
              () => onPickSlot(s.time),
              s.label,
              [s.label],
            ),
          )}
          {chip(
            'other',
            draft.other,
            onPickOther,
            NEEDED_BY_OTHER_TIME_LABEL,
            [NEEDED_BY_OTHER_TIME_LABEL],
          )}
          {clear ? chip('clear', false, clear.onPress, clear.label, [clear.label]) : null}
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
              onChangeText={onOtherText}
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
    </>
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
 * row are measured (the picker opening), and whenever the selected day moves,
 * the row is scrolled so that chip shows whole (neededByDayRowScroll). Like
 * lib/use-sheet-keyboard.ts, the row and its geometry live in a closure made
 * once per mount, read in handlers and effects only, never while rendering.
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

/** Chip labels are chrome: they stop growing at the control ceiling, and the
 *  chip grows with them (minHeight). */
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
});
