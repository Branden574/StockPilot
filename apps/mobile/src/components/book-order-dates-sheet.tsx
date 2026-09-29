import { Check, X } from 'lucide-react-native';
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

import {
  BOOK_REPORT_RANGE_LABELS,
  BOOK_REPORT_UI,
  isCalendarDay,
  monthOf,
  rangeComplete,
  rangePick,
  type BookReportQuery,
  type BookReportRange,
  type BookReportRangeEcho,
  type CalendarEditing,
  type CalendarMonth,
} from '@stockpilot/core';

import { OptionRow, SHEET_MIN_TAP, sheetStyles } from '@/components/book-order-sheet-parts';
import { Button } from '@/components/ui/button';
import { MonthCalendar } from '@/components/ui/month-calendar';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import {
  BOOK_REPORT_DATE_CHOICES,
  bookReportCustomRangeQuery,
  bookReportDateTile,
  bookReportDatesSheetStart,
  bookReportDraftProblems,
  bookReportPresetQuery,
} from '@/lib/book-order-totals-view';
import { ACCENT, FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Orders placed (plan 5, D7): the report's dates, in the brief's order.
 *
 *   - A preset (All time, Today, This week, This month, Last 30 days, Last 90
 *     days, This year) applies at once and closes, as the web select does.
 *   - Custom range opens a start and an end tile, a month calendar and the
 *     organization's time zone line. A tap on a day sets the tile being
 *     edited (core's rangePick: the start, then the end; a day before the
 *     start starts again). Apply needs both ends and sends the range on page
 *     1; Cancel changes nothing. Nothing is requested while picking.
 *   - "Type dates instead" keeps the typed YYYY-MM-DD pair for far-away dates
 *     and for VoiceOver users who prefer typing; the refusal is core's
 *     sentence, the web page's.
 *   - The calendar opens on the applied range's days (a preset's resolved
 *     days from the answer on screen), else on the organization's today.
 *
 * Built the sibling-backdrop way (sheet-backdrop-guard.test.ts), like the
 * other two report sheets.
 */
export function BookOrderDatesSheet(props: {
  visible: boolean;
  onClose: () => void;
  /** The applied query (what the report shows or is loading). */
  value: BookReportQuery;
  /** The on-screen answer's range: a preset's resolved days. */
  echo: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'> | null;
  /** 'Times are in America/Los_Angeles.' from the latest answer, or null. */
  zoneLine: string | null;
  /** The organization's today, from an answer; null marks no day. */
  today: string | null;
  /** The month to open on when neither the range nor today says one. */
  fallbackMonth: CalendarMonth;
  onApply: (next: BookReportQuery) => void;
}) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      {/* Remounted per open: every session starts from what is applied. */}
      <DatesContent key={String(props.visible)} {...props} />
    </Modal>
  );
}

function DatesContent({
  onClose,
  value,
  echo,
  zoneLine,
  today,
  fallbackMonth,
  onApply,
}: React.ComponentProps<typeof BookOrderDatesSheet>) {
  const { c, mode } = useTheme();
  const [initial] = React.useState(() => bookReportDatesSheetStart({ query: value, echo, today }));
  const [choice, setChoice] = React.useState<BookReportRange>(value.range);
  // The custom range as typed or picked. The calendar reads only real days,
  // so a half-typed date is simply not shown there yet.
  const [from, setFrom] = React.useState<string | null>(initial.draft.start);
  const [to, setTo] = React.useState<string | null>(initial.draft.end);
  const [editing, setEditing] = React.useState<CalendarEditing>(initial.draft.editing);
  const [month, setMonth] = React.useState<CalendarMonth>(initial.month ?? fallbackMonth);
  const [typing, setTyping] = React.useState(false);
  const [touchedDates, setTouchedDates] = React.useState(false);

  const start = isCalendarDay(from) ? from : null;
  const end = isCalendarDay(to) ? to : null;
  const draft = { start, end, editing };
  const complete = rangeComplete({ start: from, end: to });
  const problems = bookReportDraftProblems({ ...value, range: 'custom', from, to });
  const startTile = bookReportDateTile('start', from);
  const endTile = bookReportDateTile('end', to);

  function choose(r: BookReportRange) {
    if (r === 'custom') {
      setChoice('custom');
      return;
    }
    onApply(bookReportPresetQuery(value, r));
  }

  function pick(ymd: string) {
    const next = rangePick(draft, ymd);
    setFrom(next.start);
    setTo(next.end);
    setEditing(next.editing);
  }

  function editTile(which: CalendarEditing) {
    setEditing(which);
    const day = which === 'start' ? start : end;
    if (day) setMonth(monthOf(day));
  }

  function typed(which: CalendarEditing, v: string) {
    const t = v.trim() || null;
    if (which === 'start') setFrom(t);
    else setTo(t);
    if (isCalendarDay(t)) setMonth(monthOf(t));
  }

  function apply() {
    const next = bookReportCustomRangeQuery(value, from, to);
    if (!next) {
      setTouchedDates(true);
      return;
    }
    onApply(next);
  }

  const custom = choice === 'custom';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      {/* accessibilityViewIsModal keeps VoiceOver inside the open sheet;
          onAccessibilityTap makes a VoiceOver double-tap on the scrim close
          it directly (iOS otherwise taps the scrim's centre, which the card
          covers); the two-finger scrub closes it too. */}
      <View style={styles.container} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <Pressable
          onPress={onClose}
          onAccessibilityTap={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },
          ]}
        />
        <View style={[styles.card, { backgroundColor: c.card }, SHADOW.sheet]}>
          <View style={styles.header}>
            <Mono
              size={13}
              tracking={0.08}
              color={c.ink}
              maxFontSizeMultiplier={capTo(13, TYPE_CEILING.control)}
              style={{ fontFamily: FONT.display, flexShrink: 1 }}
              accessibilityRole="header"
            >
              ORDERS PLACED
            </Mono>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close date choices"
              style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
            >
              <X size={18} color={c.ink} strokeWidth={1.6} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 16, gap: 2 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {BOOK_REPORT_DATE_CHOICES.map((r) => (
              <OptionRow
                key={r}
                kind="radio"
                label={BOOK_REPORT_RANGE_LABELS[r]}
                selected={choice === r}
                onPress={() => choose(r)}
              />
            ))}

            {custom ? (
              <View style={{ gap: 12, marginTop: 10 }}>
                <View style={styles.tiles}>
                  {(
                    [
                      ['start', startTile],
                      ['end', endTile],
                    ] as const
                  ).map(([which, tile]) => (
                    <Pressable
                      key={which}
                      onPress={() => editTile(which)}
                      accessibilityRole="button"
                      accessibilityLabel={tile.spoken}
                      accessibilityHint="The next day you pick sets this date"
                      accessibilityState={{ selected: editing === which }}
                      style={({ pressed }) => [
                        styles.tile,
                        {
                          borderColor: editing === which ? c.ink : c.hair,
                          borderWidth: editing === which ? 1.5 : 1,
                          backgroundColor: c.paper,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <FieldLabel>{tile.title.toUpperCase()}</FieldLabel>
                      <Body
                        size={15}
                        color={tile.chosen ? c.ink : c.ink4}
                        style={{ fontFamily: FONT.display, marginTop: 4 }}
                      >
                        {tile.value}
                      </Body>
                    </Pressable>
                  ))}
                </View>

                <MonthCalendar
                  month={month}
                  onMonthChange={setMonth}
                  draft={draft}
                  today={today}
                  onPick={pick}
                />

                {zoneLine ? (
                  <Body size={12.5} muted>
                    {zoneLine}
                  </Body>
                ) : null}

                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => setTyping((v) => !v)}
                  accessibilityLabel={BOOK_REPORT_UI.typeDates}
                  accessibilityHint={typing ? undefined : 'Shows two fields to type the dates'}
                  style={{ alignSelf: 'flex-start', minHeight: SHEET_MIN_TAP }}
                >
                  {BOOK_REPORT_UI.typeDates}
                </Button>
                {typing ? (
                  <View style={{ gap: 8 }}>
                    <View style={styles.dates}>
                      <DateField
                        which="start"
                        value={from ?? ''}
                        invalid={touchedDates && problems.fromInvalid}
                        onChange={(v) => typed('start', v)}
                        onBlur={() => setTouchedDates(true)}
                      />
                      <DateField
                        which="end"
                        value={to ?? ''}
                        invalid={touchedDates && problems.toInvalid}
                        onChange={(v) => typed('end', v)}
                        onBlur={() => setTouchedDates(true)}
                      />
                    </View>
                    {/* One sentence for the range, core's (the web page's words). */}
                    {touchedDates && problems.dates ? (
                      <Body size={12.5} color={ACCENT.crit} accessibilityRole="alert">
                        {problems.dates}
                      </Body>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
          </ScrollView>

          {custom ? (
            <View style={styles.footer}>
              <Button
                variant="outline"
                onPress={onClose}
                accessibilityLabel={BOOK_REPORT_UI.cancel}
                style={{ flex: 1, minHeight: SHEET_MIN_TAP }}
              >
                {BOOK_REPORT_UI.cancel}
              </Button>
              <Button
                onPress={apply}
                disabled={!complete}
                accessibilityLabel={BOOK_REPORT_UI.apply}
                style={{ flex: 1, minHeight: SHEET_MIN_TAP }}
                leading={<Check size={18} color={c.paper} strokeWidth={1.6} />}
              >
                {BOOK_REPORT_UI.apply}
              </Button>
            </View>
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function DateField({
  which,
  value,
  invalid,
  onChange,
  onBlur,
}: {
  which: CalendarEditing;
  value: string;
  /** Outlined when the range's refusal (said once, under both dates) is about this date. */
  invalid: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const { c } = useTheme();
  const title = which === 'start' ? BOOK_REPORT_UI.startDate : BOOK_REPORT_UI.endDate;
  return (
    <View style={{ flex: 1, minWidth: 140, gap: 6 }}>
      <FieldLabel>{title.toUpperCase()}</FieldLabel>
      <TextInput
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={c.ink4}
        accessibilityLabel={`${title}, written year, month, day`}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        maxFontSizeMultiplier={capTo(15, TYPE_CEILING.input)}
        style={[
          styles.input,
          {
            color: c.ink,
            borderColor: invalid ? ACCENT.crit : c.hair,
            backgroundColor: c.paper,
            fontFamily: FONT.mono,
          },
        ]}
      />
    </View>
  );
}

const styles = {
  ...sheetStyles,
  ...StyleSheet.create({
    tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    tile: {
      flex: 1,
      minWidth: 140,
      minHeight: SHEET_MIN_TAP,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    dates: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    input: {
      minHeight: SHEET_MIN_TAP,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      fontSize: 15,
    },
  }),
};
