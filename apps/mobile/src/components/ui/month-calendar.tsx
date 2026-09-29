import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import * as React from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';

import type { CalendarMonth, CalendarRangeDraft } from '@stockpilot/core';

import { Mono } from '@/components/ui/text';
import { CALENDAR_CELL_MIN, monthCalendarView, type MonthCalendarDay } from '@/lib/month-calendar';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * A month of days to pick a range from (plan 5, D7): JS only, so it ships
 * by an over-the-air update (no native date picker, no gesture library).
 *
 *   - Core's grid: always 6 rows of 7, Sunday first, only the month's own
 *     days (the rest are empty), so the grid never changes height.
 *   - The start and end are filled, the days between tinted, the
 *     organization's today outlined.
 *   - Previous month / Next month are 44 pt buttons; there is no swipe (a
 *     gesture would fight VoiceOver's own swipes).
 *   - Every day is its own button, named 'Tuesday, September 1, 2026', with
 *     its selected state and 'Start date' / 'End date' / 'In the chosen
 *     range' / 'Today' as a hint. The weekday letters are hidden from
 *     VoiceOver (each day says its weekday already).
 *   - Paging months says the month now shown (VoiceOver stays on the
 *     button, and the header does not announce itself).
 *   - Day numbers stop growing at the control ceiling, so seven columns
 *     still fit at the largest text sizes.
 *
 * Picking only changes the caller's draft: nothing is requested until the
 * caller's Apply.
 */
export function MonthCalendar({
  month,
  onMonthChange,
  draft,
  today,
  onPick,
}: {
  month: CalendarMonth;
  onMonthChange: (month: CalendarMonth) => void;
  draft: CalendarRangeDraft;
  /** The organization's today (from an answer), or null: no day is marked. */
  today: string | null;
  onPick: (ymd: string) => void;
}) {
  const { c } = useTheme();
  const view = monthCalendarView(month, draft, today);
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.head}>
        <Pressable
          onPress={() => {
            onMonthChange(view.previous.month);
            AccessibilityInfo.announceForAccessibility(view.previous.announce);
          }}
          disabled={!view.previous.enabled}
          accessibilityRole="button"
          accessibilityLabel={view.previous.label}
          accessibilityState={{ disabled: !view.previous.enabled }}
          style={({ pressed }) => [
            styles.nav,
            { opacity: !view.previous.enabled ? 0.3 : pressed ? 0.6 : 1 },
          ]}
        >
          <ChevronLeft size={20} color={c.ink} strokeWidth={1.6} />
        </Pressable>
        <Mono
          size={14}
          tracking={0.02}
          color={c.ink}
          maxFontSizeMultiplier={capTo(14, TYPE_CEILING.control)}
          accessibilityRole="header"
          style={{ flex: 1, textAlign: 'center', fontFamily: FONT.display }}
        >
          {view.title}
        </Mono>
        <Pressable
          onPress={() => {
            onMonthChange(view.next.month);
            AccessibilityInfo.announceForAccessibility(view.next.announce);
          }}
          disabled={!view.next.enabled}
          accessibilityRole="button"
          accessibilityLabel={view.next.label}
          accessibilityState={{ disabled: !view.next.enabled }}
          style={({ pressed }) => [
            styles.nav,
            { opacity: !view.next.enabled ? 0.3 : pressed ? 0.6 : 1 },
          ]}
        >
          <ChevronRight size={20} color={c.ink} strokeWidth={1.6} />
        </Pressable>
      </View>

      <View
        style={styles.row}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {view.weekdays.map((d) => (
          <View key={d.long} style={styles.weekday}>
            <Mono
              size={11.5}
              color={c.ink4}
              maxFontSizeMultiplier={capTo(11.5, TYPE_CEILING.chrome)}
            >
              {d.short}
            </Mono>
          </View>
        ))}
      </View>

      {view.weeks.map((week, w) => (
        <View key={w} style={styles.row}>
          {week.map((day, i) =>
            day ? (
              <DayCell key={day.ymd} day={day} onPick={onPick} />
            ) : (
              <View key={`empty-${w}-${i}`} style={styles.cell} />
            ),
          )}
        </View>
      ))}
    </View>
  );
}

function DayCell({ day, onPick }: { day: MonthCalendarDay; onPick: (ymd: string) => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => onPick(day.ymd)}
      accessibilityRole="button"
      accessibilityLabel={day.label}
      accessibilityHint={day.hint ?? undefined}
      accessibilityState={{ selected: day.selected }}
      style={({ pressed }) => [
        styles.cell,
        { backgroundColor: day.inRange ? c.paper2 : 'transparent', opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View
        style={[
          styles.dot,
          {
            backgroundColor: day.selected ? c.ink : 'transparent',
            borderColor: day.isToday && !day.selected ? c.ink3 : 'transparent',
          },
        ]}
      >
        <Mono
          size={15}
          color={day.selected ? c.paper : c.ink}
          maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}
          style={{ fontFamily: day.selected ? FONT.display : FONT.monoRegular }}
        >
          {day.text}
        </Mono>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  nav: {
    minWidth: CALENDAR_CELL_MIN,
    minHeight: CALENDAR_CELL_MIN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row' },
  weekday: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 4 },
  cell: {
    flex: 1,
    minHeight: CALENDAR_CELL_MIN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    minWidth: 38,
    minHeight: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
});
