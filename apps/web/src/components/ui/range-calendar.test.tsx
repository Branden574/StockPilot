import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  EMPTY_CALENDAR_RANGE,
  rangePick,
  type CalendarMonth,
  type CalendarRangeDraft,
} from '@stockpilot/core';

import { RangeCalendar } from './range-calendar';

// The range calendar renders core's zone-free model with the WAI-ARIA date
// picker grid semantics: a labelled grid per month, one roving tab stop, the
// arrow / Page / Home / End keys, aria-selected on the two ends and
// aria-current on the organization's today. It requests nothing itself.

function Harness({
  initial = { ...EMPTY_CALENDAR_RANGE },
  month = { y: 2026, m: 9 },
  count = 1,
  today = '2026-09-29',
  onPick,
}: {
  initial?: CalendarRangeDraft;
  month?: CalendarMonth;
  count?: number;
  today?: string | null;
  onPick?: (ymd: string) => void;
}) {
  const [draft, setDraft] = React.useState(initial);
  const [shown, setShown] = React.useState(month);
  return (
    <RangeCalendar
      month={shown}
      onMonthChange={setShown}
      count={count}
      draft={draft}
      today={today}
      onPick={(ymd) => {
        onPick?.(ymd);
        setDraft((d) => rangePick(d, ymd));
      }}
    />
  );
}

const day = (name: string) => screen.getByRole('button', { name });

describe('RangeCalendar', () => {
  it('is a grid per month, labelled by its title, with Sunday-first weekday headers and 42 cells', () => {
    render(<Harness count={2} />);
    const grids = screen.getAllByRole('grid');
    expect(grids).toHaveLength(2);
    expect(grids[0]).toHaveAccessibleName('September 2026');
    expect(grids[1]).toHaveAccessibleName('October 2026');
    const heads = within(grids[0]!)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual([
      'SSunday',
      'MMonday',
      'TTuesday',
      'WWednesday',
      'TThursday',
      'FFriday',
      'SSaturday',
    ]);
    expect(within(grids[0]!).getAllByRole('gridcell')).toHaveLength(42);
    // September 1, 2026 is a Tuesday: two empty cells before it.
    const first = within(grids[0]!).getAllByRole('gridcell');
    expect(first[0]!.textContent).toBe('');
    expect(first[1]!.textContent).toBe('');
    expect(first[2]!.textContent).toBe('1');
  });

  it('a daylight-saving day is an ordinary cell (November 1, 2026 in the US)', () => {
    render(<Harness month={{ y: 2026, m: 11 }} />);
    expect(day('Sunday, November 1, 2026')).toBeInTheDocument();
    expect(day('Monday, November 2, 2026')).toBeInTheDocument();
  });

  it("keeps exactly one day in the tab order, and marks the organization's today", () => {
    render(<Harness />);
    const grid = screen.getByRole('grid');
    const tabbable = within(grid)
      .getAllByRole('button')
      .filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName('Tuesday, September 29, 2026');
    expect(tabbable[0]).toHaveAttribute('aria-current', 'date');
  });

  it('marks the start and the end aria-selected, and the days between as the band', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(day('Thursday, September 10, 2026'));
    await userEvent.click(day('Tuesday, September 15, 2026'));
    expect(onPick.mock.calls.map(([d]) => d)).toEqual(['2026-09-10', '2026-09-15']);
    const selected = screen
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-selected') === 'true')
      .map((c) => c.textContent);
    expect(selected).toEqual(['10', '15']);
    expect(day('Saturday, September 12, 2026')).toHaveAttribute('data-state', 'band');
    expect(day('Wednesday, September 16, 2026')).not.toHaveAttribute('data-state');
  });

  it('a day inside the chosen range says so to a screen reader (the tint is not enough); the ends and the rest do not', async () => {
    render(<Harness />);
    await userEvent.click(day('Thursday, September 10, 2026'));
    // Before the end is chosen, nothing is in a range yet (a hover preview is not a range).
    fireEvent.pointerEnter(day('Monday, September 14, 2026'), { pointerType: 'mouse' });
    expect(day('Saturday, September 12, 2026')).not.toHaveAccessibleDescription();
    await userEvent.click(day('Tuesday, September 15, 2026'));
    expect(day('Saturday, September 12, 2026')).toHaveAccessibleDescription('In the chosen range');
    expect(day('Thursday, September 10, 2026')).not.toHaveAccessibleDescription();
    expect(day('Tuesday, September 15, 2026')).not.toHaveAccessibleDescription();
    expect(day('Wednesday, September 16, 2026')).not.toHaveAccessibleDescription();
  });

  it('previews the band under the mouse while the end is picked', async () => {
    render(<Harness />);
    await userEvent.click(day('Thursday, September 10, 2026'));
    fireEvent.pointerEnter(day('Monday, September 14, 2026'), { pointerType: 'mouse' });
    expect(day('Saturday, September 12, 2026')).toHaveAttribute('data-state', 'band');
    expect(day('Tuesday, September 15, 2026')).not.toHaveAttribute('data-state');
  });

  it('arrow keys move one day or one week, Home and End the week, PageDown a month, Shift+PageDown a year', async () => {
    render(<Harness today="2026-09-15" />);
    day('Tuesday, September 15, 2026').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(day('Wednesday, September 16, 2026')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(day('Wednesday, September 23, 2026')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowLeft}');
    expect(day('Tuesday, September 15, 2026')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(day('Sunday, September 13, 2026')).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(day('Saturday, September 19, 2026')).toHaveFocus();
    await userEvent.keyboard('{PageDown}');
    expect(screen.getByRole('grid')).toHaveAccessibleName('October 2026');
    expect(day('Monday, October 19, 2026')).toHaveFocus();
    await userEvent.keyboard('{Shift>}{PageDown}{/Shift}');
    expect(screen.getByRole('grid')).toHaveAccessibleName('October 2027');
    expect(day('Tuesday, October 19, 2027')).toHaveFocus();
    await userEvent.keyboard('{PageUp}');
    expect(day('Sunday, September 19, 2027')).toHaveFocus();
    // Only the tab stop moved: nothing was picked.
    expect(
      screen.getAllByRole('gridcell').some((c) => c.getAttribute('aria-selected') === 'true'),
    ).toBe(false);
  });

  it('an arrow off the last day shown moves the months with it', async () => {
    render(<Harness today="2026-09-30" />);
    day('Wednesday, September 30, 2026').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('grid')).toHaveAccessibleName('October 2026');
    expect(day('Thursday, October 1, 2026')).toHaveFocus();
  });

  it('Enter picks the focused day', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} today="2026-09-15" />);
    day('Tuesday, September 15, 2026').focus();
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(onPick).toHaveBeenCalledWith('2026-09-16');
  });

  it('Previous and Next month page the calendar and stop at the SQL bounds', async () => {
    render(<Harness month={{ y: 2000, m: 1 }} today={null} />);
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('grid')).toHaveAccessibleName('February 2000');
    // No today mark without an answer.
    expect(document.querySelector('[aria-current="date"]')).toBeNull();
  });

  it('two months side by side: Next month moves both', async () => {
    render(<Harness count={2} month={{ y: 2100, m: 11 }} />);
    // Held inside the bounds: the last pair is November and December 2100.
    const names = screen.getAllByRole('grid').map((g) => g.getAttribute('aria-labelledby'));
    expect(names).toHaveLength(2);
    expect(screen.getAllByRole('grid')[1]).toHaveAccessibleName('December 2100');
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('every day and month button is at least 36 px', () => {
    render(<Harness />);
    for (const b of screen.getAllByRole('button')) expect(b).toHaveClass('h-9', 'w-9');
  });
});
